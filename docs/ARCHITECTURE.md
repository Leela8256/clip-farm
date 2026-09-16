# Architecture — Clip Farm on RocketRide

Everything that processes media or text runs **inside the RocketRide engine** as
pipelines. The web app is a fully static site (Next.js `output: "export"` — plain
HTML/JS/CSS, served by nginx in the Docker image or by any static host) that talks to
the engine over the RocketRide SDK (WebSocket) from the browser. There is no backend
of our own: no API server, no Node server, no queue, no database. The only service
next to the engine is the transcript index (Qdrant, one docker-compose service), and
in a hosted deployment even that is replaced by the stock `rocketride_vector` node.

```
browser (Next.js, rocketride SDK)
   │  upload source + project.json                 ──▶  account file store  projects/<episode>/
   │  chat("project: …")                           ──▶  episode-analysis.pipe   (transcript + scored candidates)
   │  chat("project: …")                           ──▶  transcript-index.pipe   (passages → embeddings → qdrant)
   │  chat(parse question)                         ──▶  director-chat.pipe      (sentence → JSON spec)
   │  chat(directed question, filter=episode)      ──▶  prompt-director.pipe    (search → llm → validate)
   │  chat("project: …, clip: r01c01")             ──▶  clip-preview.pipe / clip-export.pipe
   │  chat(revision question)                      ──▶  director-chat.pipe      (one structured change)
   │  SSE 'podcast' events                         ◀──  every custom node reports progress
   └  signed URLs (/task/fetch?token=…)            ◀──  previews / exports / source video
```

Stock nodes: `chat`, `audio_transcribe`, `embedding_transformer`, `qdrant`, `llm_anthropic`,
`response_answers`, `response_documents`, `response_text`. Custom nodes (all under `local_nodes/`): three GENERIC, PR-ready nodes —
`media_io`, `speaker_framing`, `media_render` — plus two app-glue nodes,
`podcast_segment` and `podcast_prepare_clip`. Refinement (constraints/ranking)
runs in the browser (`frontend/lib/refine.ts`) with a python twin
(`podcast_common/refine.py`) for the CLI; see docs/UPSTREAM_NODES.md. `docs/NODE_CATALOG.md` records why each of the
135 stock nodes was or wasn't used.

## Pipelines (`.rocketride/*.pipe`, mirrored byte-for-byte in `frontend/lib/pipelines/*.json`)

### `episode-analysis.pipe` — transcript + first candidates

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
| `podcast_ingest` | custom | Reads `project.json`, probes the source (`analysis/media.json`), cuts the audio into exact 16 kHz mono pieces and streams each as its own stream on the `audio` lane; forwards the episode reference (with the exact piece offsets) on `text`. With no audio listener wired (the index pipe) it only forwards the reference. |
| `audio_transcribe` | **stock** | Whisper (`medium`) transcription. It stamps sentences relative to the audio buffer it flushed, so the ingest node feeds it pieces shorter than its 60 s buffer; the engine labels each relayed stream with `metadata.source.stream_index`, which is the piece number. |
| `podcast_segment` | custom | Rebuilds absolute sentence times, writes `analysis/transcript.json` and `windows.json`, emits one rubric `Question` per ~10-minute part (questions lane) and — when an index is wired — overlapping 60 s / 30 s-step passages as documents keyed by the episode id. |
| `llm_anthropic` | **stock** | Answers each question (JSON). The API key is `${ROCKETRIDE_ANTHROPIC_KEY}` in the pipe and is substituted by the engine from its own environment. |
| `podcast_refine` | custom | Analysis mode: snaps proposals to sentence boundaries, enforces min/max length, removes overlaps, ranks by hook / clarity / standalone, writes `analysis/candidates.json`, `chapters.json`, `llm-answers.json`. |

### `transcript-index.pipe` — the semantic index (runs once after the analysis)

```
chat ─▶ podcast_ingest ─(text: reference)─▶ podcast_segment ─(documents: passages)─▶ embedding_transformer (stock) ─▶ qdrant (stock)
                                                    └─(text)─▶ response_text
```

