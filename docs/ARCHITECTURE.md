# Architecture — rocketride-podcasts

## System overview

```
┌─────────────────────────────────────────────────────────┐
│  Next.js frontend (localhost:3000)                       │
│  upload page · editor (transcript + EDL + chat)          │
└──────────────────────┬──────────────────────────────────┘
                       │ /api/* (rewritten to :8000)
┌──────────────────────▼──────────────────────────────────┐
│  FastAPI (localhost:8000)                                │
│  /upload  /jobs  /tasks/{id}/status  /chat/{job}         │
│  /download  /preview  /internal/tools/* (agent-only)     │
└───────┬──────────────────────────┬──────────────────┬───┘
        │ audio jobs (async)       │ chat turns        │ tool calls
        ▼                          ▼                   ▲
┌──────────────────┐   ┌─────────────────────┐         │
│  Celery + Redis  │   │  RocketRide engine   │─────────┘
└────────┬─────────┘   │  chat_editor.pipe:   │
         ▼             │  chat → agent_rocket-│
┌──────────────────────│  ride → response     │
│  Postgres            │  (llm_anthropic +    │
│  jobs, chat_turns    │  memory_internal +   │
└──────────────────────│  tool_http_request)  │
         ▲             └──────────────────────┘
         │
┌────────┴───────────────────────────────────────────────┐
│  Audio pipeline nodes (backend/nodes/) — plain Python,   │
│  orchestrated by Celery, NOT RocketRide engine nodes     │
│                                                           │
│  TranscriptionNode ── faster-whisper, word timestamps     │
│  AutoCleanupNode ──── silence + filler detection → EDL    │
│  AudioDSPNode ─────── zero-crossing cuts, crossfades      │
│  MasteringNode ────── noisereduce → Pedalboard → loudnorm │
│  BrandMergeNode ───── intro/outro stitching               │
└──────────────────────────────────────────────────────────┘
```

RocketRide's custom-node model is built for streaming document/chat/RAG filters, not long-running
stateful jobs with a human-editing loop. The audio pipeline (transcribe → clean → render → master →
brand-merge) stays on Celery + Postgres, which fits that shape natively. The chat-editing agent, by
contrast, *is* a conversational Q&A flow — exactly what RocketRide's `agent_rocketride` is built for —
so it runs on the real engine, reaching back into our own API via `tool_http_request` to read the
transcript and mutate the EDL (Postgres remains the single source of truth either way).

## The two modes share one pipeline

**Auto-pilot**: `run_autopilot` task chains all five audio nodes with no human in the loop.
The AutoCleanupNode generates the EDL deterministically (silence thresholds,
filler word list from env).

**Chat editing**: `run_transcribe_only` prepares the transcript and an empty EDL, both stored in
Postgres. The user then converses via `/api/chat/{job_id}`, which relays each turn to the RocketRide
engine (`chat_editor_node.py` → `chat_editor.pipe`). The agent calls `/api/internal/tools/*` to search
the transcript and apply/undo cuts, mutating the EDL row directly. When satisfied, the user triggers
`/api/jobs/{job_id}/render` which runs `render_and_finish`: the same
AudioDSPNode → MasteringNode → BrandMergeNode tail as auto-pilot.

## Why the EDL is the source of truth

Nothing mutates audio until render time. Benefits:

1. **Undo is free** — remove an entry from the list
2. **Timestamp precision is guaranteed** — the agent works with exact numbers,
   not audio; the DSP layer snaps to zero-crossings at render time
3. **Both modes converge** — auto cuts and agent cuts are the same data shape
4. **Auditability** — every cut has a `reason` and `source` field

## Why cuts are inaudible

Each keep-segment boundary goes through three treatments in `utils/dsp.py`:

1. **Zero-crossing snapping** (±15ms search) — cutting mid-waveform creates a
   click; snapping to amplitude-zero points eliminates it
2. **De-click micro-fades** (8ms in/out) — removes any residual transient
3. **Crossfade joins** (20ms default) — blends segment boundaries below the
   threshold of perception

Music-to-speech joins (intro/outro) use 800ms crossfades instead — music beds
need longer blends than speech-to-speech cuts.

## Mastering chain rationale

| Stage | Tool | Auphonic equivalent |
|---|---|---|
| Noise reduction | noisereduce (non-stationary spectral gating) | Denoise |
| Voice chain | Pedalboard: highpass 80Hz → gate → compressor | Adaptive leveler (partial) |
| Loudness | ffmpeg-normalize two-pass EBU R128, -16 LUFS / -1 dBTP | Loudness normalisation |

The one thing this stack doesn't fully replicate is Auphonic's multi-speaker
adaptive leveling. If that becomes a problem with guest episodes, set
`AUPHONIC_API_KEY` and the MasteringNode switches over automatically
(free tier: 2h/month).

## Scaling notes (future)

- Celery worker concurrency is 1 prefetch — audio jobs are memory-heavy;
  scale horizontally by adding workers, not prefetch
- Job state lives in Postgres (`backend/db/models.py`); large binary outputs
  (final MP3s) still live on the local filesystem under `tmp/outputs/` —
  move those to S3/R2 when running multi-machine
- Job status is pushed to the frontend over WebSocket (see `backend/api/routes/ws.py`)
  instead of polled
- Speaker diarization (pyannote.audio) unlocks per-speaker leveling and
  "cut everything speaker 2 said" agent commands
