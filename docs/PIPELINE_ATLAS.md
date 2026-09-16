# Clip Farm — Pipeline Atlas

How the app is put together as of 2026-09-15: the system, the twelve pipelines, the
five custom nodes and how each one is built.

> **Which documents are current.** `.rocketride/*.pipe`, `local_nodes/` and `AGENTS.md`
> reflect the node generalization of 2026-09-01. `docs/ARCHITECTURE.md` and `README.md`
> still describe the earlier seven-node layout (`podcast_ingest`, `podcast_refine`,
> `podcast_layout`, `podcast_visual`, `podcast_render`). This document follows the code.

| | |
|---|---|
| Pipelines in `.rocketride/` | 12 |
| Custom nodes | 5 (3 generic + PR-ready, 2 app glue) |
| Stock nodes used | 9 |
| Backend services of our own | 0 |
| Loudness every export is mastered to | −16 LUFS / −1 dBTP |

---

## 1. System

The web app is a fully static Next.js export (`output: "export"`, served by nginx) that
talks to the RocketRide engine **from the browser** over the SDK. There is no API server,
no queue and no database of ours. The only service beside the engine is Qdrant, the
transcript index — and a hosted deployment swaps that node for `rocketride_vector`.

```
        ┌───────────────────────────┐
        │ CLI  tools/podcast_run.py │ ──── same pipes, same store ────┐
        └───────────────────────────┘                                │
                                                                     ▼
┌──────────────────────────────┐   chat(question + context)   ┌──────────────────────────────────┐   questions   ┌──────────────────┐
│ Browser                      │ ───────────────────────────► │ RocketRide engine                │ ────────────► │ Anthropic API    │
│ Next.js static export        │                              │ ./engine ai/eaas.py              │               │ claude-sonnet-4-6│
│                              │ ◄─────────────────────────── │   --node_path=<repo>  :5567      │               └──────────────────┘
│ lib/engine.ts                │   SSE 'podcast' events       │                                  │
│ lib/studio-engine.ts         │                              │  stock nodes                     │   upsert/     ┌──────────────────┐
│ lib/refine.ts   (ranking)    │                              │    audio_transcribe              │   search      │ Qdrant :6333     │
│ lib/pipelines/*.json (pipes) │                              │    llm_anthropic + 7 others      │ ────────────► │ podcast_         │
│ use({pipeline}) chat() fs_*  │                              │                                  │               │  transcripts     │
└──────────────┬───────────────┘                              │  custom nodes (local_nodes/)     │               └──────────────────┘
               │                                              │    media_io                      │
               │ fs_open / fs_write / fs_read                 │    speaker_framing               │   key: ${ROCKETRIDE_ANTHROPIC_KEY}
               │ signed URLs /task/fetch?token=               │    media_render                  │   substituted by the engine from
               │                                              │    podcast_segment               │   its OWN env — never the browser
               │                                              │    podcast_prepare_clip          │
               │                                              └───────────────┬──────────────────┘
               │                                                              │ Store.engine_file_store()
               ▼                                                              ▼
        ┌────────────────────────────────────────────────────────────────────────────────┐
        │ Account file store                                                             │
        │   projects/<episode>/  source · analysis · edits · previews · exports          │
        │   brand-templates/ · library/collections · library/batches                     │
        │   local disk or object storage — a node NEVER maps a store path to disk        │
        └────────────────────────────────────────────────────────────────────────────────┘
```

Two conventions hold the whole thing together.

**The question context is the API.** Every node reads `key: value` lines out of the chat
question — `project:`, `source:`, `clip:`, `write_to:`, `report_to:`, `status_to:` — so a
pipe needs no per-project configuration and the generic nodes never learn our folder
layout. A missing line is an error, never a guess.

**The store is the state.** Nodes write JSON records and media into the project folder;
the browser stamps the registries in `project.json` after each run; reopening a project
rebuilds the workspace from those files. Progress is written to `status.json` *and* pushed
as an SSE event of type `podcast`, so a watching client sees it live and a reloaded one
catches up.

---

## 2. Pipelines

Every pipe starts with a stock `chat` source and ends in a stock `response_*` node. The
browser keeps a byte-exact JSON mirror of each pipe in `frontend/lib/pipelines/` and sends
it with `use({pipeline, useExisting: true})`, so nothing has to be pre-deployed on the
engine. A vitest guard checks mirror parity and `project_id` uniqueness.

Legend: **[stock]** · **[generic]** custom and PR-ready · **[glue]** custom app glue.

### Workflow — Create Clips (`/episode`)

#### `episode-analysis.pipe` — transcript + scored candidates (~100 s for 10 minutes)

```
chat ──questions──► media_io ──audio (one stream per ≤58 s piece)──► audio_transcribe
[stock]            [generic]  │                                      [stock] whisper medium
                              │                                              │
                              │                                        documents (sentences + time_stamp)
                              │                                              ▼
                              └────text (reference: piece offsets)────► podcast_segment
                                                                             [glue]
                                                                             │ questions (one per ~10-min part)
                                                                             ▼
                                                                        llm_anthropic ──answers──► response_answers
                                                                          [stock]                      [stock]
```

