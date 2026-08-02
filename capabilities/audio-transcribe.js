// audio-transcribe.js
//
// Audio transcription from any publicly accessible URL (mp3, mp4, mpeg, m4a,
// wav, webm, ogg, flac). Fetches the file in-memory, forwards to OpenAI
// Whisper-1, and returns full transcript text with detected language.
//
// Seam: orbisapi.com/proxy/audio-transcription-api-7042e6
//       532 calls/day · 8 payers · ~$0.0079/call (2026-06 observation)
//       NOTE: live price ($0.213, see below) is well ABOVE this comp after
//       two catalog-wide reprice waves (34e34ef, 85cde40) — the "24% undercut"
//       framing predates those and is stale. Directive 103 (2026-08-02) flags
//       this class of price/description drift; see anomaly re: BLOCKED_COST_UNKNOWN.
//
// Upstream: OpenAI Whisper-1 ($0.006/min) via OPENAI_API_KEY.
// No local GPU required. In-memory fetch + forward — no temp files (except a
// short-lived ffprobe scratch file used only for the pre-Whisper duration check).
//
// Directive 103 cost derivation (2026-08-02): a 24 MB byte cap does NOT bound
// Whisper cost, because cost scales with duration, not bytes — a low-bitrate
// file can pack far more minutes into the same 24 MB than a typical 64-128kbps
// recording. Controlled fixtures measured against the live OpenAI Whisper API
// this session: 12.4s clip -> $0.0012 (0.6% of $0.213 price); 463s (~7.7min,
// 64kbps, 3.53MB) -> $0.0463 (22%); 1819s (~30.3min, 64kbps, 13.88MB) -> $0.182
// (85% of price, thin margin). At the old 24MB cap and a plausible low bitrate
// (e.g. 16kbps mono voice memo), duration could reach ~3,145s (~52min), costing
// ~$0.315 — a real loss against the $0.213 flat price. Fix: probe real duration
// via ffprobe (local, free, ~20ms) BEFORE calling paid Whisper, and reject
// anything over MAX_DURATION_S so cost is bounded by duration, the actual cost
// driver, not by an unrelated byte limit.
const WHISPER_URL     = "https://api.openai.com/v1/audio/transcriptions";
const MAX_BYTES        = 24 * 1024 * 1024; // 24 MB (API hard limit: 25 MB)
const MAX_DURATION_S   = 1800; // 30 min buyer-visible cap — bounds worst-case Whisper cost to ~$0.18 (85% of $0.213 price), evidence above
const FETCH_MS     = 45_000;
const WHISPER_MS   = 60_000;
const FFPROBE_MS   = 10_000;

const ALLOWED_EXTS = new Set([
  "mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm", "ogg", "flac", "wma",
]);

function mimeFromUrl(url) {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    const map = {
      mp3: "audio/mpeg", mp4: "audio/mp4", mpeg: "audio/mpeg",
      mpga: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
      webm: "audio/webm", ogg: "audio/ogg", flac: "audio/flac",
      wma: "audio/x-ms-wma",
    };
    return map[ext] || "audio/mpeg";
  } catch {
    return "audio/mpeg";
  }
}

function extFromUrl(url) {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    return ALLOWED_EXTS.has(ext) ? ext : "mp3";
  } catch {
    return "mp3";
  }
}

async function probeDurationSeconds(buffer) {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const crypto = await import("node:crypto");

  const tmpPath = path.join(os.tmpdir(), `stall-audio-probe-${crypto.randomUUID()}`);
  await fs.writeFile(tmpPath, Buffer.from(buffer));
  try {
    const duration = await new Promise((resolve, reject) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        tmpPath,
      ]);
      let out = "";
      let err = "";
      const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("ffprobe timeout")); }, FFPROBE_MS);
      proc.stdout.on("data", (d) => { out += d; });
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        const val = parseFloat(out.trim());
        if (code === 0 && Number.isFinite(val)) resolve(val);
        else reject(new Error(`ffprobe failed (code=${code}): ${err.slice(0, 200)}`));
      });
    });
    return duration;
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

