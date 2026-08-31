# Clip Farm — podcast clips on RocketRide

Upload a podcast, **describe the clips you want**, and receive editable, publish-ready
vertical + wide videos with captions — with **every processing step running as a RocketRide
pipeline**. The web app is a fully static site (Next.js `output: "export"`: plain HTML/JS
served by nginx, S3, or the marketplace shell) that talks to the engine from the browser;
there is no API server, no Node server, no queue and no database of our own.

```
browser ──(rocketride SDK)──▶ RocketRide engine
   projects/<episode>/…      ◀──▶ account file store      (source, analysis, requests, previews, exports)
   episode-analysis.pipe          podcast_ingest → audio_transcribe → podcast_segment → llm_anthropic → podcast_refine
   transcript-index.pipe          podcast_segment → embedding_transformer → qdrant          (semantic transcript index)
   director-chat.pipe             llm_anthropic                                             (prompt parsing, revisions)
   prompt-director.pipe           embedding_transformer → qdrant → llm_anthropic → podcast_refine   (directed clips)
   clip-preview.pipe              podcast_prepare_clip → podcast_render[preview]
   clip-export.pipe               podcast_prepare_clip → podcast_render[export]
```

Stock nodes do the heavy lifting (`audio_transcribe`, `embedding_transformer`, `qdrant`,
`llm_anthropic`); five small custom nodes under [`local_nodes/`](local_nodes/) handle the
podcast-specific glue. Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); why each
stock node was or wasn't used: [`docs/NODE_CATALOG.md`](docs/NODE_CATALOG.md).

## What it does

1. **Analyse an episode** — transcript (sentence timestamps), ~8–10 candidate clips scored on
   *hook / clarity / standalone* with a one-line reason and the opening quote, plus topical
   chapters; the transcript is then indexed (60 s passages, local embeddings, Qdrant).
2. **Prompt Director** — write *"Create three 42-second clips where Sarah explains why the
   startup failed. Start with a surprising statement, remove filler words, avoid profanity, use
   yellow captions, and end with a complete takeaway."* Claude turns it into a structured
   request you can correct (count, length + mode, speakers, subjects, exclusions, hook, ending,
   editing policies, captions, aspect) with contradictions shown as warnings, then a semantic
   search over the transcript feeds the directed search. Hard constraints are enforced before
   ranking; every clip explains its scores, and every dropped proposal says why. Constraints that
   cannot be verified (speakers, until diarization) are flagged, never faked.
3. **Review instantly** — every candidate plays straight from the source recording at its
   time range; the episode map shows chapters and where each candidate sits.
4. **Edit non-destructively** — nudge the boundaries, rename, choose the filler policy
   (smart / cut / mute / keep), pause policy, caption preset and a target length with a mode
   (*natural* ±3 s with complete thoughts, *strict* ±1 s, *maximum* never longer); see every
   planned cut with its safety verdict and restore any of them; edits are saved to
   `edits/clip-edits.json`. Cut your own clip from the transcript by clicking two sentences.
5. **Ask for a change** — "Make the opening stronger", "Give me a shorter version", "Keep the
   pause at the end", "Find another clip making the opposite argument": each revision becomes a
   new version of the clip (the original stays), or a new request.
6. **Smart Visual Director** — every preview and export finds the people in the clip (stock
   `frame_grabber` + `pose_estimation` on a small copy of the clip), works out who is talking and
   frames the 9:16 version for them: a solo follow crop, a two-person stacked layout, screen
   share with the speaker underneath, or the full frame on a blur when nobody's face is on
   screen. Camera moves are smoothed and limited, crops keep a face-safe margin, captions sit on
   the seam of stacked layouts, and every layout holds for at least 2 s. Click a person's
   thumbnail to follow them, or force a layout (auto / solo / stacked / screen share / full frame /
   original). After the analysis the episode is scanned once for who is on screen and where the
   shots change.
7. **Preview** — a fast 540×960 render with cleaned, mastered audio (−16 LUFS) and burned-in
   word-by-word captions (about 15–25 s with the visual director), plus the compliance record
   (prompt match, requested vs final duration, topic, profanity, complete ending, speaker
   visible, face-safe, smooth camera) and the layout timeline.
8. **Export** — 1080×1920 (reframed 9:16) and 1920×1080 MP4s, SRT + VTT sidecars, a thumbnail
   and a report (dimensions, loudness, audio present, layout), all downloadable from signed
   engine URLs.
9. **Library** — every project is a folder in your RocketRide store; reopening it restores the
   workspace, and an analysis keeps running on the engine if you reload the page.

