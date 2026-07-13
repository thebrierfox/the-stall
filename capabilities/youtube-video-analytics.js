// youtube-video-analytics.js
//
// Heuristic performance analysis for a single YouTube video.
// Returns view velocity (views/day since publish), engagement rate
// (likes+comments / views), view-to-sub ratio, and a performance tier:
//   VIRAL           — breakout spread beyond the channel's normal reach
//   HIGH_PERFORMING — strong engagement and/or above-average velocity
//   AVERAGE         — within expected range for a video of this age
//   UNDERPERFORMING — consistently below typical thresholds
//
// Distinct from youtube-intel (raw metadata — title, description, chapters,
// heatmap) and youtube-channel-analytics (channel-level recent-upload trend).
// This cap answers "is this specific video working?" with calibrated thresholds.
//
// Performance tier uses a composite of three signals:
//   view_to_sub_ratio = total_views / channel_subscribers (>0.5 = exceptional reach)
//   engagement_rate   = (likes + comments) / views (>4% = high quality)
//   view_velocity     = views / age_days (>10k/day = highly active)
//
// Age-bucket context: FRESH (<7d), RECENT (7–30d), ESTABLISHED (31–180d), MATURE (>180d).
// FRESH videos receive tier leniency — initial burst views are normal; velocity
// is suppressed rather than inflated in the interpretation.
//
// Upstream: yt-dlp (local binary, free). Falls back to yt-dlp oembed probe.
// Price: $0.015/call

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const YTDLP  = "/home/aegis/.local/bin/yt-dlp";
const ID_RE  = /^[a-zA-Z0-9_-]{11}$/;

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

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }
function r4(n) { return n != null ? Math.round(n * 10000) / 10000 : null; }
function pct(n) { return n != null ? r2(n * 100) : null; }

