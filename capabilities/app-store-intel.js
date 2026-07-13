// app-store-intel.js
//
// iOS App Store competitive intelligence via the free iTunes Search API.
//
// Actions:
//   search      — find apps by keyword; returns top matches with ratings,
//                 price, developer, category, and estimated install tier.
//   lookup      — detailed profile for a specific app by name or Apple App ID;
//                 includes rating breakdown, version history, and description.
//   top_charts  — top free or paid apps in a category (finance, productivity,
//                 developer-tools, games, health, etc.). Returns top 25 by default.
//
// Use cases:
//   - Research the competitive landscape before launching an app
//   - VC/investor evaluation of App Store market dynamics in a vertical
//   - Developers benchmarking their ratings vs. category leaders
//   - Agents evaluating whether a software product has an iOS presence
//   - Checking App Store category rankings before keyword strategy work
//
// Seam: fills the App Store gap in the developer-ecosystem cluster. Existing
//       caps cover npm (npm-trends, npm-lookup), Python (pypi-intel), GitHub
//       (github-intel), and HuggingFace (huggingface-intel) — but iOS apps had
//       no equivalent. iTunes Search API is free, public, and rate-limit-friendly.
//
// Upstream: itunes.apple.com/search, /lookup, and RSS top-charts feeds — all free, no auth.
// Price: $0.010/call

const SEARCH_URL = "https://itunes.apple.com/search";
const LOOKUP_URL = "https://itunes.apple.com/lookup";
const RSS_BASE   = "https://itunes.apple.com/us/rss";
const UA         = "Mozilla/5.0 (compatible; the-stall/4.76; +https://intuitek.ai)";
const TMO        = 12_000;

// Genre/category IDs for top-charts RSS feeds
const GENRE_MAP = {
  "all":              "0",
  "books":            "6018",
  "business":        "6000",
  "developer-tools": "6026",
  "education":       "6017",
  "entertainment":   "6016",
  "finance":         "6015",
  "food-drink":      "6023",
  "games":           "6014",
  "graphics-design": "6027",
  "health-fitness":  "6013",
  "lifestyle":       "6012",
  "medical":         "6020",
  "music":           "6011",
  "navigation":      "6010",
  "news":            "6009",
  "photo-video":     "6008",
  "productivity":    "6007",
  "reference":       "6006",
  "shopping":        "6024",
  "social":          "6005",
  "sports":          "6004",
  "travel":          "6003",
  "utilities":       "6002",
  "weather":         "6001",
};

// Install tier heuristic from rating count
function installTier(count) {
  if (!count || count === 0) return "new";
  if (count < 100)   return "<1K installs";
  if (count < 1_000) return "~10K installs";
  if (count < 5_000) return "~100K installs";
  if (count < 20_000) return "~500K installs";
  if (count < 100_000) return "~1M+ installs";
  return "~10M+ installs";
}

function summarizeApp(item) {
  return {
    apple_id:         item.trackId,
    name:             item.trackName,
    developer:        item.artistName,
    seller:           item.sellerName ?? item.artistName,
    category:         item.primaryGenreName,
    genres:           item.genres?.slice(0, 3) ?? [],
    price_usd:        item.price ?? 0,
    price_label:      item.formattedPrice ?? "Free",
    rating:           item.averageUserRating ? Math.round(item.averageUserRating * 10) / 10 : null,
    rating_count:     item.userRatingCount ?? 0,
    install_tier:     installTier(item.userRatingCount),
    current_version:  item.version,
    last_updated:     item.currentVersionReleaseDate
      ? item.currentVersionReleaseDate.slice(0, 10)
      : item.releaseDate?.slice(0, 10) ?? null,
    first_released:   item.releaseDate?.slice(0, 10) ?? null,
    min_ios:          item.minimumOsVersion ?? null,
    size_mb:          item.fileSizeBytes
      ? Math.round(item.fileSizeBytes / (1024 * 1024) * 10) / 10
      : null,
    app_store_url:    item.trackViewUrl,
  };
}

async function itunesGet(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(TMO),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`iTunes API HTTP ${resp.status}: ${body.slice(0, 120)}`);
  }
  return resp.json();
}