Measured on a 10-minute 720p episode (M-series Mac, `small` Whisper): analysis 102 s
(transcription 66 s, Claude 36 s) → 7 candidates + 4 chapters; index 1 s; visual scan 19 s;
prompt parse 6 s; directed search 27 s; preview 25 s (of which people tracking ≈ 10 s);
export ≈ 45 s.

## Run it locally

Prerequisites: Node 20+, pnpm 10, Docker (for the Qdrant transcript index and the optional
frontend image), an Anthropic key, and a RocketRide engine build. The engine
comes from the open-source server repo, cloned **next to this repo** on its `develop` branch
(`main` is the older 3.3.1 release and lacks the store/stream features these nodes use):

```bash
cd ..                     # the folder that contains rocketride-podcasts/
git clone --branch develop https://github.com/rocketride-org/rocketride-server.git
cd rocketride-server && pnpm install --frozen-lockfile && ./builder server:build
# → rocketride-server/dist/server/engine (a prebuilt binary is downloaded when one matches the
#   source; otherwise the builder compiles it — see docs/README-builder.md in that repo)
```

1. **Start the engine with this repo as its node path** (the folder that contains
   `local_nodes/`). The engine substitutes `${ROCKETRIDE_ANTHROPIC_KEY}` inside the pipeline
   itself, so the browser never sees the key; `RR_SIGNING_KEY` enables the signed URLs the UI
   plays files through; the API key can be anything.

   ```bash
   cd <rocketride-server>/dist/server
   ROCKETRIDE_APIKEY=MYAPIKEY ROCKETRIDE_ANTHROPIC_KEY=sk-ant-... RR_SIGNING_KEY=$(openssl rand -hex 32) \
     ./engine ai/eaas.py --host=127.0.0.1 --port=5567 --node_path=/path/to/rocketride-podcasts
   ```

   Or let the helper run it as a background service, reading those three values from the repo's
   `.env` (see `.env.example`) and logging to `.rocketride/engine.log`:

   ```bash
   tools/engine.sh start      # also: restart | stop | status | logs
   ```

   (`ROCKETRIDE_SERVER_DIR` overrides the engine location, `ROCKETRIDE_ENGINE_PORT` the port.)