async function fetchAudio(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "the-stall/4.49 (+https://intuitek.ai)",
      Accept: "audio/*, application/octet-stream",
    },
    signal: AbortSignal.timeout(FETCH_MS),
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`Audio fetch HTTP ${resp.status} from ${url}`);

  const contentLen = parseInt(resp.headers.get("content-length") || "0", 10);
  if (contentLen > MAX_BYTES) {
    throw new Error(
      `Audio file too large (${Math.round(contentLen / 1024 / 1024)} MB). Max 24 MB.`
    );
  }

  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(
      `Audio file too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB). Max 24 MB.`
    );
  }
  return buffer;
}

async function transcribe(buffer, url, language) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const mime = mimeFromUrl(url);
  const ext  = extFromUrl(url);
  const blob = new Blob([buffer], { type: mime });

  const form = new FormData();
  form.append("file", blob, `audio.${ext}`);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  if (language) form.append("language", language);

  const resp = await fetch(WHISPER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(WHISPER_MS),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`Whisper API HTTP ${resp.status}: ${err.slice(0, 200)}`);
  }

  return resp.json();
}

export default {
  name:  "audio-transcribe",
  price: "$0.213",
  tags: ["audio", "transcription", "speech-to-text", "evidence"],

  description:
    "Transcribe audio from any publicly accessible URL using OpenAI Whisper. Supports mp3, mp4, m4a, wav, webm, ogg, flac, and wma up to 24 MB and 30 minutes duration (whichever limit is hit first). Returns the full transcript text, detected language, and estimated duration in seconds. Optionally accepts an ISO 639-1 language hint to improve accuracy. Useful for processing voice memos, meeting recordings, podcast snippets, interview clips, and audio attached to social media.",

  inputSchema: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      url: {
        type: "string",
        description:
          "Public URL of the audio file to transcribe (mp3, mp4, m4a, wav, webm, ogg, flac, wma). Must be directly accessible without authentication. Max 24 MB and 30 minutes duration.",
      },
      language: {
        type: "string",
        description:
          "Optional ISO 639-1 language code hint (e.g. 'en', 'es', 'fr', 'de', 'ja'). Improves accuracy when the audio language is known. Omit to auto-detect.",
      },
    },
  },

  outputSchema: {
    type: "object",
    properties: {
      transcript:  { type: "string" },
      language:    { type: "string" },
      duration_s:  { type: "number" },
      word_count:  { type: "integer" },
      source_url:  { type: "string" },
      model:       { type: "string" },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    const { url = "https://ia800305.us.archive.org/22/items/testmp3testfile/mpthreetest.mp3", language } = query;

    // Basic URL validation
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("url must use http or https");
    }

    const buffer = await fetchAudio(url);

    // Duration cap enforced BEFORE the paid Whisper call — a byte cap alone doesn't
    // bound cost (cost scales with duration; low-bitrate files pack more minutes
    // into the same MAX_BYTES). See file header for the measured-cost rationale.
    let probedDuration;
    try {
      probedDuration = await probeDurationSeconds(buffer);
    } catch (e) {
      // ffprobe failure (corrupt/unrecognized audio) — let Whisper attempt it and
      // surface its own error rather than false-rejecting a legitimate file.
      probedDuration = null;
    }
    if (probedDuration != null && probedDuration > MAX_DURATION_S) {
      throw new Error(
        `Audio duration (${Math.round(probedDuration)}s) exceeds the ${MAX_DURATION_S}s (30 min) maximum for this route.`
      );
    }

    const result = await transcribe(buffer, url, language || null);

    const transcript = result.text || "";
    const lang       = result.language || (language || "unknown");
    const duration   = result.duration != null ? Math.round(result.duration * 100) / 100 : null;
    const wordCount  = transcript.split(/\s+/).filter(Boolean).length;

    return {
      transcript,
      language:     lang,
      duration_s:   duration,
      word_count:   wordCount,
      source_url:   url,
      model:        "whisper-1",
      generated_at: new Date().toISOString(),
    };
  },
};