Context: `project:` · `source:` · `status_to:` · `write_to: …/analysis/media.json` ·
`skip_pieces: 0,1,2` (resume).

The LLM's raw answers come back on the answers lane; the **browser** then runs
`refineAnalysis` (snap to sentence boundaries, enforce 20–90 s, drop overlaps, rank on
hook / clarity / standalone) and writes `candidates.json`, `chapters.json` and
`llm-answers.json`. No refine node is left in the pipe.

#### `transcript-index.pipe` — the semantic index (~1 s, runs once after the analysis)

```
chat ──► media_io ──text──► podcast_segment ──documents (60 s passages, 30 s step)──► embedding_transformer ──► qdrant
        mode: probe          reuses transcript.json                                        miniLM                 podcast_transcripts
                                   │
                                   └──text──► response_text
```

Passages are `[mm:ss - mm:ss] sentence` lines with `objectId = episode id`, because the LLM
only ever sees `page_content`. Re-indexing an episode replaces its chunks. The browser
proves the index with one search and records `project.index`.

#### `director-chat.pipe` — parse, revise, propose (stock only)

```
chat ──questions (client-built, expectJson)──► llm_anthropic ──answers──► response_answers
```

The whole prompt is built in the browser (`lib/director.ts`, text in
`lib/prompts/director.json`, Python twin `tools/prompts.py`). Used for three things: turning
a producer's sentence into a structured spec, revising one clip, and the Studio's reversible
AI edit proposals. **`prompt-director-full.pipe` has identical wiring** — the browser puts
the whole timestamped transcript in the question when the index is unavailable.

#### `prompt-director.pipe` — directed discovery (~27 s)

```
chat ──questions (text = search phrase)──► embedding_transformer ──► qdrant ──questions (same Question + documents)──► llm_anthropic ──► response_answers
                                                                     filter.objectIds=[episode], limit 16
```

A stock store forwards the client's Question **unchanged** with documents attached — which
is why no `prompt` node may sit after it (it would rebuild the question and drop
`expectJson` and `role`). Back in the browser, `refineDirected` applies the hard constraints
(duration window, speaker, required subject, exclusions, profanity, complete ending, no
overlaps), ranks survivors 35 / 25 / 20 / 10 / 10 and writes `analysis/requests/rNN.json`
with candidates `rNNcNN`, the rejected proposals with reasons and the compliance report.

#### `clip-preview.pipe` · `clip-export.pipe` — one clip (~25 s / ~45 s)

```
chat ──questions──► podcast_prepare_clip ──text (generic render spec)──────────────► speaker_framing ──text (spec + framing_plan)──► media_render ──answers──► response_answers
                          [glue]         │                                            [generic] plan                                  [generic]                   (report schema 2)
                                         │                                              ▲        ▲
                                         │ video (640 px / 10 fps copy, only when wired) │        │
                                         └──────► frame_grabber ──image──► pose_estimation        │
                                                   [stock] 0.2 s   │        [stock] rtmpose-medium
                                                                   └──table (ordinal → seconds)───┘
```

Context: `project:` · `clip: c03 | r01c02 | x53-96` · `start:` / `end:` (ms) · `title:` ·
`captions: off|classic|yellow-bold|white-outline|minimal` · `caption_style: {json}` ·
`aspect: 9:16|4:5|1:1|16:9` · `layouts: vertical,wide` · `fillers: smart|cut|mute|keep` ·
`silences: tighten|keep` · `duration: 42` · `mode: natural|strict|maximum` · `version: n` ·
`restore: f01,s02` · `layout: auto|solo|stacked|screen|full|original` · `subject: p2` ·
`model: medium|large-v3`.

The two pipes differ **only** in the encode profile baked into the prepare node — preview:
960 px vertical, crf 23, veryfast; export: 1920 px vertical + wide, crf 20, SRT/VTT
sidecars. The detection branch runs only when the video lane is wired. AI Reframe
(`/reframe`) reuses clip-preview with an `aspect:` line.

#### `visual-scan.pipe` — who is on screen + shot changes (~19 s, once per video episode)

```
chat ──► media_io ──text (reference)──────────────────► speaker_framing ──answers──► response_answers
        mode: detect_copy │                              [generic] scan
                          │ video (640 px / 10 fps)       ▲        ▲
                          └──► frame_grabber ──image──► pose_estimation
                               [stock] every 2 s  │                 │
                                                  └──table──────────┘
```

Context: `project:` · `source:` · `status_to:` · `write_to: …/analysis/visual` ·
`thumbnails_to: …/analysis/visual` · `echo.project:` · `echo.episode_id:`.

### Workflow — Episode Editor (`/studio`)

#### `podcast-studio-prepare.pipe` — `studio: init`

```
chat ──questions──► podcast_prepare_clip ──answers (manifest)──► response_answers
                    studio branch          ──text (spec, on preview/export)──┘
```

