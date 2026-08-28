# Architecture — Clip Farm on RocketRide

Everything that processes media runs **inside the RocketRide engine** as pipelines. The
web app is a fully static site (Next.js `output: "export"` — plain HTML/JS/CSS, served by
nginx in the Docker image or by any static host) that talks to the engine over the
RocketRide SDK (WebSocket) from the browser. There is no backend of our own: no API
server, no Node server, no queue, no database.

```
browser (Next.js, rocketride SDK)
   │  upload source + project.json          ──▶  account file store  projects/<episode>/
   │  chat("project: projects/<episode>")   ──▶  episode-analysis.pipe
   │  chat("project: …, clip: c03")         ──▶  clip-preview.pipe / clip-export.pipe
   │  SSE 'podcast' events                  ◀──  every node reports progress
   └  signed URLs (/task/fetch?token=…)     ◀──  previews / exports / source video
```

## Pipelines (`.rocketride/*.pipe`, mirrored in `frontend/lib/pipelines/*.json`)

### `episode-analysis.pipe` — Stage 1A discovery

```
chat ─▶ podcast_ingest ─(audio, one stream per ≤45 s piece)─▶ audio_transcribe (stock)
              │ text: episode reference                             │ documents: sentences + time_stamp
              └────────────────────────────────────────────────▶ podcast_segment
                                                                     │ questions: one rubric question per ~10 min part
                                                                 llm_anthropic (stock)
                                                                     │ answers
                                                                 podcast_refine ─▶ response_answers
```

| Node | Kind | Job |
| --- | --- | --- |
| `podcast_ingest` | custom | Reads `project.json`, probes the source (`analysis/media.json`), cuts the audio into exact 16 kHz mono pieces and streams each piece as its own stream on the `audio` lane; forwards the episode reference (with the exact piece offsets) on `text`; streams the full video on `video` only when something is wired to it. |
| `audio_transcribe` | **stock** | Whisper transcription. It stamps sentences relative to the audio buffer it flushed, so the ingest node feeds it pieces shorter than its 60 s buffer; the engine labels each relayed stream with `metadata.source.stream_index`, which is the piece number. |
| `podcast_segment` | custom | Rebuilds absolute sentence times (`piece offset + time_stamp`), writes `analysis/transcript.json` and `windows.json`, splits the transcript into ~10-minute parts (45 s overlap) and emits one `Question` per part asking for candidates scored on hook / clarity / standalone plus chapters. |
| `llm_anthropic` | **stock** | Answers each question (JSON). The API key is `${ROCKETRIDE_ANTHROPIC_KEY}` in the pipe and is substituted by the engine from its own environment. |
| `podcast_refine` | custom | Merges all answers: snaps proposals to sentence boundaries, enforces min/max length, removes overlaps, ranks by the weighted score, keeps the best N; writes `analysis/candidates.json`, `chapters.json`, `llm-answers.json` (raw model output, for explainability), updates `project.json` and returns the manifest. |

The `answers` lane carries every answer written along the path, so the client picks the
manifest by shape (the last payload with a `project` field).

### `clip-preview.pipe` / `clip-export.pipe` — Stage 1C editing + delivery

```
chat ─▶ podcast_prepare_clip ─(text: clip spec JSON)─▶ podcast_render[preview | export] ─▶ response_answers
```

| Node | Kind | Job |
| --- | --- | --- |
| `podcast_prepare_clip` | custom | Resolves the clip (candidate id, saved edit, or explicit `start:`/`end:` from the request), extracts the padded interval from a locally cached copy of the source, aligns word timestamps with faster-whisper, snaps the boundaries to the candidate's own words (fuzzy text match) or to word edges for user-chosen times, plans pause/filler cuts and writes `analysis/clips/<id>.json`. |
| `podcast_render` | custom | Cleans and masters the audio (afftdn, highpass, compressor, two-pass loudnorm to −16 LUFS / −1 dBTP), applies the cuts, burns word-by-word ASS captions, reframes to 9:16 (blur-pad) and/or 16:9, publishes files, writes a report and the project's clip registry. Profile `preview`: 540×960, ultrafast. Profile `export`: 1080×1920 + 1920×1080, SRT/VTT, thumbnail. |

Chat context lines understood by the clip pipelines: `project:`, `clip:`, `start:` (ms),
`end:` (ms), `title:`, `captions: off`, `layouts: vertical,wide`, `tighten: off`, `fillers: off`.

## Project directory (account file store)

```
projects/<episode>/
  source/<upload>                  the original recording
  project.json                     settings, media, analysis summary, clip registry (schema_version 1)
  status.json                      last stage written by any node (UI catches up after a reload)
  analysis/media.json              probe result
  analysis/transcript.json         sentences with absolute start/end + piece provenance
  analysis/windows.json            the parts sent to the LLM (+ debug metadata)
  analysis/llm-answers.json        raw model answers
  analysis/candidates.json         ranked, explainable candidates (scores, reason, quote, text)
  analysis/chapters.json           topical chapters
  analysis/clips/<id>.json         prepared clip spec (words, keep segments, options)
  edits/clip-edits.json            non-destructive edits written by the UI (boundaries, title, toggles, hand-made clips x<start>-<end>)
  previews/<id>.mp4 .jpg .json     fast preview + report
  exports/<id>/<id>_vertical.mp4 <id>_wide.mp4 <id>.srt <id>.vtt <id>.jpg report.json
```

## Progress and status

Every node calls `update_status()` (`local_nodes/podcast_common/project.py`): it writes
`status.json` and pushes an SSE event of type `podcast` (`{node, stage, …}`) for the running
pipe. The UI shows live events while its `chat()` call is open and polls `status.json`
after a reload until the project reports `analyzed`.

## Shared node code (`local_nodes/podcast_common/`)

`store.py` (sync wrappers over the engine's async file store), `cache.py` (local copy of the
source keyed by path+size+mtime), `project.py` (layout, status, chat-context parsing),
`media.py` (ffmpeg/PyAV: probe, slice, silence detection, mastering, render graph),
`clips.py` (chunking, answer parsing, snapping, ranking, text-span location, caption timing),
`captions.py` (ASS/SRT/VTT), `align.py` (faster-whisper word alignment), `config.py`.
Everything uses only what the engine ships (faster_whisper, av, imageio_ffmpeg).

## Not in v1

Speaker diarization (`speakers.json`), smart 9:16 face-tracking reframe (planned: stock
`frame_grabber` + `face_detection` → `podcast_crop_plan`), a database index of projects
(a `db_*` node can be added to the analysis pipe), music beds, cloud deployment.
