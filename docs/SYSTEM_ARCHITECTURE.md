# Clip Farm — System Architecture

Status: current as of 2026-09-15 · Scope: the whole product, not one pipeline
Companion: [PIPELINE_ATLAS.md](PIPELINE_ATLAS.md) (pipe-by-pipe and node-by-node detail)

---

## 1. What the system is

A podcast recording goes in. Out come scored clip candidates with reasons, clips directed by
a plain-language request, a full-episode transcript editor, and finished vertical / wide
renders with burned-in captions and mastered sound.

Three independent workflows sit on one shared spine:

| Workflow | Route | What it produces |
|---|---|---|
| Create Clips | `/episode` | candidates → previews → exports (9:16, 4:5, 1:1, 16:9) |
| Episode Editor | `/studio` | a whole edited programme: mp4 + mp3/wav + captions + chapters |
| AI Reframe | `/reframe` | one clip or range re-framed into platform shapes |

entered from **My Projects** (`/projects`), with **Brands** (`/brands`) supplying reusable
looks and multi-project **batches** running the same request across recordings.

### The five architectural commitments

Everything below follows from these. They are constraints, not preferences.

1. **All processing runs on the RocketRide engine as pipelines.** No processing of ours runs
   anywhere else.
2. **No backend of our own.** No API server, no queue, no database, no cron. The browser is
   the orchestrator.
3. **The account file store is the state.** Every durable fact lives in a file under
   `projects/<episode>/`. Reopening a project rebuilds the workspace from those files.
4. **Stock nodes first.** A custom node is justified only for logic no stock node performs.
   The five that remain are on a path to being upstreamed or deleted.
5. **Measured, never claimed.** Loudness, duration and dimensions in a report are read off
   the finished file. A fact the system cannot verify is reported as `null` with a warning.

---

## 2. Context view

```
                          ┌──────────────────────────────────────────┐
  Producer  ─────────────►│                                          │◄──── Recording
  (browser, no login yet) │            C L I P   F A R M             │      mp4 / mov / mp3 / wav
                          │   clip discovery · episode editing ·     │      uploaded by the producer
  Developer / CI ────────►│   reframing · brand looks · exports      │
  (tools/podcast_run.py)  │                                          │
                          └───┬────────────┬─────────────┬───────────┘
                              │            │             │
                  Claude via  │            │ embeddings  │ media I/O, files
                  llm_anthropic            │ + search    │
                              ▼            ▼             ▼
                    ┌──────────────┐ ┌───────────┐ ┌──────────────────┐
                    │ Anthropic API│ │  Qdrant   │ │ Account file     │
                    │ sonnet-4-6   │ │ :6333     │ │ store (engine)   │
                    └──────────────┘ └───────────┘ └──────────────────┘
```

External dependencies are deliberately few: one model provider, one vector store (swappable
for the stock `rocketride_vector`), and the engine's own file store. There is no CDN, no
object-storage account, no auth provider and no third-party media service.

---

## 3. Container view

```
              ── trust boundary: nothing below the line ever reaches the browser ──

┌───────────────────────────────┐                      ┌──────────────────────────────────────┐
│  Browser app                  │   WebSocket (SDK)    │  RocketRide engine                   │
│  Next.js static export        │─────────────────────►│  ./engine ai/eaas.py                 │
│  served by nginx :3000        │  chat(question+ctx)  │  --node_path=<repo>  127.0.0.1:5567  │
│                               │◄─────────────────────│                                      │
│  · orchestrates every run     │  SSE type 'podcast'  │  · loads stock + custom nodes        │
│  · owns ranking + prompts     │                      │  · substitutes ${ROCKETRIDE_*} from  │
│  · owns the edit model        │   fs_open/write/read │    ITS OWN environment               │
│  · renders the UI             │─────────────────────►│  · one process, in-process nodes     │
│                               │   fs_geturl → JWT    │                                      │
└───────────────────────────────┘                      └───────────────┬──────────────────────┘
        │                                                              │
        │  GET /task/fetch?token=…  (Range-capable, signed, expiring)  │ Store.engine_file_store()
        │◄─────────────────────────────────────────────────────────────┤
        │                                                              ▼
        │                                              ┌──────────────────────────────────────┐
        └─────────────────────────────────────────────►│ Account file store                   │
                                                       │ projects/ · brand-templates/ ·       │
┌───────────────────────────────┐                      │ library/                             │
│  CLI  tools/podcast_run.py    │─── same pipes, ─────►│ local disk or object storage         │
│  (dev + E2E only)             │    same store        └──────────────────────────────────────┘
└───────────────────────────────┘

   Secrets live only in the engine's env:  ROCKETRIDE_ANTHROPIC_KEY · RR_SIGNING_KEY · ROCKETRIDE_APIKEY
```