Aligns the whole episode in ~60 s pieces and writes `analysis/studio/timeline.json`
(words, silences, quiet, low-confidence, `ALIGN_VERSION`), `waveform.json` (RMS peaks per
100 ms) and `suggestions.json` (deterministic cleanup, natural ⊆ balanced ⊆ tight, never
auto-applied).

#### `podcast-studio-preview.pipe` · `podcast-studio-export.pipe`

```
chat ──► podcast_prepare_clip ──text (prepared-vN as render spec)──► media_render ──answers──► response_answers
         reads edits/episode-edits.json                              pipeline: programme
```

Context: `project:` · `studio: preview | export` · `quality: rough | standard | range | full` ·
`range: a-b` (output ms) · `size: 720|1080|source` · `version: n`.

Preview tiers: **instant** in the browser (skip-over-cuts playback, no render) · **standard**
≤1280 px, crf 22, unmastered, cached by spec hash · **range** a slice at ≤1920×1080, crf 19,
full chain · **export** to `exports/studio/vN/`.

### Shared

#### `transcript-search.pipe`

```
chat ──► embedding_transformer ──► qdrant (score ≥ 0.2) ──documents──► response_documents
```

Stock only. Proves the index after indexing and backs the transcript search box, for one
episode or the whole library (the filter takes a list; every hit says which episode it came
from).

---

## 3. Stock nodes

Golden rule of the project: a stock node whenever one does the job. These nine carry the
transcription, the language model, the embeddings, the vector store and the vision; they are
configured in the `.pipe` files only.

| Node | Config in the pipes | Role | Fact that shaped the design |
|---|---|---|---|
| `chat` | mode Source, hideForm | Every pipe's entry: one Question with context lines | Context lines are the only parameters a run needs |
| `audio_transcribe` | `medium` · en · silence_threshold 0.25 · min 240 s / max 300 s · vad_level 1 | Sentence transcription of the audio pieces | Stamps `time_stamp` relative to the **buffer it flushed**, and returns no word timing — hence pieces < 60 s and the offset reconstruction |
| `llm_anthropic` | `claude-sonnet-4-6` · apikey `${ROCKETRIDE_ANTHROPIC_KEY}` | Candidate scoring, prompt parsing, directed discovery, revisions, edit proposals | Flattens the Question into one prompt and only sees `page_content`; one Answer per Question |
| `embedding_transformer` | `miniLM` | Local embeddings for passages and search phrases | Runs in-process, no key |
| `qdrant` | `local` · localhost:6333 · `podcast_transcripts` · score 0.2 | The transcript index, filtered by `objectIds` | Forwards the client's Question unchanged; never put a `prompt` node after it. Hosted: swap for `rocketride_vector` |
| `frame_grabber` | `interval` · 0.2 s (clips) / 2 s (scan) | Samples the small detection copy | Images carry no timestamp, so the `table` lane (ordinal → seconds) is the clock |
| `pose_estimation` | `rtmpose-medium` · threshold 0.3 · max_persons 8 | 17 COCO keypoints per person per frame → face box | Chosen over `face_detection`, which carries the `debug` capability and is dropped by release engines |
| `response_answers` | laneName answers | Returns every answer written along the path | Clients pick the manifest by shape (last payload with a `project` key) |
| `response_text` / `response_documents` | laneName text / documents | Index confirmation; search hits | |

---

## 4. Custom nodes

### Anatomy — every node has the same shape

```
local_nodes/<name>/
  __init__.py        depends(requirements.txt) → the engine installs av, imageio-ffmpeg,
                     faster-whisper… into its own runtime the first time the node loads
  services.json      manifest: title, protocol, classType, lanes in/out, preconfig profiles,
                     the fields shown in the pipeline editor, "path": "local_nodes.<name>"
  IGlobal.py         beginGlobal(): load_node_config(self, DEFAULTS, name)
                     — the pipe's profile layered over the node's defaults, typed like them
  IInstance.py       open() / writeQuestions() / writeText() / writeDocuments() /
                     writeTable() / closing() — one class, emits with writeText /
                     writeAnswers / writeAudio / writeVideo, gates on hasListener(lane)
  requirements.txt   what the node imports (a fresh prebuilt engine ships only numpy)
  <lib>.py           a pure library with no engine imports, so unit tests run without an engine
```

Progress goes to the caller's `status_to` file **and** an SSE event of type `podcast`;
failures are written as `stage: "error"` before the exception propagates. The engine caches
node modules — restart it after editing node code.

Three of the five are **generic and PR-ready** for rocketride-server: their contracts hold no
podcast semantics and every store path arrives explicitly. Two remain **app glue**.

---

### `media_io` — generic · classType video · 327 + 217 lines

The front door of a media pipeline: reads one file from the store and hands it to the rest of
the pipeline in the shape the next node needs.

**Lanes.** In: `questions` (context lines: `source:` required, `mode:`, `range:`,
`piece_seconds:`, `skip_pieces:`, `detect_width:`, `detect_fps:`, `video:`, `write_to:`,
`status_to:`). Out: `audio`, `video`, `text`.

