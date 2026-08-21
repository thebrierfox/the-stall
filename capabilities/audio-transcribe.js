// audio-transcribe.js
//
// Duration tier 2 of 3 (Directive 103 market-comparable pricing ruling,
// 2026-08-02) — the MEDIUM band, 5-15 minutes. Keeps the original route name
// (`audio-transcribe`) for backward compatibility with existing callers and
// Bazaar/discovery listings; the short and long bands are separate routes.
// See capabilities/_audio_transcribe_shared.js for the full rationale and
// the cost-evidence basis for the three tier bands, and
// capabilities/audio-transcribe-short.js for the sibling short-tier route.
//
// Prior to this tiering, this route (then flat-priced at $0.213 for all
// durations up to the 30-minute cap) had its unbounded-cost byte-cap bug
// fixed at commit 95191fe (2026-08-02, PW#64): a byte cap alone didn't bound
// Whisper cost since cost scales with duration, not bytes. That ffprobe
// pre-check is preserved and reused here (now also enforcing the medium
// tier's lower bound alongside the upper).
import {
  makeAudioTranscribeHandler,
  OUTPUT_SCHEMA,
  inputSchema,
} from "./_audio_transcribe_shared.js";

const MIN_DURATION_S = 300;
const MAX_DURATION_S = 900;

export default {
  name:  "audio-transcribe",
  price: "$0.129",
  tags: ["audio", "transcription", "speech-to-text", "evidence"],

  description:
    "Transcribe MEDIUM-length audio (5-15 minutes) from any publicly accessible URL using OpenAI " +
    "Whisper. Supports mp3, mp4, m4a, wav, webm, ogg, flac, and wma up to 24 MB. Returns the full " +
    "transcript text, detected language, and estimated duration in seconds. For audio under 5 " +
    "minutes use audio-transcribe-short (cheaper); for 15-30 minutes use audio-transcribe-long — " +
    "this route rejects out-of-band audio before incurring transcription cost. Useful for meeting " +
    "recordings, podcast snippets, and interview clips.",

  inputSchema: inputSchema("This route accepts audio between 5 and 15 minutes (300-900s) duration only."),
  outputSchema: OUTPUT_SCHEMA,

  handler: makeAudioTranscribeHandler({
    minDurationS: MIN_DURATION_S,
    maxDurationS: MAX_DURATION_S,
    tierLabel: "medium (5-15min)",
  }),
};
