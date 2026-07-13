// tvmaze-intel.js
//
// TV show intelligence via TVMaze — 90,000+ shows from every network and streaming
// platform worldwide.
//
// Four modes:
//   1. search(query)
//      — Show search by name. Returns top matches with name, network, genres,
//        rating (out of 10), premiered date, status (Running/Ended), and
//        summary. Agent use: "find shows like Breaking Bad", "what network
//        airs Game of Thrones".
//
//   2. show(id_or_name)
//      — Full show profile: plot summary, schedule (day + time + timezone),
//        cast (top 8 characters/actors), runtime, language, genres, rating,
//        episode count, seasons. Agent use: deep-dive on a specific series.
//
//   3. episodes(id_or_name, season)
//      — Episode list for a show, optionally filtered to one season.
//        Returns: episode name, season, number, airdate, runtime, summary.
//        Agent use: "list all season 3 episodes of Succession".
//
//   4. schedule(country, date)
//      — TV air schedule for a country on a given date (ISO 8601).
//        Defaults to US and today. Returns show name, network, airtime,
//        episode title, season/ep. Agent use: "what's on NBC tonight".
//
// Source: TVMaze public API (api.tvmaze.com) — free, no API key required.
// Covers broadcast, cable, and streaming across 100+ countries.
//
// Seam: content research agents analyzing viewership trends, entertainment
//       journalists cross-referencing cast/credits, recommendation engines
//       verifying show metadata, TV trivia and scheduling bots. Free-tier
//       API with no rate-limit issues for agent query volumes.
//
// Price: $0.008/call — one to two TVMaze API calls per request.

const BASE    = "https://api.tvmaze.com";
const UA      = "the-stall/4.69 tvmaze-intel (kyle@intuitek.ai)";
const TIMEOUT = 12_000;