**How it is built**

1. `IGlobal.beginGlobal` loads `mode / chunk_kb / piece_seconds / detect_width / detect_fps`,
   clamps pieces to 10–58 s and the detection width to an even number.
2. `writeQuestions` parses the context, requires `source:`, resolves the mode. **`auto`
   follows the wiring**: an audio listener means `transcribe_feed`, a video listener means
   `detect_copy`, otherwise `probe`. That is why one node serves three pipes with no config
   difference.
3. **Cache + probe.** `cache.local_source` pulls the recording out of the store once (keyed by
   path + size + mtime, lock-guarded, pruned to a few files); `media_lib.probe` reads
   duration, dimensions, fps and codecs with PyAV (there is no ffprobe in the engine). The
   probe JSON is written to `write_to` in every mode but `slice`.
4. **`transcribe_feed`.** `split_audio` runs ffmpeg `-f segment` into 16 kHz mono PCM pieces
   and then **probes each piece** — the segmenter cuts on frame boundaries, so a nominal grid
   would drift over an hour. Each piece goes out as its own `writeAudio(BEGIN, WRITE…, END)`
   stream; the engine stamps every relayed stream with `metadata.source.stream_index`. Pieces
   listed in `skip_pieces` are not streamed, which is how an interrupted analysis resumes.
5. **`detect_copy`.** ffmpeg `scale=640:-2,fps=10`, x264 ultrafast, no audio, timestamps from
   0, streamed on the video lane with a descriptor from the engine's `video_begin_payload`.
6. **`slice`.** A `range:` decoded to caller-named store paths (`.wav`, optionally a small `.mp4`).
7. **The reference** always leaves on the text lane first: `kind: media_io_reference`, the
   media block, `pieces` as source intervals **in stream order**, `piece_indices`, the
   caller's context echoed back, the question text. A consumer places a timestamp with
   `pieces[stream_index][0] + in_piece_ms`.

**Manifest.** Profile `default`: mode auto · chunk 1024 KB · piece 45 s · 640 px · 10 fps.
Requires `av`, `imageio-ffmpeg`. Pure lib: `media_lib.py`.
**Writes.** The probe JSON to `write_to`; status `probing → splitting → transcribing (per
piece) → streaming/streamed → sliced`.
**Used by.** episode-analysis (feed), transcript-index (probe), visual-scan (detect copy).

---

### `podcast_segment` — app glue · classType text · 365 lines, pure Python

The bridge between the stock transcriber and the stock LLM / embedding nodes.

**Lanes.** In: `documents` (transcriber sentences), `text` (the media_io reference).
Out: `questions`, `documents`, `text`.

**How it is built**

1. `open` resets per-run state: reference, this run's sentences, sentences recovered from an
   interrupted run, the call counter.
2. `writeText` accepts the reference, takes the project root from its echoed `project:` key,
   and — if the reference says pieces were skipped — loads
   `analysis/transcript.partial.json` to resume.
3. `writeDocuments` is called **once per audio piece** the transcriber was fed. Each sentence
   gets `stream = metadata.source.stream_index` (fallbacks: a `pieceNNNN` name in the
   provenance, then the call index) and `start_ms = piece offset + time_stamp × 1000`. The
   partial transcript is persisted after every batch, so a client disconnect (which cancels
   the pipeline) loses at most one piece.
4. `closing` runs once, after all inputs have closed. A sentence ends where the next begins
   (the stock transcriber only reports starts). It writes `analysis/transcript.json` and
   `windows.json`, records the media numbers and `analysis.status = analyzing` in
   `project.json` (media_io is generic and writes neither), then emits per wired listener.
5. **questions lane.** `chunk_sentences` cuts the transcript into ~10-minute parts with 45 s
   overlap; `build_question` builds a Question with a producer role, six instructions
   (selection, direction, timestamps, scoring, chapters, JSON format), an example answer, the
   part's `[mm:ss - mm:ss] text` lines as context and `expectJson`. It asks for up to
   `per_part` candidates (4, raised so refine can be picky).
6. **documents lane.** `passages.window_passages` makes overlapping 60 s / 30 s-step
   passages; `passage_documents` turns them into Documents with `objectId = episode id` and
   absolute times in the metadata; `analysis/index.json` records what was sent.
7. **No transcriber wired** (transcript-index pipe): reads the stored transcript instead of
   transcribing again.

**Manifest.** min 20 s · max 90 s · per_chunk 4 · chunk 10 min · overlap 45 s · passage 60 s /
step 30 s. Requires nothing.
**Writes.** `analysis/transcript.json`, `transcript.partial.json`, `windows.json`,
`index.json`; `project.json` (media, goal, analysis + index status); status
`transcribed → scoring (per part) → indexing → indexed`.

---

### `podcast_prepare_clip` — app glue · classType text · 670 lines (+ `studio.py` 1130)

One chat question = one clip, or one whole-episode studio step.

**Lanes.** In: `questions`. Out: `text` (the generic render spec, with a `framing` block for
speaker_framing), `video` (detection copy, only when wired), `answers` (studio manifest).

