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

### Prerequisites

- Python 3.11+
- Node.js 20+
- Redis + Postgres (local or Docker)
- ffmpeg installed (`brew install ffmpeg` / `apt install ffmpeg`)
- RocketRide VS Code extension installed, with the RocketRide engine running locally
  (this app connects to it for chat-editing — see `.rocketride/chat_editor.pipe`)
- Anthropic API key (used by the `llm_anthropic` node inside `chat_editor.pipe`)

### 1. Clone and install

```bash
git clone <your-repo>
cd rocketride-podcasts
```

### 2. Backend setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Environment variables

```bash
cp .env.example .env
# Edit .env — add ROCKETRIDE_APIKEY and ROCKETRIDE_ANTHROPIC_KEY at minimum
# (ROCKETRIDE_URI/APIKEY are auto-populated by the RocketRide VS Code extension
# when the engine is running locally)
```

### 4. Start Redis and Postgres

```bash
docker-compose up redis postgres -d
# OR if installed locally:
redis-server
pg_ctl start   # or your platform's Postgres start command
```

### 5. Start the Celery worker

```bash
cd backend
celery -A workers.celery_app worker --loglevel=info
```

### 6. Start the FastAPI server

```bash
cd backend
uvicorn api.main:app --reload --port 8000
```

### 7. Start the frontend

```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

### 8. Add your brand assets

Drop your `intro.mp3` and `outro.mp3` into `assets/intro/` and `assets/outro/` respectively. The pipeline will automatically stitch them.

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