async function handleSearch({ query, limit = 10, country = "us" }) {
  if (!query) throw new Error("search requires a 'query' parameter");
  const n = Math.min(Math.max(1, parseInt(limit) || 10), 25);
  const url = `${SEARCH_URL}?term=${encodeURIComponent(query)}&entity=software&limit=${n * 2}&country=${country}`;
  const data = await itunesGet(url);
  const apps = (data.results ?? []).filter(r => r.kind === "software").slice(0, n);
  if (apps.length === 0) return { action: "search", query, country, results: [], result_count: 0 };

  const results = apps.map(summarizeApp);

  // Market snapshot: rating distribution, free vs paid
  const rated = results.filter(a => a.rating !== null);
  const avg_rating = rated.length
    ? Math.round(rated.reduce((s, a) => s + a.rating, 0) / rated.length * 10) / 10
    : null;
  const free_count = results.filter(a => a.price_usd === 0).length;
  const categories = [...new Set(results.map(a => a.category))];

  return {
    action:       "search",
    query,
    country,
    result_count: results.length,
    market_snapshot: {
      avg_rating,
      free_pct:   Math.round((free_count / results.length) * 100),
      categories,
    },
    results,
  };
}

async function handleLookup({ app, app_id, country = "us" }) {
  let item;
  if (app_id) {
    // Direct ID lookup
    const url = `${LOOKUP_URL}?id=${encodeURIComponent(app_id)}&country=${country}`;
    const data = await itunesGet(url);
    item = data.results?.[0];
  } else if (app) {
    // Search for closest name match
    const url = `${SEARCH_URL}?term=${encodeURIComponent(app)}&entity=software&limit=5&country=${country}`;
    const data = await itunesGet(url);
    const results = (data.results ?? []).filter(r => r.kind === "software");
    // Pick the one whose name most closely matches
    const lower = app.toLowerCase();
    item = results.find(r => r.trackName?.toLowerCase() === lower) ?? results[0];
  } else {
    throw new Error("lookup requires 'app' (name) or 'app_id' (Apple ID)");
  }

  if (!item) return { action: "lookup", found: false, app: app ?? app_id };

  const summary = summarizeApp(item);
  const description_excerpt = item.description
    ? item.description.replace(/\n+/g, " ").trim().slice(0, 400)
    : null;
  const release_notes_excerpt = item.releaseNotes
    ? item.releaseNotes.replace(/\n+/g, " ").trim().slice(0, 300)
    : null;

  // Rating health signal
  let rating_health = "unknown";
  if (summary.rating !== null) {
    if      (summary.rating >= 4.7) rating_health = "excellent";
    else if (summary.rating >= 4.3) rating_health = "strong";
    else if (summary.rating >= 3.5) rating_health = "average";
    else if (summary.rating >= 2.5) rating_health = "poor";
    else                            rating_health = "critical";
  }

  // Freshness signal
  let freshness = "unknown";
  if (summary.last_updated) {
    const daysSince = Math.floor((Date.parse("2026-06-25") - Date.parse(summary.last_updated)) / 86_400_000);
    if      (daysSince <= 30)  freshness = "recently_updated";
    else if (daysSince <= 180) freshness = "active";
    else if (daysSince <= 365) freshness = "stable";
    else                       freshness = "stale";
  }

  // Screenshots (first 3)
  const screenshots = (item.screenshotUrls ?? []).slice(0, 3);
  const ipad_screenshots = (item.ipadScreenshotUrls ?? []).slice(0, 2);

  return {
    action:       "lookup",
    found:        true,
    ...summary,
    rating_health,
    freshness,
    description_excerpt,
    release_notes_excerpt,
    supported_devices: item.supportedDevices?.slice(0, 5) ?? [],
    screenshots,
    ipad_screenshots,
    languages:    item.languageCodesISO2A?.slice(0, 10) ?? [],
    advisor_url:  item.trackViewUrl,
  };
}

async function handleTopCharts({ category = "all", chart = "free", limit = 25 }) {
  const genreId = GENRE_MAP[category.toLowerCase()] ?? GENRE_MAP["all"];
  const n = Math.min(Math.max(1, parseInt(limit) || 25), 100);
  const chartType = chart === "paid" ? "toppaidapplications" : "topfreeapplications";
  const url = `${RSS_BASE}/${chartType}/limit=${n}/genre=${genreId}/json`;

  const data = await itunesGet(url);
  const entries = data?.feed?.entry ?? [];
  if (entries.length === 0) return { action: "top_charts", category, chart, result_count: 0, apps: [] };

  const apps = entries.map((e, i) => ({
    rank:       i + 1,
    apple_id:   e["id"]?.["attributes"]?.["im:id"],
    name:       e["im:name"]?.["label"],
    developer:  e["im:artist"]?.["label"],
    category:   e["category"]?.["attributes"]?.["label"],
    price_label: e["im:price"]?.["label"],
    price_usd:  parseFloat(e["im:price"]?.["attributes"]?.["amount"] ?? "0") || 0,
    summary:    e["summary"]?.["label"]?.slice(0, 120) ?? null,
    release_date: e["im:releaseDate"]?.["label"]?.slice(0, 10) ?? null,
    app_store_url: e["id"]?.["label"],
  }));

  const feed_meta = {
    title:    data?.feed?.title?.label,
    updated:  data?.feed?.updated?.label?.slice(0, 10) ?? null,
    category: data?.feed?.category?.attributes?.label ?? category,
  };

  return {
    action:       "top_charts",
    category,
    chart,
    result_count: apps.length,
    feed_meta,
    apps,
  };
}