**Clip path**

1. **Resolve the clip.** `find_candidate` reads `rNNcNN` from its request file and `cNN` from
   `candidates.json`; `xA-B` is a hand-made clip; explicit `start:`/`end:` override
   everything. The saved edit (`edits/clip-edits.json`) is overlaid with its active or
   requested version — versions never touch the base record.
2. **Resolve every option in one order:** question > saved edit > the request's normalised
   spec > node config. That covers captions (preset name or a full `CaptionStyle` JSON), the
   brand snapshot and its assets, filler and pause policies, aspect (9:16, 4:5, 1:1, 16:9),
   target duration and mode, restored cuts, layout mode, subject, focus.
3. **Align.** Slice the interval ±2 s and run `align.align_words`: faster-whisper with
   `word_timestamps`, VAD on, the candidate's quote as the initial prompt, then
   `sanitize_words` (drop long near-zero-confidence words, cap a word at 1.5 s by pulling its
   *start* toward its end, de-overlap). Locate the candidate text among the words and snap
   the boundaries to word edges.
4. **Plan cuts.** `detect_silences` (ffmpeg silencedetect) plus `measure_levels` around every
   candidate cut; `editing.plan_cuts` gives each filler and pause a cut id, an action
   (cut / mute / keep) and a safety verdict — smart cuts only where the join has a natural
   gap and no loudness step, otherwise mute; pauses containing speech are kept.
5. **Fit the duration.** `fit_duration` only ever moves to word ends: `natural` reports,
   `strict` trims to a word (preferring a sentence end) or gives pauses back and pads into
   trailing silence, `maximum` never exceeds. Out comes the keep list, the mutes and a fit
   report.
6. **Detection copy.** If a video listener is wired and layout ≠ `original`, stream a
   640 px / 10 fps copy of the final interval on the video lane.
7. **Write and emit.** `analysis/clips/<id>/plan.json` (schema 2) and `compliance.json`; then
   `render_spec.clip_render_spec` builds the generic spec — source, keep, mutes, audio chain,
   subtitles (words + style), outputs with **this node's** encode profile, thumbnail,
   `write_to / report_to / status_to`, and a `meta` block (clip id, version, title, tier) the
   renderer echoes back. `clip_framing` adds the block speaker_framing reads.

**Studio branch** (`studio:` context key)

- `init` aligns the whole episode in 60 s pieces (transcript sentences as hints), derives
  silences from levels *and* from word gaps, computes RMS peaks, and writes
  `timeline.json` / `waveform.json` / `suggestions.json`.
- `preview` / `export` read the browser's `episode-edits.json`, apply `corrections` to caption
  text only (never to timing), and build `prepared-vN.json` via `studio_lib.build_prepared`
  (keep, mutes, bleeps, source↔output map, caption lines, chapters, verified assets), then
  `studio_render_spec` with the tier's encode and paths. A manifest goes out on `answers`.

**Manifest.** Profiles default / preview / export: model medium · en · pad 2 s · fillers
smart · silences tighten · captions classic · level_check on · render_mode, size, layouts,
fps, crf, preset, captions, sidecars. Requires `faster-whisper`, `ctranslate2`, `av`,
`imageio-ffmpeg`, `numpy`. MIN_CLIP 3 s; tolerance natural 3 s / strict 1 s / maximum 0.

**Why the encode lives here.** media_render is generic, so preview-vs-export is a property of
the **spec**. The clip pipes carry the encode on this node's profile; the renderer's own
profile is only a fallback for outputs that state no encode.

---

### `speaker_framing` — generic · classType text · 494 + `frames.py` 102 (maths in `visual.py`, 819)

Framing decisions for talking-head video from the stock detectors' output. `plan` frames one
piece of video; `scan` lists the people and shot changes of a whole recording.

**Lanes.** In: `text` (the caller's JSON **and**, per frame, the detector's person list —
told apart by shape), `table` (the grabber's ordinal → seconds), `questions` (optional
context). Out: `text` (plan merged into the caller's JSON under `framing_plan`, or the scan
manifest), `answers` (manifest).

**How it is built**

1. **Collect.** `writeText` parses each payload: a list, or a dict with `persons` /
   `keypoints` / `box`, is a frame of detections; any other dict is the caller's spec.
   `writeTable` keeps the seconds column of the grabber's markdown table. The question
   outlives the object it arrived with, so context is kept on the instance.
2. **Settings resolve in `closing`**, lowest precedence first: node config → the spec's probe
   fields (`media`, width, height, duration_ms, has_video, source, words) → question context →
   the spec's `framing` block (where podcast_prepare_clip puts run-time values: `write_to`,
   `thumbnails_to`, `status_to`, `aspect`, `layout`, `subject`, `focus`, `source_offset_ms`,
   `echo`).
