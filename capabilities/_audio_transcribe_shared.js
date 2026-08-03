// _audio_transcribe_shared.js
//
// Shared fetch/probe/transcribe core for the audio-transcribe tier family
// (audio-transcribe-short / audio-transcribe / audio-transcribe-long).
// Underscore prefix excludes this file from registry.js's capability loader
// (see capabilities/_TEMPLATE.js for the same convention).
//
// Directive 103 (2026-08-02) market-comparable pricing ruling: a single flat
// price for audio-transcribe is commercially wrong across duration, since
// upstream Whisper cost scales linearly with duration (~$0.006/min), not with
// the file's byte size. This module is shared by three duration-gated routes
// so each can advertise (and enforce) its own price tier instead of one route
// quietly overcharging short clips and thin-margining long ones.
//
// Whisper cost evidence (2026-08-02 controlled fixtures against live OpenAI
// API, see stall_revenue_recovery_audio_transcribe_cost_derivation_20260802.md):
//   12.4s   -> $0.0012
//   463.1s  (7.72min)  -> $0.0463
//   1818.9s (30.31min) -> $0.1819
// i.e. cost ≈ duration_minutes * $0.006, confirming the tier bands below.

export const WHISPER_URL   = "https://api.openai.com/v1/audio/transcriptions";
export const MAX_BYTES     = 24 * 1024 * 1024; // 24 MB (API hard limit: 25 MB)
export const FETCH_MS      = 45_000;
// Whisper latency scales with duration, same as cost: the 2026-08-02 cost-derivation
// fixture (1818.9s / 30.3min clip) measured 105.8s of actual Whisper API latency —
// the original 60_000ms timeout (inherited from the pre-tiering single-route file,
// which advertised the same 30min cap) would have aborted that exact call. 180s
// gives headroom above the worst observed case at the top of the long tier's band.
export const WHISPER_MS    = 180_000;
export const FFPROBE_MS    = 10_000;

export const ALLOWED_EXTS = new Set([
  "mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm", "ogg", "flac", "wma",
]);

export function mimeFromUrl(url) {
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

export function extFromUrl(url) {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    return ALLOWED_EXTS.has(ext) ? ext : "mp3";
  } catch {
    return "mp3";
  }
}

export async function probeDurationSeconds(buffer) {
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

export async function fetchAudio(url) {
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

export async function transcribe(buffer, url, language) {
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

// Shared handler factory — each tier route calls this with its own
// [minDurationS, maxDurationS) band. Duration is probed via ffprobe BEFORE
// the paid Whisper call, same discipline as the pre-tiering single-route
// version, now enforcing a band instead of only a ceiling. A probe failure
// (corrupt/unrecognized audio) rejects rather than failing open to Whisper —
// unlike the pre-tiering version — because on a single flat-priced route an
// unclassifiable file was still priced correctly by definition, but across
// three differently-priced tiers, letting an unprobed file through would
// mean charging one tier's price for a possibly-different-cost file. That's
// the exact "unbounded obligation for a fixed price" risk Directive 103
// flagged, so it's closed the same way for the tier boundary as it was for
// the original ceiling.
export function makeAudioTranscribeHandler({ minDurationS, maxDurationS, tierLabel, defaultUrl }) {
  return async function handler(query) {
    const { url = defaultUrl, language } = query;
    if (!url) throw new Error("url is required for this route.");

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

    let probedDuration;
    try {
      probedDuration = await probeDurationSeconds(buffer);
    } catch (e) {
      throw new Error(
        `Could not determine audio duration (probe failed: ${e.message}). ` +
        `This route (${tierLabel}, ${minDurationS}-${maxDurationS}s) requires a verifiable ` +
        `duration before transcription to enforce tier pricing — try a different audio file ` +
        `or a re-encoded version.`
      );
    }
    if (probedDuration < minDurationS || probedDuration >= maxDurationS) {
      throw new Error(
        `Audio duration (${Math.round(probedDuration)}s) is outside this route's ${tierLabel} ` +
        `tier band (${minDurationS}-${maxDurationS}s). Use the matching duration-tier route instead: ` +
        `audio-transcribe-short (0-300s), audio-transcribe (300-900s), or audio-transcribe-long (900-1800s).`
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
  };
}

export const OUTPUT_SCHEMA = {
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
};

export function inputSchema(extraUrlNote) {
  return {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      url: {
        type: "string",
        description:
          `Public URL of the audio file to transcribe (mp3, mp4, m4a, wav, webm, ogg, flac, wma). ` +
          `Must be directly accessible without authentication. Max 24 MB. ${extraUrlNote}`,
      },
      language: {
        type: "string",
        description:
          "Optional ISO 639-1 language code hint (e.g. 'en', 'es', 'fr', 'de', 'ja'). Improves accuracy when the audio language is known. Omit to auto-detect.",
      },
    },
  };
}