async function tvmaze(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TVMaze HTTP ${res.status} — ${path}`);
  return res.json();
}

function stripHtml(s) {
  if (!s) return null;
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function fmtShow(s) {
  const net = s.network?.name ?? s.webChannel?.name ?? null;
  const country = s.network?.country?.name ?? s.webChannel?.country?.name ?? null;
  return {
    id:         s.id,
    name:       s.name,
    status:     s.status,
    type:       s.type,
    genres:     s.genres ?? [],
    language:   s.language,
    premiered:  s.premiered,
    ended:      s.ended ?? null,
    rating:     s.rating?.average ?? null,
    runtime:    s.runtime,
    network:    net,
    country:    country,
    official_site: s.officialSite ?? null,
    image:      s.image?.medium ?? null,
    summary:    stripHtml(s.summary),
  };
}

// Resolve id_or_name → show ID. Accepts numeric IDs or names.
async function resolveShow(idOrName) {
  if (/^\d+$/.test(String(idOrName))) {
    return { show: await tvmaze(`/shows/${idOrName}`) };
  }
  // single-search (exact match first)
  const exact = await tvmaze("/singlesearch/shows", { q: idOrName });
  if (exact) return { show: exact };
  // fallback to first search result
  const results = await tvmaze("/search/shows", { q: idOrName });
  if (results?.length) return { show: results[0].show };
  return { show: null };
}

export default {
  name: "tvmaze-intel",
  price: "$0.010",
  description:
    "TV show intelligence via TVMaze: search 90k+ shows by name, get full show " +
    "profiles with cast/schedule/rating, list episode guides by season, or fetch " +
    "the broadcast schedule for any country by date. No API key required.",

  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["search", "show", "episodes", "schedule"],
        description:
          "search=find shows by name | show=full profile for one show | " +
          "episodes=episode list (optionally filtered by season) | " +
          "schedule=TV air schedule for a country on a date",
      },
      query: {
        type: "string",
        description:
          "search/show/episodes: show name or numeric TVMaze show ID. " +
          "schedule: omit or leave empty.",
      },
      season: {
        type: "integer",
        description: "episodes mode: filter to this season number (omit for all seasons).",
      },
      country: {
        type: "string",
        description: "schedule mode: ISO 3166-1 alpha-2 country code (default: US).",
      },
      date: {
        type: "string",
        description:
          "schedule mode: date in YYYY-MM-DD format (default: today in UTC).",
      },
      limit: {
        type: "integer",
        description: "search mode: max results to return (default 8, max 20).",
      },
    },
    required: ["mode"],
  },

  outputSchema: {
    type: "object",
    properties: {
      mode:    { type: "string" },
      results: { type: "array" },
      show:    { type: "object" },
      count:   { type: "integer" },
    },
  },

  async handler(query) {
    const mode  = (query.mode ?? "search").toLowerCase();
    const limit = Math.min(parseInt(query.limit ?? "8", 10) || 8, 20);

    // ── MODE: search ──────────────────────────────────────────────────────────
    if (mode === "search") {
      if (!query.query) throw new Error("query is required for search mode");
      const raw = await tvmaze("/search/shows", { q: query.query });
      if (!raw?.length) return { mode, count: 0, results: [] };
      const results = raw.slice(0, limit).map(({ score, show: s }) => ({
        ...fmtShow(s),
        relevance_score: Math.round((score ?? 0) * 1000) / 1000,
      }));
      return { mode, count: results.length, results };
    }

    // ── MODE: show ────────────────────────────────────────────────────────────
    if (mode === "show") {
      if (!query.query) throw new Error("query (show name or ID) is required for show mode");
      const { show } = await resolveShow(query.query);
      if (!show) return { mode, show: null, error: `No show found for "${query.query}"` };

      // embed cast in one call
      const full = await tvmaze(`/shows/${show.id}`, { embed: "cast" });
      if (!full) return { mode, show: null, error: "Show not found" };

      const cast = (full._embedded?.cast ?? []).slice(0, 8).map((c) => ({
        actor:     c.person.name,
        character: c.character.name,
        self:      c.self,
        voice:     c.voice,
      }));

      const sched = full.schedule ?? {};
      const seasons = await tvmaze(`/shows/${full.id}/seasons`);

      return {
        mode,
        show: {
          ...fmtShow(full),
          schedule: {
            days:     sched.days ?? [],
            time:     sched.time ?? null,
            timezone: full.network?.country?.timezone ?? full.webChannel?.country?.timezone ?? null,
          },
          season_count: seasons?.length ?? null,
          cast,
        },
      };
    }

    // ── MODE: episodes ────────────────────────────────────────────────────────
    if (mode === "episodes") {
      if (!query.query) throw new Error("query (show name or ID) is required for episodes mode");
      const { show } = await resolveShow(query.query);
      if (!show) return { mode, episodes: [], error: `No show found for "${query.query}"` };

      const eps = await tvmaze(`/shows/${show.id}/episodes`);
      if (!eps?.length) return { mode, show_name: show.name, count: 0, episodes: [] };

      const filterSeason = query.season ? parseInt(query.season, 10) : null;
      const filtered = filterSeason ? eps.filter((e) => e.season === filterSeason) : eps;

      return {
        mode,
        show_id:   show.id,
        show_name: show.name,
        season_filter: filterSeason,
        count: filtered.length,
        episodes: filtered.map((e) => ({
          season:  e.season,
          number:  e.number,
          name:    e.name,
          airdate: e.airdate,
          airtime: e.airtime,
          runtime: e.runtime,
          rating:  e.rating?.average ?? null,
          summary: stripHtml(e.summary),
        })),
      };
    }

    // ── MODE: schedule ────────────────────────────────────────────────────────
    if (mode === "schedule") {
      const country = (query.country ?? "US").toUpperCase();
      const date    = query.date ?? new Date().toISOString().slice(0, 10);
      const raw     = await tvmaze("/schedule", { country, date });
      if (!raw?.length) return { mode, country, date, count: 0, schedule: [] };

      const schedule = raw.slice(0, 50).map((entry) => {
        const s = entry.show ?? {};
        const net = s.network?.name ?? s.webChannel?.name ?? null;
        return {
          airtime:   entry.airtime,
          show_name: s.name ?? null,
          show_id:   s.id ?? null,
          network:   net,
          genres:    s.genres ?? [],
          episode_name:   entry.name,
          season:    entry.season,
          episode:   entry.number,
          runtime:   entry.runtime,
          rating:    s.rating?.average ?? null,
        };
      });

      return { mode, country, date, count: schedule.length, schedule };
    }

    throw new Error(`Unknown mode "${mode}". Valid: search | show | episodes | schedule`);
  },
};