function parseUploadDateToIso(d) {
  if (!d || String(d).length !== 8) return null;
  const s = String(d);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function ageDays(uploadIso) {
  if (!uploadIso) return null;
  const uploaded = new Date(uploadIso + "T00:00:00Z");
  const now = new Date();
  return Math.max(1, Math.round((now - uploaded) / 86400000));
}

function ageBucket(days) {
  if (!days) return "UNKNOWN";
  if (days <= 7)   return "FRESH";
  if (days <= 30)  return "RECENT";
  if (days <= 180) return "ESTABLISHED";
  return "MATURE";
}

function fmtDuration(secs) {
  if (secs == null) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function durationCategory(secs) {
  if (secs == null) return "UNKNOWN";
  if (secs < 60)   return "SHORT";       // < 1 min (Shorts territory)
  if (secs < 180)  return "SHORT";       // 1-3 min
  if (secs < 1200) return "STANDARD";    // 3-20 min
  return "LONG";                         // > 20 min
}

function computePerformanceTier(viewVelocity, engagementRate, viewToSubRatio, ageBkt) {
  // VIRAL: spreads well beyond the channel's typical footprint
  const isViral =
    (viewToSubRatio != null && viewToSubRatio > 1.0) ||
    (ageBkt === "FRESH" && viewVelocity != null && viewVelocity > 200000) ||
    (ageBkt === "RECENT" && viewVelocity != null && viewVelocity > 50000);

  if (isViral) return "VIRAL";

  // HIGH_PERFORMING: strong engagement or above-average reach
  const isHigh =
    (engagementRate != null && engagementRate > 0.04) ||
    (viewToSubRatio != null && viewToSubRatio > 0.30) ||
    (viewVelocity != null && viewVelocity > 10000 && ageBkt !== "FRESH");

  if (isHigh) return "HIGH_PERFORMING";

  // AVERAGE: within expected range
  const isAvg =
    (engagementRate != null && engagementRate > 0.01) ||
    (viewToSubRatio != null && viewToSubRatio > 0.05) ||
    (viewVelocity != null && viewVelocity > 500);

  if (isAvg) return "AVERAGE";

  return "UNDERPERFORMING";
}

async function fetchVideo(videoId) {
  const { stdout } = await execFileAsync(
    YTDLP,
    [
      "--dump-json", "--no-download", "--no-warnings", "-q", "--no-playlist",
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    { timeout: 30000, encoding: "utf8" }
  );
  return JSON.parse(stdout);
}

export default {
  name:  "youtube-video-analytics",
  price: "$0.021",
  description:
    "Heuristic performance analysis for a single YouTube video: view velocity (views/day), " +
    "engagement rate (likes+comments/views), view-to-sub ratio, and tier: " +
    "VIRAL / HIGH_PERFORMING / AVERAGE / UNDERPERFORMING. " +
    "Extends youtube-intel (raw metadata) by adding the scored interpretation layer " +
    "that content strategy and competitive research pipelines need. " +
    "Accepts video URL, video ID, or youtu.be short link.",
  inputSchema: {
    type: "object",
    properties: {
      video: {
        type:        "string",
        description:
          "YouTube video URL (youtube.com/watch?v=...), youtu.be short link, " +
          "Shorts URL (/shorts/ID), or bare 11-character video ID.",
      },
    },
    required: ["video"],
  },
  outputSchema: {
    type: "object",
    properties: {
      video_id:    { type: "string" },
      title:       { type: ["string", "null"] },
      channel:     { type: ["string", "null"] },
      upload_date: { type: ["string", "null"], description: "ISO date YYYY-MM-DD" },
      age_days:    { type: ["integer", "null"] },
      age_bucket:  { type: "string", description: "FRESH | RECENT | ESTABLISHED | MATURE | UNKNOWN" },
      url:         { type: "string" },
      raw: {
        type: "object",
        description: "Raw counts as reported by YouTube.",
        properties: {
          view_count:               { type: ["integer", "null"] },
          like_count:               { type: ["integer", "null"] },
          comment_count:            { type: ["integer", "null"] },
          channel_subscriber_count: { type: ["integer", "null"] },
          duration_seconds:         { type: ["integer", "null"] },
          duration_string:          { type: ["string", "null"] },
        },
      },
      analytics: {
        type: "object",
        properties: {
          view_velocity:      { type: ["number", "null"],  description: "Average views per day since upload." },
          engagement_rate:    { type: ["number", "null"],  description: "(likes + comments) / views. Null if views = 0." },
          engagement_rate_pct:{ type: ["number", "null"],  description: "engagement_rate as a percentage." },
          view_to_sub_ratio:  { type: ["number", "null"],  description: "total_views / channel_subscribers. >1.0 = viral spread beyond subscriber base. Null if subs unavailable." },
          performance_tier:   { type: "string",            description: "VIRAL | HIGH_PERFORMING | AVERAGE | UNDERPERFORMING" },
          duration_category:  { type: "string",            description: "SHORT (<3 min) | STANDARD (3–20 min) | LONG (>20 min) | UNKNOWN" },
          interpretation: {
            type: "object",
            description: "Human-readable signal summaries.",
            properties: {
              engagement_signal: { type: "string" },
              reach_signal:      { type: "string" },
              velocity_signal:   { type: "string" },
              summary:           { type: "string" },
            },
          },
        },
      },
    },
  },

  async handler({ video }) {
    const videoId = extractVideoId(video);
    if (!videoId) throw new Error(`Cannot parse video ID from input: ${video}`);

    const d = await fetchVideo(videoId);

    const uploadIso = parseUploadDateToIso(d.upload_date);
    const days      = ageDays(uploadIso);
    const ageBkt    = ageBucket(days);

    const views    = d.view_count    ?? null;
    const likes    = d.like_count    ?? null;
    const comments = d.comment_count ?? null;
    const subs     = d.channel_follower_count ?? null;
    const durSecs  = d.duration ?? null;

    const viewVelocity   = (views != null && days != null) ? r2(views / days) : null;
    const engagementRate = (views != null && views > 0)
      ? r4(((likes ?? 0) + (comments ?? 0)) / views)
      : null;
    const viewToSubRatio = (views != null && subs != null && subs > 0)
      ? r4(views / subs)
      : null;

    const tier         = computePerformanceTier(viewVelocity, engagementRate, viewToSubRatio, ageBkt);
    const durCategory  = durationCategory(durSecs);

    // Build interpretation signals
    let engagementSignal;
    if (engagementRate == null)       engagementSignal = "Engagement data unavailable";
    else if (engagementRate > 0.08)   engagementSignal = "Exceptional engagement (>8%) — highly interactive audience";
    else if (engagementRate > 0.04)   engagementSignal = "Strong engagement (>4%) — well above category average";
    else if (engagementRate > 0.02)   engagementSignal = "Good engagement (2–4%) — above average";
    else if (engagementRate > 0.01)   engagementSignal = "Average engagement (1–2%)";
    else                              engagementSignal = "Below-average engagement (<1%)";

    let reachSignal;
    if (viewToSubRatio == null)       reachSignal = "Subscriber count unavailable — cannot compute reach ratio";
    else if (viewToSubRatio > 2.0)    reachSignal = `Exceptional reach (${r2(viewToSubRatio)}× subs) — video spread well beyond subscriber base`;
    else if (viewToSubRatio > 0.5)    reachSignal = `Strong reach (${r2(viewToSubRatio)}× subs) — reached ~${pct(viewToSubRatio)}% of subscribers`;
    else if (viewToSubRatio > 0.1)    reachSignal = `Moderate reach (${r2(viewToSubRatio)}× subs) — reached ~${pct(viewToSubRatio)}% of subscribers`;
    else                              reachSignal = `Limited reach (${r2(viewToSubRatio)}× subs) — reached <10% of subscriber base`;

    let velocitySignal;
    if (viewVelocity == null)         velocitySignal = "Upload date unavailable — cannot compute velocity";
    else if (viewVelocity > 100000)   velocitySignal = `High velocity (${Math.round(viewVelocity).toLocaleString()} views/day)`;
    else if (viewVelocity > 10000)    velocitySignal = `Good velocity (${Math.round(viewVelocity).toLocaleString()} views/day)`;
    else if (viewVelocity > 1000)     velocitySignal = `Moderate velocity (${Math.round(viewVelocity).toLocaleString()} views/day)`;
    else                              velocitySignal = `Low velocity (${Math.round(viewVelocity ?? 0).toLocaleString()} views/day)`;

    const agePart = days != null ? ` ${days}-day-old ${ageBkt.toLowerCase()} video` : "";
    const summary = `${tier}${agePart}. ${velocitySignal}. ${engagementSignal}.`;

    return {
      video_id:    videoId,
      title:       d.title ?? null,
      channel:     d.uploader ?? d.channel ?? null,
      upload_date: uploadIso,
      age_days:    days,
      age_bucket:  ageBkt,
      url:         `https://www.youtube.com/watch?v=${videoId}`,
      raw: {
        view_count:               views,
        like_count:               likes,
        comment_count:            comments,
        channel_subscriber_count: subs,
        duration_seconds:         durSecs,
        duration_string:          fmtDuration(durSecs),
      },
      analytics: {
        view_velocity:       viewVelocity,
        engagement_rate:     engagementRate,
        engagement_rate_pct: pct(engagementRate),
        view_to_sub_ratio:   viewToSubRatio,
        performance_tier:    tier,
        duration_category:   durCategory,
        interpretation: {
          engagement_signal: engagementSignal,
          reach_signal:      reachSignal,
          velocity_signal:   velocitySignal,
          summary,
        },
      },
    };
  },
};
