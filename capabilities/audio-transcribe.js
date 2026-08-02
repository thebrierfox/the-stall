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
// No local GPU required. In-memory fetch + forward — no temp files.

const WHISPER_URL  = "https://api.openai.com/v1/audio/transcriptions";
const MAX_BYTES    = 24 * 1024 * 1024; // 24 MB (API hard limit: 25 MB)
const FETCH_MS     = 45_000;
const WHISPER_MS   = 60_000;

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
    "Transcribe audio from any publicly accessible URL using OpenAI Whisper. Supports mp3, mp4, m4a, wav, webm, ogg, flac, and wma up to 24 MB. Returns the full transcript text, detected language, and estimated duration in seconds. Optionally accepts an ISO 639-1 language hint to improve accuracy. Useful for processing voice memos, meeting recordings, podcast snippets, interview clips, and audio attached to social media.",

  inputSchema: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      url: {
        type: "string",
        description:
          "Public URL of the audio file to transcribe (mp3, mp4, m4a, wav, webm, ogg, flac, wma). Must be directly accessible without authentication. Max 24 MB.",
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