2. **Start the transcript index** — `docker compose up -d qdrant` (Qdrant on `localhost:6333`,
   the pipes' `qdrant` node points there; data lives in the `qdrant-storage` volume). Without it
   the Prompt Director still works in full-transcript mode.

3. **Start the frontend** — either

   ```bash
   cd frontend && npm install && npm run dev      # http://localhost:3000
   ```

   or with Docker: `docker compose up -d --build` (builds the static export and serves it with
   nginx). `npm run build` alone writes the deployable site to `frontend/out/` for any static
   host. The page connects to `NEXT_PUBLIC_ROCKETRIDE_URI` with `NEXT_PUBLIC_ROCKETRIDE_APIKEY`
   (defaults `http://127.0.0.1:5567` / `MYAPIKEY`, inlined at build time; see
   `frontend/.env.local.example`). Episode pages are `/episode?id=<episode>`.

4. Drop a recording, pick a direction, press **Analyze the episode**. You land in the
   workspace while the pipeline runs; candidates appear when it finishes and the transcript is
   indexed. Then describe the clips you want in the Prompt Director.

5. **Pipeline editor (VS Code extension).** The extension starts its *own* development engine,
   which doesn't know the custom `podcast_*` nodes unless it gets the same node path — until then
   the `.pipe` files look disconnected in the editor. Add to your VS Code settings and restart the
   engine (Command Palette → RocketRide: restart / reload window):

   ```json
   "rocketride.development.local.engineArgs": "--node_path=/absolute/path/to/rocketride-podcasts"
   ```

   Alternatively point the extension at the engine you started in step 1
   (`rocketride.development.connectionMode: "host"`, `hostUrl: http://127.0.0.1:5567`).

Without the UI, `tools/podcast_run.py` drives the same pipelines from the command line
(`pip install rocketride`):

```bash
python tools/podcast_run.py analyze episode.mp4 my-episode "funny moments" 8
python tools/podcast_run.py index   my-episode
python tools/podcast_run.py visual  my-episode                # people on screen + shot changes
python tools/podcast_run.py parse   my-episode "Two 40-second clips where the guest explains the pivot, yellow captions"
python tools/podcast_run.py direct  my-episode r01          # add `full` to skip the index
python tools/podcast_run.py preview my-episode r01c01       # or: preview my-episode c01 duration:30 mode:strict
python tools/podcast_run.py preview my-episode c01 layout:stacked   # or layout:solo subject:p2 · full · screen · original
python tools/podcast_run.py revise  my-episode r01c01 "Make the opening stronger."
python tools/podcast_run.py export  my-episode r01c01
python tools/podcast_run.py get projects/my-episode/exports/r01c01/r01c01_vertical.mp4 out.mp4
```

## Project structure

```
.rocketride/            episode-analysis · transcript-index · transcript-search · visual-scan · director-chat · prompt-director(-full) · clip-preview · clip-export (.pipe)
local_nodes/
  podcast_common/       shared code: store, project layout, media (ffmpeg), clips, spec, constraints, editing, passages, captions, align, visual, cache
  podcast_ingest/       source → media.json + audio pieces for the stock transcriber (or just the reference)
  podcast_segment/      sentences → transcript.json, rubric questions for the LLM, passages for the index
  podcast_refine/       LLM answers → ranked candidates.json (analysis) or a validated request file (director)
  podcast_prepare_clip/ candidate / version / explicit range → word-aligned plan with safe cuts, duration fit, compliance (+ a small video copy for detection)
  podcast_layout/       people per frame (stock pose_estimation) → tracks, talking cue, layout timeline, crop paths, face-safe metrics
  podcast_visual/       episode scan: people on screen with thumbnails, shot changes
  podcast_render/       plan → preview or export files (+ report, measured duration, layout summary)
  tests/                unit tests for the pure logic (python -m unittest)
frontend/               static site (next build → out/), served by nginx in Docker
                        + the Podcast Studio (/studio): edit the whole episode by its transcript —
                        cut/mute/bleep from text, reviewable cleanup suggestions, audio finishing,
                        branding (intro/outro/music/logo/cards), captions, chapters; export
                        1080p MP4 + MP3/WAV + SRT/VTT + chapters from three studio pipelines
  app/layout.tsx        the shell: left navigation (New episode · Clip Studio · History · recent episodes · online dot) + toasts
  app/page.tsx          home: title, subtitle, one upload drop zone
  app/history/page.tsx  every run with live status, search and sort
  app/episode/page.tsx  Clip Studio (/episode?id=…): header, progress stepper, episode map, Direct / Moments / Transcript tabs, sticky preview
  components/shell/     Sidebar, Toasts
  components/history/   run rows, thumbnails, skeletons
  components/podcast/   PromptDirector (composer + editable spec chips), CandidateCard (compact rows), ClipWorkbench (phone-frame preview,
                        layout timeline, people strip, range + cleanup controls), ChapterStrip (scrubbable map), StatusTimeline (stepper),
                        TranscriptPanel (search + click-to-seek), SoundTools, ComplianceBadges, NewEpisodeForm (drop zone)
  lib/engine.ts         browser ↔ engine (store, pipelines, live progress, background runs)
  lib/podcast.ts        types + pure helpers (tested with vitest)
  lib/recent.ts         the episodes the producer opened last (localStorage), feeds the Clip Studio nav item
  lib/director.ts       spec normalisation, question builders, revisions, compliance badges (tested with vitest)
  lib/prompts/          the prompt text shared with tools/prompts.py
  lib/pipelines/        the .pipe files as JSON, sent with use({pipeline})
tools/podcast_run.py    command-line driver for the pipelines
tools/prompts.py        Python twin of the question builders
docs/ARCHITECTURE.md    pipelines, nodes, project directory, status model
docs/NODE_CATALOG.md    every stock node in the server repo and where it fits the roadmap
```

## Tests

```bash
python3 -m unittest discover -s local_nodes/tests -v   # node logic: specs, constraints, cut safety, duration fit, captions, visual director
cd frontend && npm run lint && npm test && npm run build
```

End-to-end runs need the engine and a recording — use `tools/podcast_run.py` or the UI.

## Notes

- Each node lists its Python dependencies in its `requirements.txt` (`av`, `imageio-ffmpeg` —
  ffmpeg 7 with libx264/libass/loudnorm — and `faster-whisper` for word alignment); the engine
  installs them into its own runtime the first time the node loads. Nothing to pip-install by hand.
- The visual director needs no API key: people come from the stock `pose_estimation` node (local
  weights) and "who is talking" from head motion gated by the word timing. Stock
  `face_detection` is not available on release engines (it carries the `debug` capability).
  Real speaker identity (diarization) is the one thing a key would add — see docs/ARCHITECTURE.md.
- Loudness is mastered to −16 LUFS integrated / −1 dBTP. A mono-read meter shows about
  −19 LUFS for the same file (dual-mono convention) — not a bug.
- Test footage used during development (Cordkillers) is CC BY-NC: test use only.
- Deploying to an organisation: publish the pipelines to the team's engine
  (`client.deploy.publish(...)`), ship `local_nodes/podcast_*` with the engine's nodes, swap the
  `qdrant` node for `rocketride_vector` (same lanes, no service to run) and point
  `NEXT_PUBLIC_ROCKETRIDE_URI` at that engine.