3. **Time and scale.** Frame times come from the table when it lines up with the detections,
   else `i × sample_ms`. `faces_from_persons` turns COCO keypoints into a face box from the
   **widest visible cue** (eye gap / 0.46, ear gap × 1.05, nose↔ear × 1.25, near-eye↔ear ×
   1.6), centred between nose and ears so profiles are sized right; boxes are scaled from the
   640 px copy back to source pixels.
4. **`plan` → `visual.build_layout`.** Tracks by IoU ≥ 0.3, relinked across 2 s gaps, duplicates
   merged (NMS); 500 ms speech bins from the word timings; "who is talking" from head-motion
   activity, where a confident talker needs a 1.6× lead for 3 s; segments with a 2 s minimum
   dwell choose `solo_follow`, `stacked_two`, `side_by_side`, `screen_share` (all faces small
   and in a corner), `full_frame`, `fixed_crop` or `original`; crop paths are EMA-smoothed
   (α 0.25) with a dead zone, pan capped at 0.5 window-widths/s and 40 % headroom; `face_safe`
   checks every sampled frame against the interpolated path. Unsure moments fall back to
   stacked — never to a wrong solo. Window sizes use the median head **within the segment**
   (solo ≤ 5 heads tall, panels ≤ 3.5).
5. **Canvas.** Windows are planned for the output aspect (1080×1920 by default; 4:5, 1:1 and
   16:9 on request) so a panel is never stretched later.
6. **Thumbnails and output.** One face crop per track from the source at its best frame
   (`frames.crop_thumbnail`); `layout.json` to `write_to`; the plan merged into the spec and
   forwarded; a metrics manifest on `answers`. A failure degrades to a `full_frame` plan
   carrying the reason — never a dead pipe.
7. **`scan` → `people_from_samples`** clusters the sparse 2 s samples into people (position,
   size, presence timeline, best frame), `frames.detect_scenes` runs ffmpeg's scene score at
   320 px, and `people.json` + `scenes.json` are written.

**Manifest.** `plan`: sample 200 ms · detect_width 640 · canvas 1080×1920 · dwell 2000 ms ·
pan_cap 0.5. `scan`: sample 2000 ms · detect_width 0 (source px) · scenes on · threshold 0.35.
Requires `av`, `imageio-ffmpeg`, `numpy`.
**Writes.** `analysis/clips/<id>/layout.json` (schema 1) + `pN.jpg`;
`analysis/visual/people.json` + `scenes.json` + `pN.jpg`; status `tracking → planned` /
`people → scenes → scanned`.
**Honest limits.** No diarization — "who is talking" is head motion gated by word timing.
People are positional (`p1…pN`) per clip, not identities. The screen-share heuristic also
fires on lecture-hall wide shots; the `layout:` override covers it.

---

### `media_render` — generic · classType video · 638 + `plan.py` 399 + `render_lib.py` 1588 + `report.py` 178

Turns one edit-decision spec into finished media with the engine's own ffmpeg. It knows
nothing about clips, episodes or our folders: every path comes from the spec.

**Lanes.** In: `text` — one JSON spec (`source`, `outputs`, `write_to` required; plus `keep`,
`map`, `window`, `mutes`, `bleeps`, `audio`, `music`, `overlays`, `cards`, `concat`,
`subtitles`, `framing_plan`, `thumbnail`, `chunking`, `chapters`, `mode`, `cache_key`,
`meta`…). Out: `answers` and `text` — the report. The full schema is the docstring of
`media_render/plan.py`.

**How it is built**

1. **`writeText` keeps the _last_ dict** that names a source and outputs — which is how
   speaker_framing, sitting between the planner and the renderer, gets the final word.
2. **`plan.py` normalises** with pure functions (unit-tested without ffmpeg): `resolve_keep`
   (keep list, source↔output map, an optional output `window` for range previews),
   `normalize_audio` (denoise, highpass, compress, master, −16 LUFS / −1 dBTP, channels),
   `normalize_outputs` (geometry from layout / aspect / long edge; encode gaps filled from the
   profile), `caption_plan` (words mapped through the keep list, or pre-grouped lines),
   `framing_plan`, `choose_pipeline` and the `cache_key`.
3. **Cache.** A preview whose report on disk carries the same cache key, tier and window —
   with its file still present — is returned as-is with `cached: true`.
4. **`clip` pipeline.** Slice the source audio → `render_audio`: atrim + 10 ms de-click fades +
   concat of the keep list, mutes, afftdn / highpass / compressor, then two-pass loudnorm.
   Per output: an ASS script with karaoke `\k` word timing (stacked layouts put the line on
   the **seam** between panels), then `render_layout_video` when a framing plan applies
   (per-frame `sendcmd` crop commands, `vstack`/`hstack` panels, blur-pad for `full_frame`,
   `setsar=1` before `concat`) or `render_clip_video` otherwise; watermark overlay; sidecars;
   a poster frame.
