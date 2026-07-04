# rocketride-podcasts

An end-to-end AI podcast audio editing application built on RocketRide's pipeline infrastructure.

## What it does

Upload a raw podcast recording and either:

1. **Auto-pilot mode** — the pipeline automatically transcribes, trims silence/fillers, reduces noise, normalises loudness, and adds your intro/outro. One click, broadcast-ready output.
2. **Chat editing mode** — talk to a RocketRide-native agent in plain English ("cut the part where I stumbled around 12 minutes in", "remove the tangent about X"). The agent edits a non-destructive Edit Decision List and renders only when you're happy.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, Tailwind CSS, shadcn/ui |
| API | FastAPI (Python 3.11+) |
| Task queue | Celery + Redis |
| Job/chat state | Postgres |
| Transcription | faster-whisper (local, CPU/GPU) |
| Noise reduction | noisereduce + Spotify Pedalboard |
| Loudness mastering | ffmpeg-normalize (EBU R128, podcast preset) |
| Audio editing | pydub + ffmpeg |
| Chat agent | `agent_rocketride` (Claude claude-sonnet-4-6) running on the RocketRide engine |
| Audio pipeline nodes | Plain Python classes orchestrated by Celery (not RocketRide engine nodes — see `docs/ARCHITECTURE.md`) |

The audio pipeline (transcribe → clean → render → master → brand-merge) runs on Celery, not the
RocketRide engine — that model fits its long-running, stateful, human-in-the-loop shape better than
RocketRide's streaming-filter node contract. The chat-editing agent runs on the real RocketRide engine
instead, since conversational Q&A is exactly what it's built for. See `docs/ARCHITECTURE.md` for the
full rationale.

## Project structure

```
rocketride-podcasts/
├── backend/
│   ├── api/              # FastAPI routes (incl. internal_tools.py for the chat agent)
│   ├── nodes/            # Audio pipeline node classes + the RocketRide-driving chat_editor_node
│   ├── workers/          # Celery task definitions
│   ├── db/               # Postgres models (Job, ChatTurn) + session
│   └── utils/            # Audio DSP helpers (crossfade, EDL, mastering)
├── frontend/
│   ├── app/              # Next.js App Router pages
│   ├── components/       # React components (editor, chat, upload)
│   └── lib/              # API client, types, helpers
├── assets/
│   ├── intro/            # Drop your intro.mp3 here
│   └── outro/            # Drop your outro.mp3 here
├── docs/                 # Architecture docs + celery_pipeline.json (non-executable reference)
├── .rocketride/          # chat_editor.pipe — the one real RocketRide pipeline this app runs
├── AGENTS.md             # Claude Code bootstrap — read this first
└── docker-compose.yml    # Redis + Postgres for local dev
```

## Quick start

The backend (API + Celery worker + Redis + Postgres) runs in Docker — the
pinned scientific packages (faster-whisper, pedalboard, noisereduce) want
Python 3.11, and containers avoid host-interpreter drift. The frontend runs
natively via `npm`.

### Prerequisites

- Docker + Docker Compose
- Node.js 20+ and `ffmpeg` on the host (for the frontend / local tinkering)
- RocketRide VS Code extension installed, with the RocketRide engine running locally
  (the app connects to it for chat-editing — see `.rocketride/chat_editor.pipe`)
- An Anthropic API key with credit (used by the `llm_anthropic` node inside `chat_editor.pipe`)

### 1. Clone and configure

```bash
git clone <your-repo>
cd rocketride-podcasts
cp .env.example .env
# Edit .env — set ROCKETRIDE_APIKEY and ROCKETRIDE_ANTHROPIC_KEY.
# ROCKETRIDE_URI defaults to the local engine; the api/worker containers
# override it to host.docker.internal automatically (see docker-compose.yml).
```

> **Ports:** compose maps Redis to host `6380` and Postgres to `5433` (not the
> defaults 6379/5432) to avoid colliding with other local projects. Container-to-
> container traffic still uses the standard internal ports.

### 2. Start the backend stack

```bash
docker compose up -d --build
# Brings up: redis, postgres, api (:8000), worker
docker compose ps                     # all should be Up / healthy
curl localhost:8000/api/health        # {"status":"ok"}
```

On first run the worker downloads the faster-whisper `medium` model
(~1.5 GB) the first time a job transcribes — subsequent runs are cached.

### 3. Start the frontend

```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000  (proxies /api and /ws to the backend on :8000)
```

### 4. Add your brand assets (optional)

Drop `intro.mp3` / `outro.mp3` into `assets/intro/` and `assets/outro/`. If
present, the pipeline crossfades them onto the episode and re-normalizes the
mix to spec; if absent, it skips them without erroring.

### 5. Run the tests

```bash
docker compose run --rm api pytest tests/
```

## Audio pipeline nodes (Celery-orchestrated)

These are plain Python classes in `backend/nodes/`, chained by Celery tasks in `backend/workers/tasks.py`.
`docs/celery_pipeline.json` documents the wiring for reference — it is not a RocketRide `.pipe` file and
is not executed by the RocketRide engine.

| Node | File | Purpose |
|---|---|---|
| `TranscriptionNode` | `nodes/transcription_node.py` | faster-whisper, word-level timestamps |
| `AutoCleanupNode` | `nodes/auto_cleanup_node.py` | Silence/filler detection, auto EDL |
| `AudioDSPNode` | `nodes/audio_dsp_node.py` | Crossfade, zero-crossing cuts, pydub rendering |
| `MasteringNode` | `nodes/mastering_node.py` | noisereduce + Pedalboard + ffmpeg-normalize |
| `BrandMergeNode` | `nodes/brand_merge_node.py` | Intro/outro stitching |

## Chat-editing agent (real RocketRide pipeline)

Open `.rocketride/chat_editor.pipe` in VS Code with the RocketRide extension to view the visual
pipeline: `chat` source → `agent_rocketride` (wired to `llm_anthropic`, `memory_internal`, and
`tool_http_request`) → `response_answers`. `backend/nodes/chat_editor_node.py` starts this pipeline via
the `rocketride` Python SDK and relays each chat turn to it. The agent never holds transcript/EDL state
itself — it calls back into `/api/internal/tools/*` (`backend/api/routes/internal_tools.py`), which reads
and mutates the same Postgres-backed EDL the render pipeline uses.

## Auphonic (optional upgrade)

Set `AUPHONIC_API_KEY` in `.env` to route mastering through Auphonic instead of the local stack. The `MasteringNode` detects the key and switches automatically.

## Loudness targets

| Platform | Target LUFS | True peak |
|---|---|---|
| Spotify Podcasts | -14 LUFS | -1 dBTP |
| Apple Podcasts | -16 LUFS | -1 dBTP |
| Default (this app) | -16 LUFS | -1 dBTP |
