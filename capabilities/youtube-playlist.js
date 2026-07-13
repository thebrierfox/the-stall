// youtube-playlist.js
//
// YouTube playlist inspector: returns up to 50 videos from a playlist
// with title, channel, duration, and view count. No API key required.
//
// Seam: agents running youtube-intel on a curated list need playlist
// contents before they can batch-analyze each video. This closes the
// playlist-discovery loop without a paid API key.
// Upstream: yt-dlp (local binary, free) using --flat-playlist.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const YTDLP = "/home/aegis/.local/bin/yt-dlp";
const MAX_VIDEOS = 50;

function toPlaylistUrl(input) {
  const s = (input || "").trim();
  if (!s) throw new Error("playlist_id or playlist_url is required");
  // already a full URL
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  // bare playlist ID (starts with PL, UU, LL, RD, etc.)
  return `https://www.youtube.com/playlist?list=${s}`;
}

function parseEntry(d) {
  const thumbs = Array.isArray(d.thumbnails) ? d.thumbnails : [];
  const thumb = thumbs.length > 0 ? thumbs[thumbs.length - 1]?.url ?? null : null;
  return {
    video_id:         d.id ?? null,
    title:            d.title ?? null,
    channel:          d.uploader ?? d.channel ?? null,
    channel_id:       d.channel_id ?? d.uploader_id ?? null,
    duration_seconds: d.duration ?? null,
    duration_string:  d.duration_string ?? null,
    view_count:       d.view_count ?? null,
    thumbnail:        thumb,
    url:              d.webpage_url ?? (d.id ? `https://www.youtube.com/watch?v=${d.id}` : null),
  };
}

async function fetchPlaylist(url, limit) {
  const { stdout } = await execFileAsync(
    YTDLP,
    [
      "--flat-playlist", "--dump-json", "--no-download", "--no-warnings", "-q",
      "--playlist-end", String(limit),
      url,
    ],
    { timeout: 45000, encoding: "utf8" }
  );

  const entries = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(parseEntry(JSON.parse(t)));
    } catch { /* skip malformed */ }
  }
  return entries;
}

export default {
  name:  "youtube-playlist",
  price: "$0.021",

  description:
    "Fetch up to 50 videos from a YouTube playlist. Returns title, channel, duration, view count, and video URL for each entry. No API key required. Pair with youtube-intel to analyze individual videos from the list.",

  inputSchema: {
    type: "object",
    properties: {
      playlist_id: {
        type: "string",
        description:
          "YouTube playlist ID (e.g. 'PLrAXtmErZgOeiKm4sgNOknc9TTnufFTL') or full playlist URL.",
      },
      limit: {
        type: "integer",
        description: "Max videos to return (1–50, default 25).",
        minimum: 1,
        maximum: 50,
      },
    },
    required: ["playlist_id"],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      playlist_url: { type: "string",  description: "Resolved playlist URL." },
      count:        { type: "integer", description: "Number of videos returned." },
      videos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            video_id:         { type: ["string",  "null"], description: "11-character YouTube video ID." },
            title:            { type: ["string",  "null"], description: "Video title." },
            channel:          { type: ["string",  "null"], description: "Channel display name." },
            channel_id:       { type: ["string",  "null"], description: "YouTube channel ID." },
            duration_seconds: { type: ["integer", "null"], description: "Duration in seconds." },
            duration_string:  { type: ["string",  "null"], description: "Duration formatted as M:SS or H:MM:SS." },
            view_count:       { type: ["integer", "null"], description: "Total view count." },
            thumbnail:        { type: ["string",  "null"], description: "Best available thumbnail URL." },
            url:              { type: ["string",  "null"], description: "Canonical YouTube watch URL." },
          },
        },
      },
      ts: { type: "string", description: "ISO-8601 response timestamp." },
    },
  },

  async handler(input) {
    const url = toPlaylistUrl(input.playlist_id);
    const limit = Math.min(Math.max(1, parseInt(input.limit) || 25), MAX_VIDEOS);
    const videos = await fetchPlaylist(url, limit);
    return {
      playlist_url: url,
      count:        videos.length,
      videos,
      ts:           new Date().toISOString(),
    };
  },
};
