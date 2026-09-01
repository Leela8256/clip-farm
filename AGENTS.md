# AGENTS.md — rocketride-podcasts

Read this before changing anything. It is the contract the code follows.

## What this project is

Clip Farm: a podcast episode goes in; explainable clip candidates, directed clips from a
plain-language request (Prompt Director), previews and finished vertical/wide exports come
out. **All processing runs on the RocketRide engine as pipelines**; the frontend is a
static Next.js site using the `rocketride` SDK in the browser. There is no backend of ours
— no API server, no Celery, no database. The only service next to the engine is the
transcript index (Qdrant via docker-compose; `rocketride_vector` in a hosted deployment).
Everything a project needs lives in the account file store under `projects/<episode>/`
(see `docs/ARCHITECTURE.md`).

## Golden rule: stock nodes first

Use a stock node whenever one does the job (`audio_transcribe`, `embedding_transformer`,
`qdrant`, `llm_anthropic`, `response_*`, later `frame_grabber` / `face_detection`,
`summarization`, `db_*`). `docs/NODE_CATALOG.md` is the map of what exists; consult it
before writing a node. A custom node is justified only for podcast-specific logic no stock
node performs (timestamp reconstruction, constraint enforcement, word-level editing,
ffmpeg rendering). Prompt engineering is client-side (`frontend/lib/prompts/director.json`,
shared with `tools/prompts.py`) so the pipelines stay stock all the way to the LLM.

## Hard constraints — never violate these

### Pipelines and nodes (`.rocketride/*.pipe`, `local_nodes/`)

- Every custom node declares what it imports in its `requirements.txt` (`av`,
  `imageio-ffmpeg`, `faster-whisper`, …); the engine's `depends()` installs them into the
  engine runtime when the node loads. Keep the list minimal and unpinned — a fresh prebuilt
  engine ships only numpy, so nothing may be assumed present.
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
- The LLM only sees a document's `page_content`: anything the model must know (timestamps,
  ids) is inlined in the text. Index passages are `[mm:ss - mm:ss] sentence` lines with
  `objectId = episode id`; searches scope with `filter.objectIds`.
- A stock store forwards the client's Question unchanged (plus documents). Do not put a
  `prompt` node after the store — it rebuilds the question and drops `expectJson`/`role`.
- Every node reports progress with `update_status()` (status.json + SSE type `podcast`) and
  records failures as `stage: "error"` before raising.
- Hard constraints are enforced before ranking (`podcast_common/constraints.py`), and a
  constraint that cannot be verified is reported as `null` + a warning — never asserted.
- Duration fitting never cuts through a spoken word (`podcast_common/editing.py`); cuts that
  fail a safety rule are muted or kept, and every planned cut has an id the user can restore.
- Edits are non-destructive: `edits/clip-edits.json` (schema 2) is the only place user
  changes live; candidates and request files are never rewritten by the UI. Revisions append
  versions; the base record and the candidate stay intact.
- Schemas carry `schema_version`; bump it when a file's shape changes and keep readers
  tolerant (`analysis/clips/<id>.json` is still read as a fallback for plan.json).

- Stock nodes that declare the `debug` capability (`face_detection`, `caption`, …) are skipped
  by release engines (`services.cpp` drops them under `NDEBUG`) — "service not found" at run
  time. Use `pose_estimation` for faces (keypoints → face box in `visual.faces_from_persons`).
- Vision nodes get a small copy of the clip (640 px wide, 10 fps, `media.slice_video_for_detection`)
  streamed on the `video` lane, never the full-size source; frames are joined to time through
  the `frame_grabber` table (ordinal → seconds), falling back to the sample interval.
- The layout plan is data (`analysis/clips/<id>/layout.json`, schema 1) rendered with per-frame
  `sendcmd` crop commands + `crop@label=…:exact=1`, `vstack`/`hstack` panels; every layout
  segment holds ≥ 2 s, crop paths are EMA-smoothed with a pan cap, and `face_safe` counts frames
  where a face touches a crop edge. Producer overrides (`layout:`, `subject:`) win over the plan.

### Frontend (`frontend/`)

- Browser-only and fully static (`output: "export"`): the SDK talks to the engine directly;
  no `/api` routes, no server actions, no dynamic `[param]` routes (use query params such as
  `/episode?id=…` behind a `Suspense` boundary). `npm run build` must keep producing `out/`.
- `lib/podcast.ts` and `lib/director.ts` stay free of SDK imports (unit-tested); `lib/engine.ts`
  is the only module that touches the SDK. Pipeline JSON in `lib/pipelines/` must mirror
  `.rocketride/*.pipe`; prompt text lives in `lib/prompts/director.json` and is read by both
  the browser and `tools/prompts.py`.
- Video players are plain `<video controls playsInline>` with the file's own audio — never
  `muted`, never autoplay. Show the render report's audio line next to a player.