5. **`programme` pipeline** (anything with chunking, bleeps, music, cards, concat or
   chapters). *Picture:* intro concat and start cards, then the body in resumable ~5-minute
   parts recorded in `parts/manifest.json` keyed by the cache key (a re-run re-encodes only
   the missing parts), each with its own burned captions, then end cards and outro. *Sound:*
   one full-length body pass with cuts, mutes, 1 kHz bleeps at −14 dB and music ducked by
   sidechain compression — deliberately **unmastered**; then the complete programme is
   assembled and `master_wav` runs **last** over the whole thing, so a hot intro cannot pull
   the body off target. Concat by stream copy, mux, derived outputs (`transcode_aspect` for
   extra aspects, mp3 192 kbps, wav 48 kHz), SRT/VTT shifted by the lead-in, ffmetadata +
   JSON chapters on export.
6. **Report schema 2** (`report.py`): everything **measured** on the deliverable (probe + EBU
   R128) — a `quality` block, per-deliverable `measurements`, `loudness_ok` within ±1 LU and
   ≤ −1 dBTP (null when unmastered, never faked), a `clock` block, duration validation,
   warnings in plain words, and the spec's `meta` merged underneath. Written to `report_to`
   and emitted.

**Manifest.** `preview`: long edge 960 · 30 fps · crf 28 · ultrafast · captions on · no
sidecars · part 300 000 ms. `export`: long edge 1920 · 30 fps · crf 20 · veryfast · captions +
sidecars. Requires `av`, `imageio-ffmpeg` (ffmpeg 7 with libx264, libass, loudnorm), `numpy`.
Without `rocketlib` the package exposes only `render_lib`, `plan` and `report`, so tests and
the CLI can import it.
**Writes.** `previews/<id>.mp4 / .jpg / .json`; `exports/<id>/` (vertical + wide mp4, srt, vtt,
thumbnail, report.json); `previews/studio/standard-vN` and `range-vN`;
`exports/studio/vN/` (episode.mp4 + aspects, mp3, wav, captions, chapters.txt/json, parts/,
report.json); status `rendering → encoding → mastering → rendered`.

---

## 5. Browser side

Since the generalization, the app's opinions live in TypeScript. The nodes stay generic; the
page does the ranking, the prompting and the bookkeeping.

| Module | Job | Twin / test |
|---|---|---|
| `lib/engine.ts` | The only SDK importer. Connection + retry, store helpers (`readJsonStrict`, queued fail-closed saves, signed URLs), `runQuestion` for every pipe, `runAnalysis`, `runIndex`, `runVisualScan`, `runParse`, `runDirector`, `runClip` (stamps `project.clips[id]`), `runReframe`, `runRevise` | `engine-queue.test.ts` |
| `lib/refine.ts` | Constraints, ranking and file assembly for analysis and directed runs | `podcast_common/refine.py` for the CLI; a 120-case randomized differential test keeps them byte-identical (fsum + Python-style rounding) |
| `lib/director.ts` + `lib/prompts/director.json` | Spec normalisation (contradictions become warnings), duration windows, the parse / direct / revise question builders, compliance badges | `podcast_common/spec.py`, `tools/prompts.py` |
| `lib/studio.ts` + `lib/studio-engine.ts` | The episode-edit model (ops, undo/redo, versions, corrections, `PlaybackClock` across source / rough / range previews) and the three studio pipe calls; stamps `project.studio[version]` | `podcast_common/studio.py` |
| `lib/brand.ts` · `library.ts` · `batch.ts` | Brand templates resolved to a snapshot `{id, revision, hash, resolved}` stamped into specs; My Projects collections; multi-project clip batches (parse once, pool of 2) | `podcast_common/captions.py` keeps CaptionStyle byte-identical in ASS |
| `lib/pipelines/*.json` | Byte-exact copies of `.rocketride/*.pipe`, sent with `use({pipeline})` | `pipelines.test.ts` guards parity and id uniqueness |

Routes: `/projects` (My Projects) · `/episode` (Create Clips) · `/studio` (Episode Editor) ·
`/reframe` (AI Reframe) · `/brands` + `/brand` (brand templates) · `/history` (redirect).

---

## 6. Shared library — `local_nodes/podcast_common/`

Pure Python the nodes import. Nothing in it maps a store path to disk; the ffmpeg library
moved into `media_render/render_lib.py` and `media.py` is now a re-export shim.

