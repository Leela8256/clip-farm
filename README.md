# Clip Farm — podcast clips on RocketRide

Upload a raw podcast episode, say what the clips are for, and get explainable clip
candidates, instant previews and finished vertical + wide exports with captions — with
**every processing step running as a RocketRide pipeline**. The web app is a fully static
site (Next.js `output: "export"`: plain HTML/JS served by nginx, S3, or the marketplace
shell) that talks to the engine from the browser; there is no API server, no Node server,
no queue and no database of our own.

```
browser ──(rocketride SDK)──▶ RocketRide engine
   projects/<episode>/…  ◀──▶ account file store        (source, analysis, previews, exports)
   episode-analysis.pipe      podcast_ingest → audio_transcribe → podcast_segment → llm_anthropic → podcast_refine
   clip-preview.pipe          podcast_prepare_clip → podcast_render[preview]
   clip-export.pipe           podcast_prepare_clip → podcast_render[export]
```

Stock nodes do the heavy lifting (`audio_transcribe`, `llm_anthropic`); five small custom
nodes under [`local_nodes/`](local_nodes/) handle the podcast-specific glue. Details:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What it does

1. **Analyse an episode** — transcript (sentence timestamps), ~8–10 candidate clips scored on
   *hook / clarity / standalone* with a one-line reason and the opening quote, plus topical
   chapters. Directed by your sentence ("funny moments about streaming TV for Reels").
2. **Review instantly** — every candidate plays straight from the source recording at its
   time range; the episode map shows chapters and where each candidate sits.
3. **Edit non-destructively** — nudge the boundaries, rename, toggle captions / pause
   tightening / filler removal; edits are saved to `edits/clip-edits.json` in your store.
   Cut your own clip from the transcript by clicking a first and a last sentence.
4. **Preview** — a fast 540×960 render with cleaned, mastered audio (−16 LUFS) and burned-in
   word-by-word captions (about 20–30 s).
5. **Export** — 1080×1920 (blur-pad 9:16) and 1920×1080 MP4s, SRT + VTT sidecars, a thumbnail
   and a report (dimensions, loudness, audio present), all downloadable from signed engine URLs.
6. **Library** — every project is a folder in your RocketRide store; reopening it restores the
   workspace, and an analysis keeps running on the engine if you reload the page.

Measured on a 10-minute 720p episode (M-series Mac, `small` Whisper): analysis 102 s
(transcription 66 s, Claude 36 s) → 7 candidates + 4 chapters; preview 28 s; export 35 s.

## Run it locally

Prerequisites: Node 20+, pnpm 10, an Anthropic key, and a RocketRide engine build. The engine
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

2. **Start the frontend** — either

   ```bash
   cd frontend && npm install && npm run dev      # http://localhost:3000
   ```

   or with Docker: `docker compose up -d --build` (builds the static export and serves it with
   nginx). `npm run build` alone writes the deployable site to `frontend/out/` for any static
   host. The page connects to `NEXT_PUBLIC_ROCKETRIDE_URI` with `NEXT_PUBLIC_ROCKETRIDE_APIKEY`
   (defaults `http://127.0.0.1:5567` / `MYAPIKEY`, inlined at build time; see
   `frontend/.env.local.example`). Episode pages are `/episode?id=<episode>`.

3. Drop a recording, pick a direction, press **Analyze the episode**. You land in the
   workspace while the pipeline runs; candidates appear when it finishes.

4. **Pipeline editor (VS Code extension).** The extension starts its *own* development engine,
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
python tools/podcast_run.py preview my-episode c01
python tools/podcast_run.py export  my-episode c01
python tools/podcast_run.py get projects/my-episode/exports/c01/c01_vertical.mp4 out.mp4
```

## Project structure

```
.rocketride/            episode-analysis.pipe · clip-preview.pipe · clip-export.pipe
local_nodes/
  podcast_common/       shared code: store, project layout, media (ffmpeg), clips, captions, align, cache
  podcast_ingest/       source → media.json + audio pieces for the stock transcriber
  podcast_segment/      sentences → transcript.json + rubric questions for the LLM
  podcast_refine/       LLM answers → ranked candidates.json + chapters.json
  podcast_prepare_clip/ candidate/edit → word-aligned clip spec with cuts
  podcast_render/       clip spec → preview or export files (+ report)
  tests/                unit tests for the pure logic (python -m unittest)
frontend/               static site (next build → out/), served by nginx in Docker
  app/page.tsx          library + new episode
  app/episode/page.tsx  workspace (/episode?id=…): status, episode map, candidates, clip workbench, transcript
  components/podcast/   UI pieces
  lib/engine.ts         browser ↔ engine (store, pipelines, live progress, background runs)
  lib/podcast.ts        types + pure helpers (tested with vitest)
  lib/pipelines/        the .pipe files as JSON, sent with use({pipeline})
tools/podcast_run.py    command-line driver for the pipelines
docs/ARCHITECTURE.md    pipelines, nodes, project directory, status model
```

## Tests

```bash
python3 -m unittest discover -s local_nodes/tests -v   # node logic: chunking, parsing, snapping, captions
cd frontend && npm run lint && npm test && npm run build
```

End-to-end runs need the engine and a recording — use `tools/podcast_run.py` or the UI.

## Notes

- Each node lists its Python dependencies in its `requirements.txt` (`av`, `imageio-ffmpeg` —
  ffmpeg 7 with libx264/libass/loudnorm — and `faster-whisper` for word alignment); the engine
  installs them into its own runtime the first time the node loads. Nothing to pip-install by hand.
- Loudness is mastered to −16 LUFS integrated / −1 dBTP. A mono-read meter shows about
  −19 LUFS for the same file (dual-mono convention) — not a bug.
- Test footage used during development (Cordkillers) is CC BY-NC: test use only.
- Deploying to an organisation: publish the three pipelines to the team's engine
  (`client.deploy.publish(...)`), ship `local_nodes/podcast_*` with the engine's nodes, and point
  `NEXT_PUBLIC_ROCKETRIDE_URI` at that engine.
