// youtube-search.js
//
// YouTube video search: returns top N results for a query with title,
// channel, view count, duration, and video URL.
//
// Seam: agents using youtube-intel need to discover relevant videos first.
// This closes the search→intel loop without a paid API key.
// Upstream: yt-dlp (local binary, free) using ytsearch prefix.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const YTDLP = "/home/aegis/.local/bin/yt-dlp";
const MAX_RESULTS_CAP = 10;

function parseResult(d) {
  const thumbs = Array.isArray(d.thumbnails) ? d.thumbnails : [];
  const thumb = thumbs.length > 0 ? thumbs[thumbs.length - 1]?.url ?? null : null;
  return {
    video_id:        d.id ?? null,
    title:           d.title ?? null,
    channel:         d.uploader ?? d.channel ?? null,
    channel_id:      d.channel_id ?? d.uploader_id ?? null,
    channel_url:     d.channel_url ?? d.uploader_url ?? null,
    description:     typeof d.description === "string"
                       ? d.description.slice(0, 300) || null
                       : null,
    view_count:      d.view_count ?? null,
    duration_seconds: d.duration ?? null,
    duration_string:  d.duration_string ?? null,
    live_status:     d.live_status ?? null,
    thumbnail:       thumb,
    url:             d.webpage_url ?? (d.id ? `https://www.youtube.com/watch?v=${d.id}` : null),
  };
}

async function search(query, maxResults) {
  const n = Math.min(Math.max(1, parseInt(maxResults) || 5), MAX_RESULTS_CAP);
  const { stdout } = await execFileAsync(
    YTDLP,
    [
      "--dump-json", "--flat-playlist", "--no-download", "--no-warnings", "-q",
      `ytsearch${n}:${query}`,
    ],
    { timeout: 30000, encoding: "utf8" }
  );

  const results = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      results.push(parseResult(JSON.parse(t)));
    } catch { /* skip malformed lines */ }
  }
  return results;
}

export default {
  name:  "youtube-search",
  price: "$0.021",

  description:
    "Search YouTube for videos matching a query. Returns up to 10 results with title, channel, view count, duration, and video URL. No API key required. Pair with youtube-intel for full metadata on selected videos.",

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string (e.g. 'bitcoin price 2024', 'machine learning tutorial').",
      },
      max_results: {
        type: "integer",
        description: "Number of results to return (1–10, default 5).",
        minimum: 1,
        maximum: 10,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      query:   { type: "string", description: "Search query as submitted." },
      count:   { type: "integer", description: "Number of results returned." },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            video_id:         { type: ["string", "null"],  description: "11-character YouTube video ID." },
            title:            { type: ["string", "null"],  description: "Video title." },
            channel:          { type: ["string", "null"],  description: "Channel display name." },
            channel_id:       { type: ["string", "null"],  description: "YouTube channel ID." },
            channel_url:      { type: ["string", "null"],  description: "Channel URL." },
            description:      { type: ["string", "null"],  description: "Video description (max 300 chars)." },
            view_count:       { type: ["integer", "null"], description: "Total view count." },
            duration_seconds: { type: ["integer", "null"], description: "Duration in seconds." },
            duration_string:  { type: ["string", "null"],  description: "Duration formatted as M:SS or H:MM:SS." },
            live_status:      { type: ["string", "null"],  description: "Live status (e.g. not_live, is_live, was_live)." },
            thumbnail:        { type: ["string", "null"],  description: "Best available thumbnail URL." },
            url:              { type: ["string", "null"],  description: "Canonical YouTube watch URL." },
          },
        },
      },
      ts: { type: "string", description: "ISO-8601 response timestamp." },
    },
  },

  async handler(query) {
    const q = (query.query || "").trim();
    if (!q) throw new Error("query is required");
    const maxResults = query.max_results ?? 5;
    const results = await search(q, maxResults);
    return {
      query:   q,
      count:   results.length,
      results,
      ts:      new Date().toISOString(),
    };
  },
};
