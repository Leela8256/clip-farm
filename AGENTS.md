# AGENTS.md — rocketride-podcasts

Claude Code reads this file at session start. Follow every constraint here before writing or editing any code.

---

## What this project is

An end-to-end AI podcast audio editing app with two modes:
1. **Auto-pilot** — fully automated pipeline (transcribe → clean → master → merge brand assets)
2. **Chat editing** — a RocketRide-native agent (`agent_rocketride`) edits a non-destructive Edit Decision List via conversation

Backend: FastAPI + Celery + Postgres for the audio pipeline (transcription, DSP, mastering, brand-merge —
these are plain Python classes orchestrated by Celery, not RocketRide engine nodes; see "Why Celery, not
RocketRide, runs the audio pipeline" below). Chat-editing runs on the real RocketRide engine, driven via
the `rocketride` Python SDK. Frontend: Next.js + shadcn/ui.

### Why Celery, not RocketRide, runs the audio pipeline
RocketRide's custom-node model (`IGlobal`/`IInstance`, `write<LaneType>` methods) is built for streaming
document/chat/RAG filters, not long-running stateful jobs with a human-editing loop in the middle. Porting
transcription/DSP/mastering into that model would mean losing the EDL-as-source-of-truth design and Postgres
job state for no benefit. RocketRide is used where it fits natively instead: the conversational agent.

---

## Hard constraints — never violate these

### Audio pipeline nodes (backend/nodes/)
- Nodes live in `backend/nodes/`. Every node is a plain Python class — no C++ runtime changes ever.
- Each node must implement `execute(self, inputs: dict) -> dict` and return a dict of named outputs.
- Nodes communicate via typed lane values (text, file paths, JSON). Never pass raw audio bytes between nodes — use file paths stored in `tmp/`.
- Node dependencies go in `backend/requirements.txt`, not anywhere else.
- These nodes are orchestrated by Celery tasks (`backend/workers/tasks.py`), not the RocketRide engine.

### Chat-editing agent (RocketRide engine)
- Defined in `.rocketride/chat_editor.pipe`: `chat` source → `agent_rocketride` (control-wired to
  `llm_anthropic`, `memory_internal`, `tool_http_request`) → `response_answers`.
- The agent calls back into `backend/api/routes/internal_tools.py` (`/api/internal/tools/*`) to read the
  transcript and mutate the EDL — it never holds EDL state itself. Postgres remains the source of truth.
- `backend/nodes/chat_editor_node.py` drives this pipeline via the `rocketride` Python SDK
  (`RocketRideClient.use()` once, then `client.chat()` per turn). Do not reintroduce a direct Anthropic
  SDK call here — the LLM call belongs inside the `.pipe` file's `llm_anthropic` node.

### Audio processing
- Never modify the original uploaded file. Always copy to `tmp/<job_id>/` first.
- The Edit Decision List (EDL) is the single source of truth. The audio render step reads the EDL and produces output — nothing else mutates audio directly.
- All cuts must use zero-crossing snapping + crossfade (see `backend/utils/dsp.py`). Hard cuts are not acceptable.
- Loudness target: **-16 LUFS, -1 dBTP true peak** (AES podcast standard). Do not change this default.

### API
- All long-running work (transcription, processing, mastering) must go through Celery tasks. Never run blocking audio work inside a FastAPI route directly.
- Job state (status, stage, transcript, EDL, chat history) lives in Postgres (`backend/db/`) — never reintroduce flat-file job state under `tmp/jobs/`.
- File uploads are stored in `tmp/uploads/`. Processed outputs go to `tmp/outputs/`.

### Frontend
- The UI uses a hand-rolled Tailwind design system (see `tailwind.config.ts`: dark theme,
  warm `accent`, semantic `cut`/`keep` colors). Build new components in that same style and reuse
  those tokens. Do not introduce shadcn/ui or another component library — none is in use, and mixing
  systems would fragment the visual language. `frontend/components/ui/` is reserved but currently empty.
- API calls go through `frontend/lib/api.ts` — never call fetch directly in components.
- The transcript editor must render word-level timestamps from the transcription response.
- Job status comes from the WebSocket (`watchJob` in `lib/api.ts`), not polling.
- Chat history is persisted to Postgres (`chat_turns` table), not just React state.

### Environment
- All secrets come from `.env` (see `.env.example`). Never hardcode API keys.
- `ROCKETRIDE_URI` / `ROCKETRIDE_APIKEY` are required for chat-editing (auto-populated by the RocketRide
  VSCode extension when the engine is running). `ROCKETRIDE_ANTHROPIC_KEY` is substituted into
  `chat_editor.pipe`'s `llm_anthropic` node. `AUPHONIC_API_KEY` is optional — mastering falls back to the
  local stack if not set.
- Redis must be running before starting the Celery worker. Postgres must be running before starting the API.

---

## File map — where things live

```
backend/
  api/
    main.py          # FastAPI app entry point
    routes/
      jobs.py            # POST /api/jobs, GET /api/tasks/{id}/status
      audio.py           # POST /api/upload, GET /api/download/{id}
      chat.py            # POST /api/chat/{job_id}
      internal_tools.py  # /api/internal/tools/* — called by the RocketRide chat agent only
  nodes/
    transcription_node.py
    auto_cleanup_node.py
    chat_editor_node.py    # drives the RocketRide engine via the rocketride SDK
    audio_dsp_node.py
    mastering_node.py
    brand_merge_node.py
  workers/
    celery_app.py    # Celery + Redis config
    tasks.py         # Task definitions (run_autopilot, render_and_finish)
  db/
    models.py        # SQLAlchemy models: Job, ChatTurn
    session.py        # Engine/session + init_db()
  utils/
    dsp.py           # Zero-crossing, crossfade, EDL renderer
    edl.py           # EditDecisionList data model
    mastering.py     # noisereduce + Pedalboard + ffmpeg-normalize chain
    auphonic.py      # Auphonic API client (optional)
  requirements.txt

frontend/
  app/
    page.tsx         # Upload landing page
    editor/
      page.tsx       # Main editor (transcript + chat + waveform)
  components/
    ui/              # shadcn components (do not edit)
    editor/
      TranscriptEditor.tsx
      WaveformPlayer.tsx
      EdlPanel.tsx
    chat/
      ChatPanel.tsx
      ChatMessage.tsx
  lib/
    api.ts           # All fetch calls
    types.ts         # Shared TypeScript types

.rocketride/
  podcast_pipeline.pipe   # Documents the Celery-orchestrated audio pipeline (not engine-executed)
  chat_editor.pipe        # Real RocketRide pipeline: chat -> agent_rocketride -> response_answers
```

---

## EDL format (critical — do not change schema)

```json
{
  "job_id": "string",
  "source_file": "tmp/uploads/<job_id>/original.mp3",
  "created_at": "ISO timestamp",
  "edits": [
    {
      "id": "edit_001",
      "type": "cut",
      "start_ms": 12400,
      "end_ms": 15800,
      "reason": "filler words",
      "source": "auto | agent | user"
    }
  ],
  "keep_segments": [
    { "start_ms": 0, "end_ms": 12400 },
    { "start_ms": 15800, "end_ms": 180000 }
  ]
}
```

`keep_segments` is always derived from `edits` — never store it separately, always recompute from the edit list.

---

## Chat-editing agent instructions

The agent's behavior is defined by the `instructions` array on the `editor_agent` (`agent_rocketride`)
component in `.rocketride/chat_editor.pipe` — not a Python-side system prompt. Do not change those
instructions without keeping this summary in sync:

- Always confirm before applying a cut larger than 60 seconds
- When the user references a time ("around 12 minutes"), find the nearest natural pause within ±30 seconds
- When the user describes content ("the part where I talked about X"), search the transcript text and show the matching segment before cutting
- Never cut mid-word. Always align to word boundaries returned by the transcript tools.
- After every edit, summarise what changed and the new output runtime

The agent has no direct transcript/EDL access — it reaches both only through the `tool_http_request` node
wired into its `control` array, which is whitelisted to `backend/api/routes/internal_tools.py`.

---

## Key dependencies and why

| Package | Why |
|---|---|
| `faster-whisper` | Local Whisper transcription, word timestamps, CPU/GPU |
| `noisereduce` | Spectral gating noise reduction, no training data needed |
| `pedalboard` | Spotify's audio DSP — compressor, noise gate, EQ |
| `ffmpeg-normalize` | Two-pass EBU R128 loudness normalisation, podcast preset |
| `pydub` | Audio segment manipulation, crossfade, concatenation |
| `numpy` | Zero-crossing detection |
| `celery[redis]` | Async task queue for long-running audio jobs |
| `sqlalchemy` + `psycopg` | Postgres job/transcript/EDL/chat state |
| `rocketride` | SDK client driving the chat-editing agent on the RocketRide engine |

---

## What is not in scope for v1

- Multi-speaker diarization (future: pyannote.audio)
- Video support
- Cloud storage (S3 / R2)
- User authentication
- Auphonic adaptive leveling (stubbed, available via API key)

<!-- ROCKETRIDE:BEGIN -->

# RocketRide — AI Pipeline Builder

Use RocketRide when building AI pipelines, document processing, RAG systems, or data integration.

## Documentation

Full docs: `.rocketride/docs/`

**Read the relevant doc(s) before generating any RocketRide code.**

| File                              | Read when...                                                      |
| --------------------------------- | ----------------------------------------------------------------- |
| ROCKETRIDE_README.md              | Starting any RocketRide work — overview + mandatory setup steps   |
| ROCKETRIDE_QUICKSTART.md          | Writing first pipeline — complete working examples (Python & TS)  |
| ROCKETRIDE_PIPELINE_RULES.md      | Defining pipelines — structure, lane wiring, config rules         |
| ROCKETRIDE_COMPONENT_REFERENCE.md | Choosing/configuring components — all providers and config fields |
| ROCKETRIDE_COMMON_MISTAKES.md     | Before finalizing — known pitfalls to avoid                       |
| ROCKETRIDE_python_API.md          | Python SDK — client methods, types, patterns                      |
| ROCKETRIDE_typescript_API.md      | TypeScript SDK — client methods, types, patterns                  |
| ROCKETRIDE_OBSERVABILITY.md       | Consuming runtime logs, lifecycle events, and pipeline traces     |

## Before Writing ANY RocketRide Code

1. Read `.rocketride/docs/ROCKETRIDE_README.md` for mandatory setup requirements
2. Read the relevant API doc (Python or TypeScript) for your language
3. Read `.rocketride/docs/ROCKETRIDE_PIPELINE_RULES.md` + `.rocketride/docs/ROCKETRIDE_COMPONENT_REFERENCE.md`
4. Read `.rocketride/docs/ROCKETRIDE_COMMON_MISTAKES.md` before finalizing
<!-- ROCKETRIDE:END -->
