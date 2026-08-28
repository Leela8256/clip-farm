# AGENTS.md — rocketride-podcasts

Read this before changing anything. It is the contract the code follows.

## What this project is

Clip Farm: a podcast episode goes in, explainable clip candidates, previews and finished
vertical/wide exports come out. **All processing runs on the RocketRide engine as pipelines**;
the frontend is a static Next.js site using the `rocketride` SDK in the browser. There is no
backend of ours — no API server, no Celery, no database. Everything a project needs lives in
the account file store under `projects/<episode>/` (see `docs/ARCHITECTURE.md`).

## Hard constraints — never violate these

### Pipelines and nodes (`.rocketride/*.pipe`, `local_nodes/`)

- Use **stock nodes wherever one exists** (`audio_transcribe`, `llm_anthropic`, later
  `frame_grabber`/`face_detection`, `db_*`). Custom nodes stay small and podcast-specific.
- Every custom node declares what it imports in its `requirements.txt` (`av`, `imageio-ffmpeg`,
  `faster-whisper`, …); the engine's `depends()` installs them into the engine runtime when the
  node loads, under the engine's own constraints. Keep the list minimal and unpinned — a fresh
  prebuilt engine ships only numpy, so nothing may be assumed present.
- Never map account-store paths to disk. Read/write through the store API
  (`podcast_common/store.py`); cache the source locally through `podcast_common/cache.py`.
- Secrets never reach the browser. The Anthropic key is `${ROCKETRIDE_ANTHROPIC_KEY}` in the
  pipe and is substituted by the engine from its environment. Do not print or log keys.
- The stock transcriber stamps sentences relative to the audio buffer it flushed. Keep the
  ingest node's piece-based hand-off (pieces < 60 s, one `writeAudio` stream each) and derive
  absolute times from `metadata.source.stream_index` + the piece offsets in the episode
  reference. Do not "fix" this by trusting `time_stamp` alone.
- The `answers` lane carries every answer written along the path (the LLM's raw answers reach
  the response node too). Clients pick the manifest by shape (last payload with `project`).
- Every node reports progress with `update_status()` (status.json + SSE type `podcast`) and
  records failures as `stage: "error"` before raising.
- Edits are non-destructive: `edits/clip-edits.json` is the only place user changes live;
  candidates.json is never rewritten by the UI.
- Schemas carry `schema_version`; bump it when a file's shape changes and keep readers tolerant.

### Frontend (`frontend/`)

- Browser-only and fully static (`output: "export"`): the SDK talks to the engine directly;
  no `/api` routes, no server actions, no dynamic `[param]` routes (use query params such as
  `/episode?id=…` behind a `Suspense` boundary). `npm run build` must keep producing `out/`.
- `lib/podcast.ts` stays free of SDK imports (unit-tested); `lib/engine.ts` is the only module
  that touches the SDK. Pipeline JSON in `lib/pipelines/` must mirror `.rocketride/*.pipe`.
- Video players are plain `<video controls playsInline>` with the file's own audio — never
  `muted`, never autoplay. Show the render report's audio line next to a player.
- No `setState` synchronously inside `useEffect` bodies (lint rule); defer with a timeout or
  do it in async callbacks. Keep `react-hooks` lint clean.
- Keep the design tokens in `app/design-tokens.css` as the source of truth for colours/type.

### Media

- Loudness target −16 LUFS integrated / −1 dBTP (two-pass loudnorm); captions are burned in
  from word timestamps mapped through the keep segments (`TimelineMap`); audio and video are
  cut from the same keep list so they never drift.
- Concatenate with `trim`/`concat` — chained `xfade` truncates after the second segment.

## File map

```
.rocketride/episode-analysis.pipe   chat → podcast_ingest → audio_transcribe → podcast_segment → llm_anthropic → podcast_refine → response_answers
.rocketride/clip-preview.pipe       chat → podcast_prepare_clip → podcast_render[preview] → response_answers
.rocketride/clip-export.pipe        chat → podcast_prepare_clip → podcast_render[export] → response_answers
local_nodes/podcast_common/         store · cache · project · media · clips · captions · align · config
local_nodes/podcast_*/              services.json · IGlobal.py · IInstance.py (one class each)
local_nodes/tests/                  python -m unittest discover -s local_nodes/tests
frontend/app/page.tsx               library + new episode
frontend/app/episode/page.tsx       workspace (/episode?id=…)
frontend/nginx.conf, Dockerfile     static export served by nginx (no Node server at runtime)
frontend/components/podcast/        EngineBadge · NewEpisodeForm · StatusTimeline · ChapterStrip · CandidateCard · ClipWorkbench · TranscriptPanel
frontend/lib/engine.ts              connection, store helpers, runAnalysis/runClip, background runs
frontend/lib/podcast.ts             types, manifest/report normalisation, status text, formatting
tools/podcast_run.py                CLI driver (analyze / preview / export / status / get / ls)
docs/ARCHITECTURE.md                the long version of all of the above
```

## Testing

- `python3 -m unittest discover -s local_nodes/tests -v` — pure logic, no engine.
- `cd frontend && npm run lint && npm test && npm run build`.
- End to end: start the engine with `--node_path=<repo>` and run `tools/podcast_run.py` or
  the UI on a short recording (a 60 s file analyses in ~20 s). Check exports with `ffprobe`
  (h264 + AAC stereo, expected dimensions) and the report's loudness.

## Not in scope for v1

Speaker diarization, face-tracking 9:16 reframe (planned Stage 1B via stock
`frame_grabber` + `face_detection`), music beds, a database index of projects, cloud deployment.

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