| Container | Runtime | Responsibility | Does **not** |
|---|---|---|---|
| Browser app | Static HTML/JS, any host | Orchestration, ranking, prompts, edit model, UI, registries | touch ffmpeg, models or keys |
| Engine | One process, `--node_path` | Run pipelines; media, models, store access | know our folder layout (generic nodes) or our product rules |
| File store | Engine-managed | Durable state and deliverables | get addressed by disk path — ever |
| Qdrant | Docker service | Transcript passages, one collection, filtered per episode | hold anything but passages |
| Anthropic | SaaS | Scoring, parsing, directed discovery, revisions, proposals | see the key from the browser |
| CLI | Python + SDK | Drive the same pipelines for tests and headless runs | exist in production |

**Why the browser orchestrates.** Every alternative needs a server we said we would not run.
The cost is honest: work stops if the tab closes mid-call, so the long stages are made
resumable (§7) rather than pretending otherwise.

---

## 4. Component view

### 4.1 Engine side — four stages, ten providers

```
  INGEST                UNDERSTAND                    PLAN                    RENDER
  ──────                ──────────                    ────                    ──────
  media_io      ──►  audio_transcribe          ──►  podcast_segment   ──►  media_render
  [generic]          [stock, whisper medium]        [glue]                 [generic]
   probe             embedding_transformer+qdrant    podcast_prepare_clip
   piece feed        [stock]                         [glue]
   detect copy       pose_estimation+frame_grabber   speaker_framing
   slice             [stock]                         [generic]
                     llm_anthropic [stock]
```

| Component | Kind | Owns |
|---|---|---|
| `media_io` | custom, generic | Reading one file from the store and shaping it for the next node: probe, ≤58 s transcriber pieces, 640 px detection copy, range slice |
| `podcast_segment` | custom, glue | Absolute sentence times, the transcript record, the scoring questions, the index passages |
| `podcast_prepare_clip` | custom, glue | What to render: candidate/edit resolution, word alignment, safe cuts, duration fit, and the generic render spec (clip **and** whole episode) |
| `speaker_framing` | custom, generic | Framing decisions: tracks, who is talking, dwell-limited layouts, smoothed face-safe crop paths; episode people + shot scan |
| `media_render` | custom, generic | Executing one edit-decision spec with ffmpeg: cuts, mastering, captions, crops, overlays, parts, deliverables, measured report |
| 9 stock nodes | stock | Transcription, LLM, embeddings, vector store, frame sampling, pose, responses |

Three of the five customs hold **no podcast semantics** and are queued for upstream PRs
(§11). The two that remain are app glue by design.

### 4.2 Browser side — four layers

```
  UI            app/{projects,episode,studio,reframe,brands}  ·  components/{podcast,studio,library,brand,shell}
                ─────────────────────────────────────────────────────────────────────────────────────────────
  STATE         lib/studio.ts (edit model, undo/redo, PlaybackClock) · lib/recent.ts · run registry
                ─────────────────────────────────────────────────────────────────────────────────────────────
  DOMAIN        lib/refine.ts (constraints + ranking) · lib/director.ts (spec + prompts) · lib/brand.ts
                lib/library.ts · lib/batch.ts · lib/podcast.ts (types, report normalisers)   ← no SDK imports
                ─────────────────────────────────────────────────────────────────────────────────────────────
  TRANSPORT     lib/engine.ts · lib/studio-engine.ts   ← the ONLY modules that import the SDK
                lib/pipelines/*.json  (byte-exact mirrors of .rocketride/*.pipe)
```

