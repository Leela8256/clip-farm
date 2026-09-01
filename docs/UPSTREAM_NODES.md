# Upstreaming plan — dissolving the custom nodes into RocketRide stock

Goal: every capability in `local_nodes/` either (a) uses a stock node, or (b) is generalized until it IS a
stock node worth a rocketride-server PR. Only app opinions (prompts, ranking rules, edit schemas, UI) stay here.

## The boundary rule
A node is stock-worthy when its contract can be stated without the word "podcast": media in, media/JSON out,
zero knowledge of our store layout, project.json, candidates or compliance. Everything else is app glue and
should live in the browser or a thin adapter.

## The five PRs (priority order)

### PR 1 — `audio_transcribe`: word timestamps + absolute time  (size S–M · unblocks the most)
Extend the existing stock node, no new node:
- `word_timestamps: true` → each sentence document carries `words: [{w, start_ms, end_ms, p}]`
  (faster-whisper supports this natively; include VAD (`vad: true`, `min_silence_ms`) and the
  smear sanitizer we battle-tested: drop long sub-0.2-probability words, cap word length 1.5 s, de-overlap).
- `absolute_time: true` → stamps relative to the *stream start*, not the flush buffer (or expose the
  buffer offset in metadata). This is the root cause `podcast_ingest`'s piece hand-off exists at all.
Deletes from this repo: `align.py`, the piece-offset reconstruction, the studio's piece-wise aligner.

### PR 2 — `media_render`: a generic timeline/EDL renderer  (size L · the flagship)
New stock node, generalized from `podcast_render` + `media.py` (~90 % is already generic):
- Lanes: `text → video|audio|text` (spec in, files/report out; sources are store refs, cached locally).
- Spec (all optional beyond `source` + `output`):
  `{source, keep: [[s,e]], mutes, bleeps, audio: {denoise, highpass, compress, loudness_lufs, true_peak},
  music: {source, gain_db, duck_db, fade_ms}, overlays: [{image|text, corner|pos, size, opacity, range}],
  cards: [{text, subtitle, seconds, at: start|end}], concat: [{source, at: start|end}],
  subtitles: {words|events, style: <style object>, sidecars: bool},
  pan: [{range, window, keyframes}]   # consumes PR-4 output
  output: [{width|height|long_edge, fps_max, crf, preset, container, audio: {channels, codec}}],
  chunking: {part_ms, resume_key}}`
- Report: probed quality block, measured loudness per deliverable, `cached`, warnings.
- Hard-won invariants to carry into the PR: trim+concat never chained xfade; `setsar=1` before concat;
  audio+video cut from one keep list; master the assembled programme, not the body; caption times mapped
  through the keep list. All already regression-tested here.
Deletes: most of `media.py`, both render paths. Our `podcast_render` becomes a thin adapter (project
paths + compliance) until the app writes `media_render` specs directly.

### PR 3 — `audio_diarize`  (size M · needs provider keys)
New stock node: `audio → text` speaker turns `[{speaker, start_ms, end_ms, confidence}]`, provider
profiles `assemblyai | deepgram | pyannote` (local, HF token). Enables real speaker features platform-wide.

### PR 4 — `speaker_framing`  (size M–L)
New stock node generalized from `podcast_layout` + `visual.py`: inputs = pose stream (`text`) + frame
table (`table`) + optional word timing; output = a generic framing plan `{tracks, speaking, segments,
paths}` for any talking-head video, any aspect. Config: aspect(s), min dwell, pan cap, follow mode,
subject override. Pairs with `media_render.pan`. Nothing podcast-specific inside today except file paths.

### PR 5 — `media_probe` + `media_slice` utilities  (size S)
Tiny stock nodes: probe (duration/fps/dims/streams as JSON) and slice/downscale (range + scale + fps →
small copy on the video/audio lane). Deletes the last of `podcast_ingest` once PR 1 lands.

Optional later: `transcript_cleanup` (words in → suggested edit ops out — fillers/pauses/false starts/
repeats). Valuable but language-opinionated; fine to keep app-side meanwhile.

## What stays app-side, permanently
`podcast_segment`'s question building, `podcast_refine`'s constraints/ranking/compliance, request/edit/
brand schemas, suggestion policy, the Prompt Director and Draft-an-edit prompts, all UI. These encode
*this product's* opinions; upstreaming them would make bad stock nodes.

## Migration path (keeps the shipping app green throughout)
1. Generalize in place: refactor each node's core to the generic contract with the podcast adapter around
   it (render is already ~there; framing needs path/store references removed from `visual.py` — it has none).
2. Extract to `nodes-contrib/<node>/` matching rocketride-server's layout (services.json + IGlobal/IInstance
   + tests), imported by the adapter so one implementation serves both.
3. PR upstream one at a time, PR 1 first. Each merge: switch the pipe to the stock node, delete the adapter.
4. End state: `local_nodes/` shrinks to (at most) one thin `podcast_glue` node or nothing, with the app
   driving stock pipelines: probe/slice → transcribe(words, absolute) → [diarize] → embeddings/qdrant/llm →
   frame_grabber/pose → speaker_framing → media_render.