| Module | What it holds |
|---|---|
| `store.py` | Sync wrappers over the engine's async file store; `exists` treats a `{"exists": false}` descriptor and an exception alike |
| `cache.py` | One local copy of a source recording per engine, keyed by path + size + mtime |
| `project.py` | The `Project` path helper, context parsing, candidate lookup, `update_status` (status.json + SSE) |
| `reference.py` | Reads a media_io reference: project root, piece offsets, the pieces block |
| `config.py` | `load_node_config` — pipe profile over node DEFAULTS, typed like the defaults |
| `align.py` | faster-whisper word alignment, model cached per process behind a lock, VAD + `sanitize_words`, `ALIGN_VERSION = 2` |
| `clips.py` | Transcript chunking, tolerant answer parsing, sentence/word snapping, `locate_span`, filler detection |
| `editing.py` | Cut planning with safety rules, per-cut restore, `fit_duration` on word timestamps |
| `spec.py` | Prompt Director spec normalisation and duration windows (natural 0.6–1.5×, strict 0.85–1.5×, maximum ≤1.3×) |
| `constraints.py` | Director answer parsing, hard constraints, 35/25/20/10/10 ranking, request compliance |
| `refine.py` | Store-free twin of the browser's refine: `refine_analysis`, `refine_direct` |
| `passages.py` | Overlapping index passages as self-describing timestamped text |
| `captions.py` | CaptionStyle (9 gallery presets + legacy names), ASS karaoke builder, SRT/VTT, seam placement |
| `visual.py` | The Smart Visual Director maths: faces from keypoints, tracking, talking cue, segments, crop paths, face-safe, episode people |
| `render_spec.py` | Our plans → the generic spec: `clip_render_spec`, `clip_framing`, `studio_render_spec`, preview cache keys |
| `studio.py` | Studio init builders (timeline, waveform, suggestions), `build_prepared`, brand normalisation |
| `media.py` | Re-export shim for `media_render/render_lib.py` |

---

## 7. Project folder

```
projects/<episode>/
  source/<upload>                       the original recording (never modified)
  project.json                          schema 2: settings, media, analysis / index / visual
                                        status, requests, clips, studio registries
  status.json                           the last stage any node wrote
  analysis/
    media.json                          media_io probe
    transcript.json  transcript.partial.json  windows.json  index.json  llm-answers.json
    candidates.json  chapters.json      ranked analysis candidates c01… (written by the browser)
    requests/rNN.json                   one Prompt Director request: spec, candidates rNNcNN,
                                        rejected + reasons, compliance
    clips/<id>/plan.json  compliance.json  layout.json  pN.jpg
    visual/people.json  scenes.json  pN.jpg
    studio/timeline.json  waveform.json  suggestions.json  prepared-vN.json
  edits/
    clip-edits.json                     schema 2: versions[] + active_version, disabled cuts,
                                        layout/subject, brand
    episode-edits.json                  studio ops (cut / mute / bleep / shorten_silence),
                                        speakers, sections, assets, corrections
    versions/NNN.json   proposals/pNN.json
  previews/<id>.mp4 .jpg .json          fast clip previews + reports
  previews/studio/standard-vN.*  range-vN.*
  exports/<id>/                         <id>_vertical.mp4, <id>_wide.mp4, .srt, .vtt, .jpg, report.json
  exports/studio/vN/                    episode.mp4 (+ aspects), episode.mp3, episode.wav,
                                        captions.srt/.vtt, chapters.txt/.json, parts/, report.json

brand-templates/<id>/template.json + assets
library/collections/<id>.json
library/batches/<id>.json
```

---

## 8. Invariants

Each of these was learned on the live engine, and each shows up as a shape in the diagrams
above.

- **Pieces < 60 s.** The stock transcriber stamps sentences relative to the audio buffer it
  flushed, so media_io feeds ≤58 s pieces as separate streams and podcast_segment adds each
  piece's *measured* offset. Never trust `time_stamp` alone.
- **Context is the API.** Generic nodes take every store path from `source:` / `write_to:` /
  `report_to:` / `status_to:`; every caller (browser and CLI) must send them.
- **Last spec wins.** media_render keeps the last dict on its text lane — how speaker_framing
  hands over the plan-enriched spec without a new lane.
- **The answers lane is cumulative.** `response_answers` returns every answer written along
  the path, so clients select the manifest by shape.
- **No `prompt` node after a store.** A stock store forwards the Question unchanged; `prompt`
  would rebuild it and drop `expectJson` and `role`.
- **Pose, not `face_detection`.** Nodes with the `debug` capability are dropped by release
  engines. Faces come from RTMPose keypoints on a 640 px copy, never the full-size source.
- **trim + concat, and `setsar=1`.** Chained `xfade` truncates after the second segment;
  per-piece SAR differences make `concat` refuse. Both bit on real footage; both have
  regression tests.
- **Master last, measure the file.** The programme is assembled before two-pass loudnorm, and
  the report's loudness is read off the deliverable. A mono meter shows ≈ −19 LUFS for a
  correct file (dual-mono convention) — not a bug.
- **Never through a word.** Duration fitting only moves to word ends; unsafe cuts become
  mutes; every planned cut has an id the producer can restore.
- **Verify or warn.** A constraint the system cannot check (speaker identity, without
  diarization) is reported as `null` plus a warning — never asserted.
- **Restart after node edits.** The engine caches node modules; a pipe-mirror change is baked
  into the frontend bundle and needs a rebuild + redeploy.

---

## 9. Running it

```bash
tools/engine.sh start           # engine with --node_path=<repo>, secrets from .env
docker compose up -d qdrant     # the transcript index
cd frontend && npm run dev      # or: docker compose up -d --build

python3 -m unittest discover -s local_nodes/tests -v      # node logic, no engine
cd frontend && npm run lint && npm test && npm run build  # browser

tools/podcast_run.py analyze|index|visual|search|parse|direct|revise|preview|export|studio
```
