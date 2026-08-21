// audio-transcribe-short.js
//
// Duration tier 1 of 3 (Directive 103 market-comparable pricing ruling,
// 2026-08-02): audio-transcribe was a single flat $0.213 price across all
// durations even though upstream Whisper cost scales linearly with duration
// (~$0.006/min, see capabilities/_audio_transcribe_shared.js header). That
// overcharged short clips relative to market comparables. Split into three
// duration-gated routes so each tier prices near its own cost profile:
//   audio-transcribe-short  (this file): 0-300s   (<=5 min)  — $0.039
//   audio-transcribe:              300-900s  (5-15 min) — $0.129
//   audio-transcribe-long:         900-1800s (15-30 min) — $0.209
// Bands chosen from the 2026-08-02 controlled-fixture cost evidence: 12.4s
// clip cost $0.0012 (short-tier), 463s/7.7min clip cost $0.0463 (mid-tier),
// 1819s/30.3min clip cost $0.1819 (long-tier, near the existing 30min cap).
import {
  makeAudioTranscribeHandler,
  OUTPUT_SCHEMA,
  inputSchema,
} from "./_audio_transcribe_shared.js";

const MIN_DURATION_S = 0;
const MAX_DURATION_S = 300;

export default {
  name:  "audio-transcribe-short",
  price: "$0.039",
  tags: ["audio", "transcription", "speech-to-text", "evidence"],

  description:
    "Transcribe SHORT audio clips (0-5 minutes) from any publicly accessible URL using OpenAI " +
    "Whisper. Supports mp3, mp4, m4a, wav, webm, ogg, flac, and wma up to 24 MB. Returns the full " +
    "transcript text, detected language, and estimated duration in seconds. For audio longer than " +
    "5 minutes, use audio-transcribe (5-15 min) or audio-transcribe-long (15-30 min) instead — this " +
    "route rejects out-of-band audio before incurring transcription cost. Useful for voice memos, " +
    "short clips, and social media audio snippets.",

  inputSchema: inputSchema("This route accepts audio up to 5 minutes (300s) duration only."),
  outputSchema: OUTPUT_SCHEMA,

  handler: makeAudioTranscribeHandler({
    minDurationS: MIN_DURATION_S,
    maxDurationS: MAX_DURATION_S,
    tierLabel: "short (0-5min)",
  }),
};
