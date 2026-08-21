// youtube-transcript.js
//
// Full transcript extraction for any YouTube video.
//
// Uses yt-dlp to download auto-generated English subtitles (VTT format),
// parses them into timestamped segments and clean plain text. Deduplicates
// the overlapping cue lines that auto-captions produce.
//
// Seam: the agent running youtube-intel (29 calls/48h, single pipeline) needs
// the transcript content to analyze, quote, or summarize — metadata alone is
// insufficient for content-aware research workflows.
//
// Upstream: yt-dlp (local binary, free, no auth required).

import { execFile }            from "child_process";
import { promisify }           from "util";
import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import { join }                from "path";
import { tmpdir }              from "os";

const execFileAsync = promisify(execFile);
const YTDLP         = process.env.YTDLP_BIN || "/home/aegis/.local/bin/yt-dlp";
const ID_RE         = /^[a-zA-Z0-9_-]{11}$/;

function extractVideoId(input) {
  if (!input) return null;
  const s = input.trim();
  if (ID_RE.test(s)) return s;
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    if (u.hostname === "youtu.be") {
      const m = u.pathname.match(/\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
    if (u.hostname.endsWith("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && ID_RE.test(v)) return v;
      const m = u.pathname.match(/\/(shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch { /* fall through */ }
  return null;
}

function parseVTT(vtt, maxSegs = 600) {
  const lines    = vtt.split("\n");
  const segments = [];
  let   i        = 0;

  while (i < lines.length && segments.length < maxSegs) {
    const line = lines[i].trim();
    if (line.includes("-->")) {
      const start = line.split("-->")[0].trim();
      i++;
      const textParts = [];
      while (i < lines.length && lines[i].trim() !== "") {
        const t = lines[i].trim().replace(/<[^>]+>/g, "").trim();
        if (t) textParts.push(t);
        i++;
      }
      if (textParts.length > 0) {
        segments.push({ t: start, text: textParts.join(" ") });
      }
    } else {
      i++;
    }
  }

  // Deduplicate adjacent duplicate cues (auto-caption overlap artifact)
  const deduped = [];
  let last = "";
  for (const seg of segments) {
    if (seg.text !== last) {
      deduped.push(seg);
      last = seg.text;
    }
  }
  return deduped;
}

export { extractVideoId, parseVTT };

// ─── Export ──────────────────────────────────────────────────────────────────

export default {
  name:  "youtube-transcript",
  price: "$0.010",
  tags: ["youtube", "transcript", "speech-to-text", "media"],

  description:
    "Full transcript extraction for any YouTube video. Downloads auto-generated English subtitles via yt-dlp (no auth), parses VTT into timestamped segments with deduplication, and returns both segment array and plain-text transcript. Format 'text' returns only the text string. Accepts any YouTube URL format or bare 11-character video ID.",

  inputSchema: {
    type: "object",
    properties: {
      video: {
        type: "string",
        description:
          "YouTube video URL (any format: watch?v=, youtu.be, /shorts/) or bare 11-character video ID.",
      },
      format: {
        type:        "string",
        enum:        ["segments", "text"],
        description: "Output format. 'segments' = timestamped array + text (default). 'text' = plain string only.",
      },
    },
    required:            ["video"],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      video_id:      { type: "string",  description: "11-character YouTube video ID." },
      url:           { type: "string",  description: "Canonical YouTube watch URL." },
      text:          { type: "string",  description: "Full transcript as plain text." },
      segments: {
        type:  "array",
        items: {
          type:       "object",
          properties: {
            t:    { type: "string", description: "Cue start time (HH:MM:SS.mmm)." },
            text: { type: "string", description: "Cue text content."              },
          },
        },
        description: "Timestamped transcript cues (empty when format='text').",
      },
      segment_count: { type: "integer", description: "Number of unique transcript segments." },
      source:        { type: "string",  description: "Always 'yt-dlp'." },
      ts:            { type: "string",  description: "ISO-8601 response timestamp." },
    },
  },

  async handler(query) {
    const videoId = extractVideoId(query?.video);
    if (!videoId) throw Object.assign(new Error("invalid YouTube URL or video ID"), { status: 400 });

    const fmt     = query.format || "segments";
    const workDir = await mkdtemp(join(tmpdir(), `yttrans-${videoId}-`));

    try {
      try {
        await execFileAsync(
          YTDLP,
          [
            "--write-auto-sub",
            "--sub-langs",   "en",
            "--sub-format",  "vtt",
            "--skip-download",
            "--no-warnings",
            "-q",
            "--no-playlist",
            "-o", join(workDir, "video.%(ext)s"),
            `https://www.youtube.com/watch?v=${videoId}`,
          ],
          { timeout: 35000, encoding: "utf8" }
        );
      } catch (ytErr) {
        const stderr = String(ytErr.stderr || ytErr.message || "");
        const isUnavailable = /unavailable|private|not available|members.only|age.restrict|sign in|copyright|geo.block/i.test(stderr);
        const errLine = stderr.trim().split("\n").pop() || "yt-dlp exited non-zero";
        if (isUnavailable) {
          throw Object.assign(new Error(`Video unavailable or access-restricted: ${errLine}`), { status: 400 });
        }
        // Transient failure (rate limit / network) — 503 triggers Retry-After header
        throw Object.assign(new Error(`Transcript fetch failed (transient): ${errLine}`), { status: 503 });
      }

      const files   = await readdir(workDir);
      const vttFile = files.find(f => f.endsWith(".vtt"));
      if (!vttFile) {
        throw Object.assign(
          new Error("No English transcript available for this video (auto-captions disabled or private)."),
          { status: 400 }
        );
      }

      const vtt      = await readFile(join(workDir, vttFile), "utf8");
      const segments = parseVTT(vtt);
      const text     = segments.map(s => s.text).join(" ");

      return {
        video_id:      videoId,
        url:           `https://www.youtube.com/watch?v=${videoId}`,
        text,
        segments:      fmt === "text" ? [] : segments,
        segment_count: segments.length,
        source:        "yt-dlp",
        ts:            new Date().toISOString(),
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