export default {
  name:  "app-store-intel",
  price: "$0.021",

  description:
    "iOS App Store competitive intelligence: search apps by keyword, look up a specific app's profile (ratings, freshness, install tier, release notes), or fetch top-charts for a category (finance, productivity, games, etc.). Free iTunes API, no auth required. Covers the App Store gap in the developer-ecosystem cluster alongside npm-trends, pypi-intel, and github-intel.",

  inputSchema: {
    type: "object",
    required: [],
    properties: {
      action: {
        type:        "string",
        enum:        ["search", "lookup", "top_charts"],
        description: "Action to perform. Default: search.",
      },
      query: {
        type:        "string",
        description: "(search) Keyword or app topic to search for, e.g. 'budget tracker', 'AI assistant'.",
      },
      app: {
        type:        "string",
        description: "(lookup) App name to look up, e.g. 'Notion', 'Robinhood'.",
      },
      app_id: {
        type:        ["string","number"],
        description: "(lookup) Apple App ID (numeric), e.g. 1234567890.",
      },
      category: {
        type:        "string",
        description: "(top_charts) App Store category. Options: all, finance, productivity, business, developer-tools, games, health-fitness, education, social, utilities, news, music, travel, shopping, lifestyle, weather, photo-video, entertainment, sports, medical, food-drink, reference, navigation, graphics-design. Default: all.",
      },
      chart: {
        type:        "string",
        enum:        ["free","paid"],
        description: "(top_charts) Chart type: 'free' or 'paid'. Default: free.",
      },
      limit: {
        type:        "integer",
        minimum:     1,
        maximum:     100,
        description: "Max results to return. Default: 10 for search, 25 for top_charts.",
      },
      country: {
        type:        "string",
        description: "(search/lookup) ISO 2-letter country code for App Store region. Default: us.",
      },
    },
  },

  outputSchema: {
    type: "object",
    properties: {
      action:       { type: "string" },
      query:        { type: "string" },
      result_count: { type: "number" },
      market_snapshot: {
        type: "object",
        properties: {
          avg_rating:  { type: ["number","null"] },
          free_pct:    { type: "number", description: "% of results that are free." },
          categories:  { type: "array" },
        },
      },
      results: {
        type:  "array",
        description: "Apps from a search.",
        items: {
          type: "object",
          properties: {
            apple_id:       { type: "number" },
            name:           { type: "string" },
            developer:      { type: "string" },
            category:       { type: "string" },
            price_usd:      { type: "number" },
            price_label:    { type: "string" },
            rating:         { type: ["number","null"], description: "Average user rating (1.0–5.0)." },
            rating_count:   { type: "number" },
            install_tier:   { type: "string", description: "Estimated install tier from rating count." },
            current_version: { type: "string" },
            last_updated:   { type: "string" },
            app_store_url:  { type: "string" },
          },
        },
      },
      rating_health: {
        type:        "string",
        enum:        ["excellent","strong","average","poor","critical","unknown"],
        description: "Rating quality signal for lookup action.",
      },
      freshness: {
        type:        "string",
        enum:        ["recently_updated","active","stable","stale","unknown"],
        description: "Update recency for lookup action.",
      },
      description_excerpt: { type: ["string","null"] },
      release_notes_excerpt: { type: ["string","null"] },
      apps: {
        type:  "array",
        description: "Apps from top_charts.",
        items: {
          type: "object",
          properties: {
            rank:         { type: "number" },
            apple_id:     { type: ["string","null"] },
            name:         { type: "string" },
            developer:    { type: "string" },
            category:     { type: "string" },
            price_usd:    { type: "number" },
            price_label:  { type: "string" },
            app_store_url: { type: "string" },
          },
        },
      },
    },
  },

  async handler({ action = "search", query, app, app_id, category, chart, limit, country }) {
    switch (action) {
      case "search":     return handleSearch({ query, limit, country });
      case "lookup":     return handleLookup({ app, app_id, country });
      case "top_charts": return handleTopCharts({ category, chart, limit });
      default:
        throw new Error(`Unknown action: "${action}". Valid: search, lookup, top_charts`);
    }
  },
};