The domain layer is deliberately SDK-free so it unit-tests in milliseconds, and several of
its modules are **twins** of Python in `podcast_common/` — kept byte-identical by test, not
by discipline (§10).

---

## 5. Runtime views

### 5.1 Upload → analysis (the long one, and the resumable one)

```
Browser                    Engine pipeline                                   Store
   │ fs_write (chunked)                                                        │
   ├──────────────────────────────────────────────────────────────────────────►│ source/<file>
   ├──────────────────────────────────────────────────────────────────────────►│ project.json
   │
   │ chat(goal, ctx: project: source: status_to: write_to: skip_pieces:)
   ├─────────────► media_io  probe ───────────────────────────────────────────►│ analysis/media.json
   │               media_io  split → N pieces (measured offsets)
   │                 └─ per piece: writeAudio BEGIN…END ──► audio_transcribe
   │◄── SSE {stage: transcribing, piece: k/N} ─────────────┤                    │ status.json (per piece)
   │               podcast_segment  absolute = offset + time_stamp
   │                 └─ persist after every batch ────────────────────────────►│ transcript.partial.json
   │               closing → transcript.json + windows.json ──────────────────►│
   │                 └─ one Question per ~10-min part ──► llm_anthropic
   │◄── answers (raw) ─────────────────────────────────────┤
   │ refineAnalysis() — snap, filter, rank, explain
   ├──────────────────────────────────────────────────────────────────────────►│ candidates.json, chapters.json
   ├──────────────────────────────────────────────────────────────────────────►│ project.json (analysis: analyzed)
   │
   └─ then, fire-and-forget: transcript-index.pipe  and  visual-scan.pipe
```

If the client disconnects the engine cancels the pipeline. On the next run the browser passes
`skip_pieces:` for everything the partial transcript already covers, so a 55-minute episode
does not start over.

### 5.2 Clip render (the branching one)

```
chat(ctx: project, clip, options)
   │
   ▼
podcast_prepare_clip ──► resolves candidate/edit/version → aligns words → plans safe cuts → fits duration
   │  writes plan.json + compliance.json
   ├── text:  generic render spec  ─────────────────────────────┐
   └── video: 640 px / 10 fps copy ──► frame_grabber ──► pose_estimation
                                          │ table              │ text (persons/frame)
                                          ▼                    ▼
                                        speaker_framing (plan) ─────► merges framing_plan INTO the spec
                                                                            │ text
                                                                            ▼
                                                                      media_render
                                                                       · one mastered audio pass
                                                                       · per-output encode, crops, captions
                                                                       · probe + EBU R128 on the file
                                                                            │ answers (report)
                                                                            ▼
                                                                      browser stamps project.clips[id]
```

Two properties matter here. The detection branch exists **only** if the video lane is wired,
so an audio-only or override-`original` run skips vision entirely. And the spec travels
*through* the framing node, so `media_render` needs no second input lane and no knowledge of
framing — it just takes the last spec on the lane.

### 5.3 Studio export (the long-timeline one)

```
init     ──► align whole episode in 60 s pieces ──► timeline.json · waveform.json · suggestions.json
                                                     (suggestions are never auto-applied)
edit     ──► browser owns edits/episode-edits.json  (ops: cut/mute/bleep/shorten_silence, each with `enabled`)
preview  ──► prepared-vN.json ──► media_render  (standard: cached by spec hash · range: full chain)
export   ──► prepared-vN.json ──► media_render  programme pipeline:

   picture:  [intro concat][start cards][ body in resumable ~5-min parts ][end cards][outro concat]
                                          └ parts/manifest.json keyed by spec hash → re-run encodes only gaps
   sound:    one full-length body pass (cuts, mutes, 1 kHz bleeps, ducked music) — UNMASTERED
             → assemble the COMPLETE programme → two-pass loudnorm LAST → mux
   then:     extra aspects · mp3 · wav · srt/vtt shifted by the lead-in · ffmetadata + json chapters · report
```

