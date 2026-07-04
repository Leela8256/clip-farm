# rocketride-podcasts

An end-to-end AI podcast audio editing application built on RocketRide's pipeline infrastructure.

## What it does

Upload a raw podcast recording and either:

1. **Auto-pilot mode** — the pipeline automatically transcribes, trims silence/fillers, reduces noise, normalises loudness, and adds your intro/outro. One click, broadcast-ready output.
2. **Chat editing mode** — talk to a Claude-powered agent in plain English ("cut the part where I stumbled around 12 minutes in", "remove the tangent about X"). The agent edits a non-destructive Edit Decision List and renders only when you're happy.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, Tailwind CSS, shadcn/ui |
| API | FastAPI (Python 3.11+) |
| Task queue | Celery + Redis |
| Transcription | faster-whisper (local, CPU/GPU) |
| Noise reduction | noisereduce + Spotify Pedalboard |
| Loudness mastering | ffmpeg-normalize (EBU R128, podcast preset) |
| Audio editing | pydub + ffmpeg |
| Chat agent | Claude claude-sonnet-4-6 via Anthropic API |
| Pipeline nodes | RocketRide Python-extensible nodes |

## Project structure

```
rocketride-podcasts/
├── backend/
│   ├── api/              # FastAPI routes
│   ├── nodes/            # RocketRide custom pipeline nodes
│   ├── workers/          # Celery task definitions
│   └── utils/            # Audio DSP helpers (crossfade, EDL, mastering)
├── frontend/
│   ├── app/              # Next.js App Router pages
│   ├── components/       # React components (editor, chat, upload)
│   └── lib/              # API client, types, helpers
├── assets/
│   ├── intro/            # Drop your intro.mp3 here
│   └── outro/            # Drop your outro.mp3 here
├── docs/                 # Architecture and node documentation
├── .rocketride/          # RocketRide pipeline definitions (*.pipe)
├── AGENTS.md             # Claude Code bootstrap — read this first
└── docker-compose.yml    # Redis + optional containerised run
```

## Quick start

### Prerequisites

- Python 3.11+
- Node.js 20+
- Redis (local or Docker)
- ffmpeg installed (`brew install ffmpeg` / `apt install ffmpeg`)
- Anthropic API key
- RocketRide VS Code extension installed

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
# Edit .env — add your ANTHROPIC_API_KEY at minimum
```

### 4. Start Redis

```bash
docker-compose up redis -d
# OR if Redis is installed locally:
redis-server
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

## RocketRide pipeline nodes

Open `rocketride-podcasts.pipe` in VS Code with the RocketRide extension to view the visual pipeline. Custom nodes are in `backend/nodes/` and follow the RocketRide Python-extensible node contract.

| Node | File | Purpose |
|---|---|---|
| `TranscriptionNode` | `nodes/transcription_node.py` | faster-whisper, word-level timestamps |
| `AutoCleanupNode` | `nodes/auto_cleanup_node.py` | Silence/filler detection, auto EDL |
| `ChatEditorNode` | `nodes/chat_editor_node.py` | Claude agent, conversational EDL editing |
| `AudioDSPNode` | `nodes/audio_dsp_node.py` | Crossfade, zero-crossing cuts, pydub rendering |
| `MasteringNode` | `nodes/mastering_node.py` | noisereduce + Pedalboard + ffmpeg-normalize |
| `BrandMergeNode` | `nodes/brand_merge_node.py` | Intro/outro stitching |

## Auphonic (optional upgrade)

Set `AUPHONIC_API_KEY` in `.env` to route mastering through Auphonic instead of the local stack. The `MasteringNode` detects the key and switches automatically.

## Loudness targets

| Platform | Target LUFS | True peak |
|---|---|---|
| Spotify Podcasts | -14 LUFS | -1 dBTP |
| Apple Podcasts | -16 LUFS | -1 dBTP |
| Default (this app) | -16 LUFS | -1 dBTP |