Passages are `[mm:ss - mm:ss] sentence` lines (the LLM only ever sees `page_content`), with
`objectId = episode id`, `parent = projects/<episode>` and `start_ms/end_ms` in the metadata.
One collection (`podcast_transcripts`) serves every episode; re-indexing an episode replaces
its passages (`addChunks` removes chunks with the same objectId). The browser proves the
index with a search probe and records `project.index.status`.

### `director-chat.pipe` — `chat → llm_anthropic → response_answers`

Used for two fully client-built questions (`frontend/lib/director.ts`, `tools/prompts.py`,
prompt text in `frontend/lib/prompts/director.json`):

1. **Parse** — the producer's sentence → JSON spec (`count`, durations + mode, speakers,
   subjects, exclusions, tone, hook, ending, filler / silence policy, caption preset,
   aspect ratio, platform, `search_query`, `warnings`). Normalised by `normalizeSpec`
   (TS) / `normalize_spec` (Python): contradictions become warnings, never guesses.
2. **Revise** — one clip plan + the surrounding transcript + the cut list → one structured
   change (`retime`, `retitle`, `options`, `new_request`, `compilation`, `none`).

### `prompt-director.pipe` — directed discovery

```
chat ─▶ embedding_transformer (stock) ─▶ qdrant (stock, filter.objectIds = [episode], limit 16)
                                              │ questions: the same Question + retrieved passages
                                          llm_anthropic (stock) ─▶ podcast_refine ─▶ response_answers
chat ──────────────────────(questions: 'project:' / 'request:' context)──▶ podcast_refine
```

The browser builds the Question (role, instructions, the request summary, the rubric,
`expectJson`, `filter`) and sends the search phrase as the question text. The stock store
searches the episode's passages, attaches them to the Question and forwards it unchanged;
Claude proposes candidates with `prompt_match / hook / standalone / clarity / energy`
scores, a speaker guess with evidence and the compliance flags it can assert.
`podcast_refine` (director mode) then applies the **hard constraints** — duration window,
speaker, required subject, excluded subjects/content, profanity, complete ending, no
overlaps — ranks the survivors (35 / 25 / 20 / 10 / 10 with a small natural-mode penalty
for missing the target length), keeps `count`, and writes `analysis/requests/<rNN>.json`
with candidates (`r01c01…`), the rejected proposals and their reasons, and the request
compliance report. Unverifiable constraints (speakers, until phase 2 diarization) are
reported as warnings, not asserted.

`prompt-director-full.pipe` is the same without the store: the browser puts the whole
timestamped transcript in the question context. It is used when the index is unavailable.

### `clip-preview.pipe` / `clip-export.pipe`

```
chat ─▶ podcast_prepare_clip ─(text: clip plan JSON)──────────────────────────────▶ podcast_layout ─(text: plan + layout)─▶ podcast_render[preview | export] ─▶ response_answers
                └─(video: the clip at 640 px / 10 fps)─▶ frame_grabber ─(image)─▶ pose_estimation ─(text: people per frame)─┘
                                                              └─(table: frame times)──────────────────────────────────────┘
```

| Node | Kind | Job |
| --- | --- | --- |
| `podcast_prepare_clip` | custom | Resolves the clip (analysis candidate, request candidate, saved edit version, explicit times), aligns words with faster-whisper, snaps boundaries to words, plans **filler and pause edits with safety rules** (`smart` cuts only when the join has a natural gap and no loudness step, else mutes; pauses containing speech are kept), applies restored cuts, **fits the duration** (`natural` reports, `strict` trims to a word — preferring a sentence end — or gives pauses back and pads into trailing silence, `maximum` never exceeds), writes `analysis/clips/<id>/plan.json` + `compliance.json`. When a `video` listener is wired it also streams a small detection copy of the clip (640 px wide, 10 fps) so the stock vision nodes never touch the full-size source. |
| `frame_grabber` | stock | Samples the detection copy every 0.2 s (`interval` profile); the `table` lane carries `[ordinal, seconds, stamp]` per frame so the people can be put back on the clip's timeline. |
| `pose_estimation` | stock | RTMPose (`rtmpose-medium`, threshold 0.3, up to 8 people): 17 COCO keypoints per person per frame. The nose, eyes and ears give a face box; there is no timestamp, so frames are joined by ordinal. (`face_detection` would be the obvious choice but it carries the `debug` capability and release engines drop it.) |
| `podcast_layout` | custom | The **Smart Visual Director** (`podcast_common/visual.py`): faces → tracks (IoU matching, relink across short gaps, duplicate merging), head-motion "who is talking" gated by the aligned word timing, then a layout timeline — `solo_follow`, `stacked_two` / `side_by_side`, `screen_share`, `full_frame`, `fixed_crop`, `original` — with a 2 s minimum dwell, smoothed crop paths (EMA, dead zone, 0.5 window-widths/s pan cap, 40 % headroom), face-safe checks and metrics. Writes `analysis/clips/<id>/layout.json` + a thumbnail per person and forwards the plan with its `layout` block. Overrides: `layout: solo|stacked|screen|full|original`, `subject: p2` (follow that person). Without faces it passes the plan through as `full_frame`. |
| `podcast_render` | custom | Masters the audio (afftdn, highpass, compressor, two-pass loudnorm −16 LUFS / −1 dBTP) with the mutes applied, cuts audio and video from the same keep list, burns word-by-word captions in the requested preset (placed on the seam between the two panels of a stacked layout so they never cover a face), renders the 9:16 output through the layout plan (per-frame `sendcmd` crops, `vstack` / `hstack` panels, blur-pad for `full_frame`) and/or the 16:9 original, writes files, the report (`layout` summary) and the measured `duration_final` + `visual` block into `compliance.json`. |