Mastering last is the whole point: a hot intro or a silent card can no longer pull the
finished file off −16 LUFS, which is exactly what happened when the body was mastered alone.

---

## 6. Data architecture

### 6.1 One directory is the database

```
projects/<episode>/
  source/<upload>          immutable input
  project.json             the registry: settings, media, analysis/index/visual status, requests, clips, studio
  status.json              last stage written by any node  (progress, for a reloaded client)
  analysis/                everything derived and durable (transcript, candidates, requests, clips, visual, studio)
  edits/                   everything the producer changed — the ONLY mutable user state
  previews/ exports/       deliverables + their measured reports
```

### 6.2 Who writes what

The single most important rule in the data model: **a file has exactly one writer.**

| File | Written by | Read by |
|---|---|---|
| `analysis/media.json`, `transcript*.json`, `windows.json`, `index.json` | engine nodes | browser, nodes |
| `candidates.json`, `chapters.json`, `requests/rNN.json` | **browser** (refine) | browser, nodes |
| `clips/<id>/plan.json`, `compliance.json` | `podcast_prepare_clip` | browser, `media_render` |
| `clips/<id>/layout.json`, `visual/*` | `speaker_framing` | browser |
| `studio/{timeline,waveform,suggestions,prepared-vN}.json` | `podcast_prepare_clip` | browser, `media_render` |
| `edits/clip-edits.json`, `edits/episode-edits.json`, `versions/`, `proposals/` | **browser only** | nodes read, never write |
| `previews/*`, `exports/*`, reports | `media_render` | browser |
| `project.json` registries (`clips`, `studio`, `visual`, `index`) | **browser** after each run | everything |

Nodes never write the user's edits; the browser never writes a measured report. Where both
need the same truth, it moves as a **spec** on a lane, not as a shared mutable file.

### 6.3 Schema and compatibility

Every document carries `schema_version`; readers stay tolerant (the schema-1 clip location is
still read as a fallback). Edits are **non-destructive**: revisions append to `versions[]` and
set `active_version`; the candidate and the base record are never rewritten, so "the original"
is always one click away. Alignment quality is versioned too — `ALIGN_VERSION` is stamped into
the timeline, and the studio offers to re-prepare when it is behind.

### 6.4 Concurrency

There is no lock and no transaction, so the design avoids needing them: one writer per file,
plus a **single-flight coalescing save queue** in the browser (saves for the same key collapse;
savedness is decided by a state signature) and **fail-closed reads** (`readJsonStrict` — a
failed read is only "missing" if `exists()` says so, never silently an empty object). The one
genuinely shared document, `project.json`, is written only by the browser, only after a run.

---

## 7. Cross-cutting concerns

### Resumability and caching — five independent layers

| Layer | Key | Saves |
|---|---|---|
| Local source cache (`cache.py`) | store path + size + mtime | re-downloading the recording for every job |
| Partial transcript | source + piece length | re-transcribing an interrupted analysis |
| Whisper model cache | model name, per process, lock-guarded | model load per clip (CTranslate2 is not thread-safe) |
| Render cache (`media_render`) | spec hash + tier + window | re-rendering an identical preview (`cached: true`) |
| Parts manifest | spec hash, per ~5-min part | re-encoding a whole episode after a failure |

### Observability

Every node writes progress twice: to the caller's `status_to` file and as an SSE event of type
`podcast`. A watching client sees it live; a reloaded client catches up from `status.json`.
The browser keeps a run registry so a run survives navigation, and the engine logs to
`.rocketride/engine.log`. Reports are the durable record of what actually happened.

