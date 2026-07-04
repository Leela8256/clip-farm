# Quality Evaluation Report — rocketride-podcasts

Measured against real, open-license audio run through the actual pipeline
end-to-end (not synthetic test signals). All numbers below are from live runs.

## Test material

- **Short clip** (`test_clip_4min.mp3`) — 4 min extracted from a real public-domain
  interview (Internet Archive: `InterviewWithKennethFoster`). Old analog tape
  transfer: high noise floor (~-13 dBFS), spontaneous conversational speech with
  filler words and natural pauses. A deliberately *hard* case.
- **Full episode** (`kenneth_foster_interview.mp3`) — the complete 48-minute
  interview, used as a long-form stress test.

## Loudness / true-peak (the AES podcast standard: -16 LUFS, -1 dBTP)

Measured with `ffmpeg-normalize`'s own two-pass EBU R128 stats:

| Run | Integrated loudness | True peak | Verdict |
|---|---|---|---|
| 4-min clip (final) | **-16.47 LUFS** | **-1.21 dBTP** | On target |
| 48-min episode (final) | **-16.45 LUFS** | **-1.15 dBTP** | On target |

Both land within ~0.5 LU of the -16 LUFS target and comfortably under the
-1 dBTP ceiling — no inter-sample clipping risk on Spotify/Apple re-encode.

### Bug found & fixed during evaluation
The brand-merge step originally spliced in the intro/outro jingle (which measured
-13.57 LUFS / +0.16 dBTP — louder and hotter than the episode) with no loudness
matching, dragging the final output to -16.44 LUFS / **-0.11 dBTP** — over the
true-peak ceiling by ~0.9 dB. Fixed by re-running the two-pass normalization on
the fully stitched mix. The numbers above are post-fix.

## Cut detection (filler words + silence)

| Run | Total cuts | Filler | Silence | Trimmed |
|---|---|---|---|---|
| 4-min clip | 21 | 13 | 8 | 13.6 s |
| 48-min episode | 210 | 129 | 81 | 140 s (2.3 min) |

### Bug found & fixed during evaluation
Amplitude-based silence detection (pydub, -40 dBFS threshold) found **zero**
cuttable silences on this recording — even across a 4.2-second pause — because
the noise floor sits at -13 dBFS, indistinguishable from speech by amplitude
alone. Added a second detector that derives silence from the gaps between
Whisper's already-VAD-filtered transcript segments (noise-floor-independent).
Silence cuts on the 4-min clip went from **0 → 8** after the fix. On clean
studio recordings the original amplitude detector still contributes; the two
signals are unioned and de-duplicated.

## Cut inaudibility (zero-crossing + crossfade + de-click)

Verified quantitatively via sample-level discontinuity analysis at every
crossfade join point on the 4-min output:

- Largest sample-to-sample jump within 50 ms of any of the 21 join points: **9450**
- 99.9th-percentile jump found anywhere in normal speech: **6410**
- Discontinuities above 15000 (potential clicks): 5 total, **none within 66 ms
  of a cut** — all coincide with natural loud speech transients (plosives),
  not edit boundaries.

Conclusion: cuts do not introduce audible artifacts distinct from the recording's
own normal speech dynamics. The zero-crossing snap (±15 ms) + 8 ms de-click fades
+ 20 ms crossfade chain is working as designed.

## Transcription

- faster-whisper `medium` model (upgraded from the `base` default for accuracy).
- 4-min clip: 71 segments, language auto-detected `en` at 0.98 confidence.
- 48-min episode: transcribed fully and correctly.
- **Performance note:** on CPU, the `medium` model transcribes roughly at or
  slightly slower than real-time (the 48-min episode's transcription dominated
  its total runtime). For faster turnaround, set `WHISPER_MODEL=small` or run on
  a CUDA GPU (`WHISPER_DEVICE=cuda`). This is the main performance lever for
  long episodes.

## What's verified working end-to-end

- **Auto-pilot**: upload → transcribe → auto-clean → render → master → brand-merge
  → download, on both a 4-min clip and a full 48-min episode.
- **Chat-editing data loop**: transcribe-only → editor loads transcript + empty
  EDL → all RocketRide agent tools (`search_transcript`, `apply_cut`, `undo_cut`,
  `list_cuts`, `transcript_around`) mutate the Postgres-backed EDL correctly.
- **RocketRide engine integration**: `chat_editor.pipe` loads and executes on the
  live local engine; agent/memory/tool/LLM control wiring resolves correctly
  (confirmed by a real chat round-trip through the engine).
- **Real-time status**: WebSocket push (Celery → Redis pub/sub → FastAPI WS →
  frontend) delivers stage-by-stage progress through the Next.js proxy.
- **30 backend tests** pass (EDL logic, DSP cuts, both silence detectors,
  mastering targets, brand-merge regression guard).

## Known limitation

The chat agent's **LLM conversation** could not be exercised: the available
Anthropic key has a zero credit balance (confirmed directly against Anthropic's
API, independent of RocketRide). Every tool the agent calls is verified; only the
model turn itself is pending a funded key.