Option resolution order inside `podcast_prepare_clip`: question context > saved edit (active
version overlaid) > the request's spec > node config. Context lines: `project:`, `clip:`,
`start:`/`end:` (ms), `title:`, `captions: off|classic|yellow-bold|white-outline|minimal`,
`layouts:`, `fillers: smart|cut|mute|keep`, `silences: tighten|keep`, `duration: <s>`,
`mode: natural|strict|maximum`, `version: <n>`, `restore: f01,s02`, `layout:
auto|solo|stacked|side|screen|full|original`, `subject: p2`.

### `visual-scan.pipe` — who is on screen (runs once after the analysis)

```
chat ─▶ podcast_ingest ─(video: 640 px / 10 fps copy)─▶ frame_grabber[2 s] ─▶ pose_estimation ─▶ podcast_visual ─▶ response_answers
```

`podcast_visual` clusters the faces of the whole episode into people (`analysis/visual/people.json`:
coverage, timeline, best frame, a thumbnail each), detects shot changes with ffmpeg's scene
score (`analysis/visual/scenes.json`) and records `visual: {status, people, scenes, frames}` in
`project.json`. The UI starts it right after the analysis of a video episode, like the index.

### `transcript-search.pipe` — `chat → embedding_transformer → qdrant → response_documents`

Stock only; the browser uses it to prove the index and it backs any transcript search box.

## Project directory (account file store)

```
projects/<episode>/
  source/<upload>                      the original recording
  project.json                         settings, media, analysis summary, index status, visual scan status, requests summary, clip registry (schema 2)
  status.json                          last stage written by any node
  analysis/media.json                  probe result
  analysis/transcript.json             sentences with absolute start/end + piece provenance
  analysis/windows.json                the parts sent to the LLM
  analysis/index.json                  the passages sent to the semantic index
  analysis/llm-answers.json            raw model answers of the analysis
  analysis/candidates.json             ranked analysis candidates (c01…)
  analysis/chapters.json               topical chapters
  analysis/requests/<rNN>.json         one Prompt Director request: prompt, raw + normalised spec, search query,
                                       candidates (rNNcNN) with per-candidate compliance, rejected proposals, request compliance, raw answers
  analysis/clips/<id>/plan.json        prepared clip: boundaries, words, cuts (id/kind/action/safe/reason/enabled), mutes, keep list, fit report, options
  analysis/clips/<id>/compliance.json  prompt_match, duration requested/final/mode/met, speaker, topic, profanity, complete ending, cut counts, visual gate, warnings
  analysis/clips/<id>/layout.json      visual director plan (schema 1): tracks, activity, speaking intervals, segments, crop paths (keyframes), metrics
  analysis/clips/<id>/pN.jpg           one face thumbnail per tracked person (the "follow this person" chips)
  analysis/visual/people.json          episode-wide people (coverage, timeline, thumbnails analysis/visual/pN.jpg) from visual-scan.pipe
  analysis/visual/scenes.json          shot changes (ms) from ffmpeg's scene score
  edits/clip-edits.json                non-destructive edits (schema 2): boundaries, title, policies, caption preset,
                                       duration target/mode, disabled cuts, layout mode + subject, versions[] + active_version
  previews/<id>.mp4 .jpg .json         fast preview + report
  exports/<id>/…                       final renders, SRT/VTT, thumbnail, report.json
```