### Failure behaviour

Degrade where the result is still useful, fail loudly where it is not:

- Framing fails → a `full_frame` plan carrying the reason, and the render continues.
- A brand asset is missing → a warning in the report, and it is skipped.
- The index is unavailable → the director falls back to whole-transcript mode.
- The source, the project record or the spec is missing → the node writes `stage: "error"` to
  status and raises. No guessing.

### Security and secrets

The Anthropic key exists only as `${ROCKETRIDE_ANTHROPIC_KEY}` inside the pipe, substituted by
the engine from its own environment — verified by sending the raw placeholder from a key-less
client. `RR_SIGNING_KEY` backs the signed, expiring `/task/fetch?token=` URLs the browser plays
media through. The browser holds only the engine URI and an API key, both build-time public.
**There is no authentication or per-user identity today**, and store writes are unstamped —
that is the first gap to close for a hosted deployment (§11).

---

## 8. Deployment view

### Today (local / single-tenant)

```
  host machine
  ├── engine            tools/engine.sh start  → ../rocketride-server/dist/server/engine
  │                     ai/eaas.py --host=127.0.0.1 --port=5567 --node_path=<repo>
  │                     env: ROCKETRIDE_APIKEY · ROCKETRIDE_ANTHROPIC_KEY · RR_SIGNING_KEY  (from .env)
  │                     log: .rocketride/engine.log        nodes: hot-loaded, cached → restart after edits
  ├── docker: qdrant    :6333, volume qdrant-storage
  └── docker: frontend  nginx :3000 serving frontend/out/
                        build args NEXT_PUBLIC_ROCKETRIDE_URI · NEXT_PUBLIC_ROCKETRIDE_APIKEY (inlined)
```

`npm run build` alone produces `frontend/out/` for any static host. The engine comes from a
sibling `rocketride-server` clone on `develop` — `main` lacks `stream_index`, the engine file
store and `fs_geturl`, which this architecture depends on.

### Target (marketplace / multi-tenant)

The classification is **Category 1 — standalone**, and the migration is inventoried in
`MIGRATION-INVENTORY.md`. The shape changes in five places:

| Binding | Today | Target |
|---|---|---|
| Shell | Own Next.js router, own connection code | One scaffolded MF app, `<AppLayout>`, `useShellConnection()` |
| Nodes | 5 customs via `--node_path` (forbidden on staging) | Upstreamed providers, or `tool_python` for pure logic |
| Pipes | 12 hand-maintained files + mirrors | One generator emitting workspace + app copies, stable ids |
| Vector store | Qdrant container | `rocketride_vector` (no service to run) |
| Identity | none | `authenticated: true`, every store write stamped with the user |

Nothing in §§3–7 has to change for that move — which was the point of making the nodes generic
and the store the state.

---

## 9. Performance envelope

Measured on an M-series Mac, 10-minute 720p source, Docker, 18 CPUs.

| Stage | Time | Note |
|---|---|---|
| Analysis | ~102 s | transcription 66 s + Claude 36 s (`small`; `medium` roughly doubles transcription) |
| Transcript index | ~1 s | |
| Visual scan | ~19 s | |
| Prompt parse | ~6 s | |
| Directed discovery | ~27 s | |
| Clip preview | ~25 s | of which people tracking ≈ 10 s |
| Clip export | ~45 s | vertical + wide + sidecars |
| Studio init | 90 s → 204 s | `small` → `medium`; 1 463 words, 82 suggestions |
| Studio range preview | ~2.4 s | |
| Studio export | ~96 s | −16.0 LUFS / −1.0 dBTP, duration delta −141 ms |

Scaling characteristics worth knowing: transcription and rendering are CPU-bound and serial
per run; the engine runs one process, so concurrency is bounded by it (batches deliberately
use a pool of 2); Qdrant holds one collection for every episode, filtered by `objectIds`, so
index size grows with the library rather than the episode.