- No `setState` synchronously inside `useEffect` bodies (lint rule); defer with a timeout or
  do it in async callbacks. Keep `react-hooks` lint clean (don't name handlers `use*`).
- Keep the design tokens in `app/design-tokens.css` as the source of truth for colours/type, and build
  from its primitives (`.rr-card`, `.rr-btn*`, `.rr-chip*`, `.rr-input/.rr-select/.rr-textarea`, `.rr-field`,
  `.rr-progress`, `.rr-skeleton`, `.rr-enter`) so every screen feels like one product.
- Product structure: three independent workflows — Create Clips (/episode), Episode Editor (/studio),
  AI Reframe (/reframe) — entered from My Projects (/projects). They share media/alignment/rendering and
  the store but never each other's state; brand templates apply to any of them via a resolved snapshot
  (`{id, revision, hash, resolved}`) stamped into the plan/spec — nodes never re-read templates.
- Studio preview tiers: instant (browser, no render) · standard (≤1280, crf 22, veryfast, stereo, no
  mastering, cached by spec hash) · range (≤1920×1080, crf 19, full chain) · export (`size:` 720|1080|source,
  default 1080). Every render report carries a measured `quality` block; never fake a control that the
  render spec cannot see.
- The UI never names the machinery: no "RocketRide", "engine", "Claude", "pipeline", "node", "store",
  "index" in user-facing text (say "the director", "your library", "transcript search", "analysing").
  `describeStatus()` wording follows the same rule; the sidebar dot is the only connection indicator.
- The dev server (`next dev`) does not open the SDK socket in headless tests; browser tests
  run against the static build (`npm run build && npx serve out`).

### Media

- Loudness target −16 LUFS integrated / −1 dBTP (two-pass loudnorm); captions are burned in
  from word timestamps mapped through the keep segments (`TimelineMap`); audio and video are
  cut from the same keep list so they never drift; mutes are applied on the source timeline.
- Concatenate with `trim`/`concat` — chained `xfade` truncates after the second segment.
- Every reframed piece ends with `setsar=1` before `concat`: `scale` compensates a crop window
  that is not exactly the output aspect with its own pixel aspect, and `concat` rejects inputs
  whose SARs differ (it only bites when a plan mixes crop sizes — solo close-ups + stacked panels).

### Podcast Editing Studio (full-episode editor)

- The studio is instructions-only: the browser owns `edits/episode-edits.json` (schema 1, integer ms,
  ops cut/mute/bleep/shorten_silence with `enabled` for restore; speakers, sections, assets, audio/visual
  settings; snapshots in `edits/versions/NNN.json`). Nodes read it, never write it.
- `podcast_prepare_clip` branches on the `studio:` context key: `init` aligns the whole episode in ~60 s
  pieces and writes `analysis/studio/{timeline,waveform,suggestions}.json` (suggestions are deterministic,
  nested natural ⊆ balanced ⊆ tight, never auto-applied); `preview|export` turns the edits into
  `analysis/studio/prepared-v<version>.json` (keep/mutes/bleeps, source↔output map, captions on the output
  timeline, chapters, verified assets). The clip flow (no `studio:` key) is untouched.
- `podcast_render` routes on `spec.studio` BEFORE the clip check (the studio spec carries `clip_id` too),
  takes mode from `spec.mode`/`spec.studio` (never the node config), and renders: rough (640px whole episode),
  range (slice with full mastering), export (`exports/studio/v<version>/`: 1080p mp4 + extra aspects +
  mp3/wav + srt/vtt + ffmetadata & json chapters + report; resumable ~5 min parts keyed by a spec hash;
  intro/title card/body/end card/outro concat; music ducked with sidechaincompress; bleep = 1 kHz sine).
- Caption groups in the spec are line dicts `{start_ms, end_ms, text, speaker, words:[{w,s,e}]}` — renderer
  and clients must accept that shape (and the flat word list) — see `_studio_captions`.

## File map

```
.rocketride/episode-analysis.pipe    chat → podcast_ingest → audio_transcribe → podcast_segment → llm_anthropic → podcast_refine → response_answers
.rocketride/transcript-index.pipe    chat → podcast_ingest → podcast_segment → embedding_transformer → qdrant (+ response_text)
.rocketride/transcript-search.pipe   chat → embedding_transformer → qdrant → response_documents
.rocketride/director-chat.pipe       chat → llm_anthropic → response_answers (parse, revise)
.rocketride/prompt-director.pipe     chat → embedding_transformer → qdrant → llm_anthropic → podcast_refine → response_answers
.rocketride/prompt-director-full.pipe chat → llm_anthropic → podcast_refine → response_answers (no index)
.rocketride/podcast-studio-prepare.pipe   chat → podcast_prepare_clip (studio: init | spec) → response_answers
.rocketride/podcast-studio-preview.pipe   chat → podcast_prepare_clip → podcast_render (rough/range) → response_answers
.rocketride/podcast-studio-export.pipe    chat → podcast_prepare_clip → podcast_render (episode export) → response_answers
.rocketride/visual-scan.pipe         chat → podcast_ingest → frame_grabber → pose_estimation → podcast_visual → response_answers
.rocketride/clip-preview.pipe        chat → podcast_prepare_clip → (frame_grabber → pose_estimation) → podcast_layout → podcast_render[preview] → response_answers
.rocketride/clip-export.pipe         chat → podcast_prepare_clip → (frame_grabber → pose_estimation) → podcast_layout → podcast_render[export] → response_answers
local_nodes/podcast_common/          store · cache · project · media · clips · spec · constraints · editing · passages · captions · align · visual · config
local_nodes/podcast_*/               services.json · IGlobal.py · IInstance.py (one class each)
local_nodes/tests/                   python -m unittest discover -s local_nodes/tests
frontend/app/layout.tsx              shell: sidebar navigation (New episode · Clip Studio · History), toasts
frontend/app/page.tsx                home: upload only
frontend/app/projects/page.tsx       My Projects: every uploaded project, search/sort/filters, collections, multi-select batches
frontend/app/history/page.tsx        compatibility redirect to /projects
frontend/app/brands/page.tsx         brand template grid; app/brand/page.tsx — template editor + caption designer
frontend/app/reframe/page.tsx        AI Reframe: clip / range → platform layouts (9:16, 4:5, 1:1, 16:9)
frontend/app/studio/page.tsx         Podcast Studio (/studio?id=…): transcript-first full-episode editor
frontend/components/studio/          StudioCanvas · TranscriptEditor · TimelineBar · Inspector · SuggestionsPanel · helpers
frontend/app/episode/page.tsx        Clip Studio (/episode?id=…): map, Direct / Moments / Transcript tabs, sticky preview column, keyboard (R, [, ], Space, Esc)
frontend/components/shell/           Sidebar (owns the connection + retry) · Toasts (`toast()`)
frontend/components/history/         RunRow · RunThumb · HistorySkeleton
frontend/lib/studio.ts + studio-engine.ts  episode-edit model (undo/redo, suggestions, map) + studio SDK calls
frontend/lib/library.ts              My Projects listing, collections (library/collections), project writers — fail-closed
frontend/lib/brand.ts                brand templates (brand-templates/<id>/), CaptionStyle + 9-gallery presets, resolveBrand hash
frontend/lib/batch.ts                multi-project clip batches (library/batches), parse-once + bounded pool of 2
frontend/components/podcast/         NewEpisodeForm · StatusTimeline · PromptDirector · ChapterStrip · CandidateCard · ClipWorkbench · SoundTools · ComplianceBadges · TranscriptPanel
frontend/lib/engine.ts               connection, store helpers, pipeline runs (analysis, index, visual scan, search, parse, director, revise, clips)
frontend/lib/podcast.ts              types, manifest/report normalisation, status text, formatting
frontend/lib/director.ts             spec normalisation, duration windows, question builders, revisions, compliance badges
frontend/lib/prompts/director.json   the prompt text (parse / direct / revise) shared with tools/prompts.py
tools/podcast_run.py                 CLI driver (analyze / index / visual / search / parse / direct / revise / preview / export / status / get / ls)
tools/prompts.py                     Python twin of the question builders
tools/engine.sh                      run the engine as a service from the sibling server clone
docs/ARCHITECTURE.md                 the long version of all of the above
docs/NODE_CATALOG.md                 every stock node and where it fits the roadmap
```

## Testing

- `python3 -m unittest discover -s local_nodes/tests -v` — pure logic, no engine (spec,
  constraints, editing, clips, captions, visual: tracking, talking cue, planning, crop paths).
- `cd frontend && npm run lint && npm test && npm run build`.
- End to end: `tools/engine.sh start` (engine with `--node_path=<repo>`), `docker compose up -d
  qdrant`, then `tools/podcast_run.py analyze|index|search|parse|direct|revise|preview|export`
  on a short recording (a 10-minute file: analysis ≈ 100 s, index ≈ 1 s, visual ≈ 20 s,
  direct ≈ 30 s, preview ≈ 25 s). Check exports with `ffprobe` (h264 + AAC stereo, expected
  dimensions), the report's loudness, `compliance.json` (`duration_met` in strict mode, the
  `visual` block) and the preview's `layout` summary (people, segments, `face_cut_violations`).
  Grab a frame of the vertical render and look at it — a face-safe metric is not a picture.
- Browser: build, `npx serve -l 3006 out`, headless Chrome on :9222, drive the page with a
  CDP script (parse → find → preview → revise).

## Not in scope yet

Speaker diarization (identity-linked active speaker), brand kits / compilations (phase 3),
full-episode transcript editing (phase 4), content packs and cross-episode search (phase 5).

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