Edits are versioned: a conversational revision appends `{n, note, source, …fields}` to
`versions` and sets `active_version`; the candidate itself is never rewritten and the
"original" is always one click away.

## Progress and status

Every custom node calls `update_status()` (`local_nodes/podcast_common/project.py`): it writes
`status.json` and pushes an SSE event of type `podcast` (`{node, stage, …}`) for the running
pipe. The UI shows live events while its `chat()` call is open and polls `status.json`
after a reload until the project reports `analyzed`.

## Shared node code (`local_nodes/podcast_common/`)

`store.py` (sync wrappers over the engine's async file store), `cache.py` (local copy of the
source keyed by path+size+mtime), `project.py` (layout, requests, clip plans, status,
chat-context parsing), `media.py` (ffmpeg/PyAV: probe, slice, silence detection, level
measurement, mastering with mutes, render graph), `clips.py` (chunking, answer parsing,
snapping, text-span location, caption timing), `spec.py` (request spec normalisation +
duration windows), `constraints.py` (director answer parsing, hard constraints, ranking,
compliance), `editing.py` (cut planning + safety, per-cut restore, duration fitting),
`passages.py` (index passages), `captions.py` (ASS/SRT/VTT + presets, seam placement for
stacked layouts), `align.py` (faster-whisper word alignment), `visual.py` (pose keypoints →
faces, tracking, talking cue, layout planning, crop paths, face-safe checks, episode people),
`config.py`.

## Phase 1 release gate — how it is met

| Gate | Where |
| --- | --- |
| Required-topic compliance | `topic_found` asserted by the model per candidate, enforced in `constraints.check_constraints`; reported per clip and per request. |
| Strict duration within ±1 s | `editing.fit_duration` (strict tolerance 1000 ms) + measured `duration_final` written by the renderer. |
| Natural mode never truncates words | fit only ever moves to word ends (plus a tail limited by the gap to the next word). |
| Duplicates removed | overlap > 40 % of a clip's length rejects the lower-ranked proposal. |
| Every result explains itself | `reason`, `quote`, `takeaway`, component scores, rejection reasons, fit actions. |
| Failed constraints → warnings, never fabricated compliance | speaker `null` → "unverified"; missing flags → warnings; the model may return zero candidates with `notes`. |
| Re-runs reuse the transcript | analysis resumes per piece; index and director never transcribe. |

## Phase 2 release gate — how it is met