---

## 10. Quality strategy

| Level | What it covers | Command |
|---|---|---|
| Node logic | Specs, constraints, cut safety, duration fit, captions, framing maths, render planning, studio | `python3 -m unittest discover -s local_nodes/tests` (291 tests) |
| Browser | Refine, director, studio model, brand, batch, library, pipe parity | `npm run lint && npm test` (169 tests) |
| Twin parity | `refine.ts` ↔ `refine.py` — a 120-case randomized differential (caught a one-cent rounding drift that reordered clips) | part of the browser suite |
| Contract parity | `lib/pipelines/*.json` byte-equal to `.rocketride/*.pipe`, ids unique | vitest guard |
| End to end | Real engine + real recording; check `ffprobe`, report loudness, `compliance.json`, and **look at a frame** | `tools/podcast_run.py …` |
| Browser E2E | Static build + headless Chrome over CDP | `npx serve out` + CDP driver |

The E2E level is not optional decoration: the last four integration defects were each
self-consistent on both sides of a seam and only the live engine disagreed.

---

## 11. Evolution

**Direction of travel: `local_nodes/` shrinks to nothing.** The upstream plan
(`UPSTREAM_NODES.md`) is five PRs against rocketride-server, in priority order:

1. `audio_transcribe` gains word timestamps + absolute time → deletes our piece hand-off and
   `align.py` entirely.
2. `media_render` as a stock generic timeline renderer → the flagship; already generic here.
3. `audio_diarize` (AssemblyAI / Deepgram / pyannote) → real speaker identity, which unlocks
   verified `speaker_match` and identity-linked active-speaker framing.
4. `speaker_framing` as a stock node.
5. `media_probe` / `media_slice` utilities.

What stays ours permanently: the question building, the constraints and ranking, the request /
edit / brand schemas, the suggestion policy, the prompts and the UI. Those encode this
product's opinions; upstreaming them would make bad stock nodes.

**Known limits, stated honestly.** No diarization, so "who is talking" is head motion gated by
word timing and people are positional per clip. One camera angle in the studio. Suggestions
are heuristic, not model-driven. No auth, no audit stamps. Whole-recording reframe still
chunks. The screen-share heuristic fires on lecture-hall wide shots; the producer override
covers it.

---

## 12. Decision log

| # | Decision | Because | Consequence we accept |
|---|---|---|---|
| 1 | No backend of our own | The engine already runs pipelines, stores files and holds secrets; a second tier would only proxy | The browser orchestrates, so long runs must be resumable and a closed tab cancels a pipeline |
| 2 | The file store is the database | Pipeline-reachable, already durable, no schema migration service | One writer per file, and no transactions |
| 3 | Question context as the node API | Lets generic nodes stay ignorant of our layout; no per-project pipe config | Every caller must send every path; a missing line is an error |
| 4 | ≤58 s audio pieces, one stream each | The stock transcriber stamps times relative to the buffer it flushed | An extra split + probe pass, and a reconstruction step in `podcast_segment` |
| 5 | Ranking in the browser, not a node | Same rules must run in the UI before a run, and nodes should stay generic | A Python twin exists for the CLI and is kept byte-identical by a differential test |
| 6 | Pose keypoints instead of `face_detection` | Nodes with the `debug` capability are dropped by release engines | Face boxes are derived from keypoints, with profile-specific sizing rules |
| 7 | Render from a generic edit-decision spec | One renderer serves a 40-second clip and a 90-minute programme | The preview/export difference moves into the spec (i.e. into `podcast_prepare_clip`) |
| 8 | Master the assembled programme last | A hot intro pulled finished files off target when only the body was mastered | An extra full-length pass on export |
| 9 | Non-destructive edits with versions | Producers need "the original" back, always | Every schema carries versions and restore ids |
| 10 | Report only what was measured | Claimed compliance is worse than none | Unverifiable fields are `null` + a warning, and the UI must show that honestly |
