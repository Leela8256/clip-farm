# AGENTS.md — rocketride-podcasts

Claude Code reads this file at session start. Follow every constraint here before writing or editing any code.

---

## What this project is

An end-to-end AI podcast audio editing app with two modes:
1. **Auto-pilot** — fully automated pipeline (transcribe → clean → master → merge brand assets)
2. **Chat editing** — Claude agent edits a non-destructive Edit Decision List via conversation

Built on RocketRide's Python-extensible node architecture with a Next.js frontend and FastAPI + Celery backend.

---

## Hard constraints — never violate these

### RocketRide nodes
- Nodes live in `backend/nodes/`. Every node is a Python class only — no C++ runtime changes ever.
- Each node must implement `execute(self, inputs: dict) -> dict` and return a dict of named outputs.
- Nodes communicate via typed lane values (text, file paths, JSON). Never pass raw audio bytes between nodes — use file paths stored in `tmp/`.
- Node dependencies go in `backend/requirements.txt`, not anywhere else.

### Audio processing
- Never modify the original uploaded file. Always copy to `tmp/<job_id>/` first.
- The Edit Decision List (EDL) is the single source of truth. The audio render step reads the EDL and produces output — nothing else mutates audio directly.
- All cuts must use zero-crossing snapping + crossfade (see `backend/utils/dsp.py`). Hard cuts are not acceptable.
- Loudness target: **-16 LUFS, -1 dBTP true peak** (AES podcast standard). Do not change this default.

### API
- All long-running work (transcription, processing, mastering) must go through Celery tasks. Never run blocking audio work inside a FastAPI route directly.
- Job status is polled via `GET /api/jobs/{job_id}/status`. WebSocket upgrade is future scope.
- File uploads are stored in `tmp/uploads/`. Processed outputs go to `tmp/outputs/`.

### Frontend
- Use shadcn/ui components. Do not introduce other UI libraries.
- API calls go through `frontend/lib/api.ts` — never call fetch directly in components.
- The transcript editor must render word-level timestamps from the transcription response.
- Chat history is kept in React state, not persisted to a database (v1 scope).

### Environment
- All secrets come from `.env` (see `.env.example`). Never hardcode API keys.
- `ANTHROPIC_API_KEY` is required. `AUPHONIC_API_KEY` is optional — mastering falls back to local stack if not set.
- Redis must be running before starting the Celery worker.

---

## File map — where things live

```
backend/
  api/
    main.py          # FastAPI app entry point
    routes/
      jobs.py        # POST /api/jobs, GET /api/jobs/{id}/status
      audio.py       # POST /api/upload, GET /api/download/{id}
      chat.py        # POST /api/chat/{job_id}
  nodes/
    transcription_node.py
    auto_cleanup_node.py
    chat_editor_node.py
    audio_dsp_node.py
    mastering_node.py
    brand_merge_node.py
  workers/
    celery_app.py    # Celery + Redis config
    tasks.py         # Task definitions (run_autopilot, render_edl)
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
  podcast_pipeline.pipe   # RocketRide pipeline definition
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

## Claude agent system prompt (chat editing mode)

The agent in `nodes/chat_editor_node.py` uses this system prompt. Do not change it without updating this file too:

```
You are a podcast audio editor assistant. You have access to a full transcript with word-level timestamps.

Your job is to help the user edit their podcast by modifying an Edit Decision List (EDL).
You can only call the tools available to you — you cannot play audio or see waveforms.

Rules:
- Always confirm before applying a cut larger than 60 seconds
- When the user references a time ("around 12 minutes"), find the nearest natural pause within ±30 seconds
- When the user describes content ("the part where I talked about X"), search the transcript text and show them the matching segment before cutting
- Never cut mid-word. Always find the nearest word boundary.
- After every edit, summarise what changed and what the new runtime will be
```

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
| `anthropic` | Claude API for chat editing agent |

---

## What is not in scope for v1

- Multi-speaker diarization (future: pyannote.audio)
- Video support
- Cloud storage (S3 / R2)
- User authentication
- Persistent database (jobs are in-memory + filesystem only)
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