| Gate | Where |
| --- | --- |
| Active speaker visible | per 500 ms bin the people actually on screen decide the layout; a confident talker (head-motion lead ≥ 1.6× for ≥ 3 s while words are spoken) gets `solo_follow`, otherwise the two most present visible people are stacked; `speaker_visible_pct` in the metrics. |
| Crops never cut faces | the head is estimated from the widest visible pose cue (eye gap, ear gap, nose↔ear in profile) and centred between nose and ears; crop windows are sized from it (a solo window up to ~5 heads tall — the full source height for anyone near the camera; a stacked panel ~3.5 heads, a head-and-shoulders shot so neighbours in a group shot don't appear in both panels), kept inside the frame, headroom 40 %; `face_safe` checks every sampled frame against the interpolated path (`face_cut_violations` / `face_checks`), reported in `compliance.visual` and as a warning. |
| Correct subjects in two-person scenes | stacked pairs are chosen among the people visible in that moment (the weak talker + the most present other), never from a global "top two". |
| Smooth motion | EMA-smoothed centres (α 0.25), dead zone, pan capped at 0.5 window-widths/s, 2 s minimum dwell per layout; `max_pan_widths_per_s` + `smooth` in the metrics. |
| Captions never cover faces | stacked layouts place the caption line on the seam between the panels (`captions.seam_placement`); solo layouts keep the bottom band with the face framed above it. |
| Producer override | `subject: pN` (click a person's thumbnail) forces `solo_follow` on that track; `layout:` forces one layout for the clip; both are saved in the clip edit and survive re-renders. |

## Limits of the key-free visual director

- "Who is talking" comes from head motion gated by word timing (pose keypoints, no audio
  diarization); it is confident on interviews and grids, unsure on static talking heads —
  unsure moments fall back to the stacked layout, never to a wrong solo.
- The screen-share heuristic (every face small and in a corner) also fires on lecture-hall wide
  shots; the producer override covers that case.
- People are tracked per clip; the episode scan lists people by position, not identity.

## Not yet

Speaker diarization (real `speaker_match`, identity-linked active speaker), brand kits / batch
exports / compilations (phase 3), full-episode transcript editing (phase 4), content packs and
cross-episode search (phase 5).

## Podcast Editing Studio (full-episode editor)

Upload raw footage → edit the whole episode by its transcript → polish → preview → export. Clip discovery is
untouched; the studio generalizes the same two custom nodes.

Pipelines (context keys via `parse_context`: `studio: init|preview|export`, `range: a-b` in output ms,
`quality: rough|full`):

    podcast-studio-prepare.pipe   chat → podcast_prepare_clip → response_answers
    podcast-studio-preview.pipe   chat → podcast_prepare_clip → podcast_render → response_answers
    podcast-studio-export.pipe    chat → podcast_prepare_clip → podcast_render → response_answers

Files (all times integer ms on the source timeline; the recording is never modified):

    edits/episode-edits.json            browser-owned instructions: ops (cut / mute / bleep / shorten_silence,
                                        `enabled` = restore), speakers, sections, assets, audio/visual settings
    edits/versions/NNN.json             full snapshots (Save version)
    analysis/studio/timeline.json       full-episode word alignment (+ silences, quiet, low-confidence)
    analysis/studio/waveform.json       RMS peaks per 100 ms for the timeline bar
    analysis/studio/suggestions.json    deterministic cleanup suggestions, nested natural ⊆ balanced ⊆ tight,
                                        never auto-applied
    analysis/studio/prepared-vN.json    the render spec: keep/mutes/bleeps, source↔output map, caption lines
                                        ({start_ms, end_ms, text, speaker, words:[{w,s,e}]}), chapters, assets
    previews/studio/rough-vN.mp4        whole episode at 640 px, cuts applied, no mastering
    previews/studio/range-vN.mp4        an output-range slice with the full chain (mastering + captions)
    exports/studio/vN/                  episode.mp4 (1080p) + extra aspects, episode.mp3/.wav, captions.srt/.vtt,
                                        chapters.txt (;FFMETADATA1) + chapters.json, report.json, parts/ (resumable
                                        ~5 min chunks keyed by a spec hash — a re-run re-encodes only missing parts)

Renderer notes: the studio spec routes before the clip check (it carries `clip_id` for older guards) and takes
its mode from the spec, not the node config; audio is one full-length pass (mutes, 1 kHz bleeps, music ducked
with sidechaincompress); intro / title card / body / end card / outro are concatenated parts, the COMPLETE
programme is assembled first, and two-pass loudnorm runs over the assembled programme so a hot intro or outro
cannot push the finished file off target. The report (schema 2) carries top-level `has_audio`/`has_video`,
`chapters` (array) + `chapter_count`, a `clock` block (mode / quality / range / preview_output_start_ms),
and `loudness` + per-deliverable `measurements` measured on the finished MP4/MP3/WAV with `loudness_ok`
(±1 LU, true peak ≤ −1 dBTP); a rough preview is unmastered and says so (`loudness_ok: null`). Verified end-to-end on `joe-berger-10min` (raw NAMM interview): init 90 s,
rough preview = spec duration exactly, export 96 s at −16.0 LUFS / −1.0 dBTP with a −141 ms duration delta.

UI: `/studio?id=…` — transcript-first editor (select words → cut / mute / bleep, struck-through restore,
speakers, search, chapters), skip-over-cuts source playback, waveform timeline, inspector (cleanup modes,
audio finishing, look, captions, branding, versions, preview/export), suggestions panel. Undo/redo, autosave,
reload-safe. Limitations: speaker labels are manual (no diarization), one camera angle (no active-speaker
switching), suggestions are heuristic (no LLM pass yet).
