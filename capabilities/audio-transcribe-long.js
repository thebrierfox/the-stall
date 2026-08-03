// audio-transcribe-long.js
//
// Duration tier 3 of 3 (Directive 103 market-comparable pricing ruling,
// 2026-08-02): 15-30 minutes. See capabilities/_audio_transcribe_shared.js
// for the full rationale and the cost-evidence basis for the three tier
// bands, and capabilities/audio-transcribe-short.js / audio-transcribe.js
// for the sibling short/medium-tier routes.
import {
  makeAudioTranscribeHandler,
  OUTPUT_SCHEMA,
  inputSchema,
} from "./_audio_transcribe_shared.js";

const MIN_DURATION_S = 900;
const MAX_DURATION_S = 1800;

export default {
  name:  "audio-transcribe-long",
  price: "$0.209",
  tags: ["audio", "transcription", "speech-to-text", "evidence"],

  description:
    "Transcribe LONG audio (15-30 minutes) from any publicly accessible URL using OpenAI Whisper. " +
    "Supports mp3, mp4, m4a, wav, webm, ogg, flac, and wma up to 24 MB and 30 minutes duration " +
    "(whichever limit is hit first). Returns the full transcript text, detected language, and " +
    "estimated duration in seconds. For audio under 15 minutes use audio-transcribe (5-15 min, " +
    "cheaper) or audio-transcribe-short (0-5 min, cheaper still) — this route rejects out-of-band " +
    "audio before incurring transcription cost. Useful for full podcast episodes and long-form " +
    "recordings.",

  inputSchema: inputSchema("This route accepts audio between 15 and 30 minutes (900-1800s) duration only."),
  outputSchema: OUTPUT_SCHEMA,

  handler: makeAudioTranscribeHandler({
    minDurationS: MIN_DURATION_S,
    maxDurationS: MAX_DURATION_S,
    tierLabel: "long (15-30min)",
    defaultUrl: "https://archive.org/download/windinwillowsdr_2207_librivox/windwillowsdr_01_grahame_64kb.mp3",
  }),
};
