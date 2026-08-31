# Multitrack studio — design note for the next milestone

Status: **design only. Nothing here is implemented, and nothing here should be implemented in the current
hardening phase.** Written 2026-08-31 alongside `docs/MARKET_NOTES.md`.

## What is true today (say this out loud before designing anything)

- **One episode = one mixed recording.** `projects/<episode>/source/<upload>` is a single file. Everything
  downstream — `analysis/studio/timeline.json`, `waveform.json`, the prepared spec, the renderer — assumes one
  audio stream and one video stream on one source timeline.
- **Separate-track ingest does not exist in this repo.** There is no track id, no per-track store path, no
  sync model, no per-track settings. Upload accepts one file per episode.
- **There is no diarization.** Speakers are painted by hand: `speakers: Record<id, {name, color}>` plus
  `speaker_map: [start_ms, end_ms, speaker_id][]` in `edits/episode-edits.json`. No AssemblyAI, Deepgram or
  pyannote credential is configured for this project today, and
  no such code path exists.
- **The visual director is reframing, not switching.** Pose-keypoint tracking picks `solo_follow` or a stacked
  pair and moves a crop window inside the one image; fit/fill adapts that image to an aspect. It has no second
  camera to cut to. **This must never be presented as automatic multicam.** Descript's own documentation makes
  the requirement explicit: a multi-track sequence with separate camera tracks, plus a manual mapping of each
  audio track to its camera. We satisfy neither condition. Marketing our crop as multicam would be a false
  capability claim, and it is also the sort of claim a customer discovers in about ten seconds.
- **Ops are a flat set, not a sequence.** `operations[]` are subtractions (cut / mute / bleep /
  shorten_silence) on the source timeline. There is no construct that can express "move this section earlier"
  or "insert a sponsor read here". Reordering is therefore not a small feature — it is a different data model.

## Why it is deferred

Three independent blockers, any one of which is enough:

1. **Ingest.** Multiple synchronized files per episode changes upload, the project layout, the analysis stage
   and the render graph. That is a milestone, not a patch.
2. **A paid dependency.** Camera-to-speaker assignment is only useful with reliable diarization, which needs a
   third-party key this product does not have. Choosing that vendor is a product/commercial decision.
3. **The current phase is a correctness audit.** Clock, fail-closed persistence, version restore, suggestion
   safety, final-program mastering. Adding a structural feature on top of defects being fixed underneath is
   how you get a second round of defects.

## Target model

### Tracks

```
projects/<episode>/
  source/tracks/<track_id>/<upload>      one file per track (immutable, as today)
  tracks.json                            the manifest below
```

```jsonc
{
  "schema_version": 1,
  "episode_id": "…",
  "clock": { "reference_track": "t1", "duration_ms": 3612480 },
  "tracks": [
    {
      "id": "t1",
      "kind": "mic" | "camera" | "screen" | "mix" | "music",
      "label": "Host mic",
      "file": "source/tracks/t1/host.wav",
      "has_audio": true, "has_video": false,
      "offset_ms": 0,                 // signed; add to track time to get episode time
      "drift_ppm": 0,                 // optional linear clock drift correction
      "sync": { "method": "declared" | "timecode" | "cross_correlation", "confidence": 0.0 },
      "speaker_id": "s1",             // mic tracks only; the link diarization does not have to guess
      "camera_of": ["s1"],            // camera tracks only; which speakers this camera shows
      "settings": { "muted": false, "gain_db": 0.0, "enhance": false, "noise_reduction": true, "high_pass": true },
      "export": { "stem": false }
    }
  ]
}
```

**Track ids and clock sync.** One track is the **reference** and defines episode time; `episode_ms =
track_ms + offset_ms` (with an optional ppm drift term for long recordings from unlocked devices). Offsets
come from the recorder when it declares them, otherwise from audio cross-correlation of the first minutes,
and the manifest records which method was used and how confident it was — a guessed offset must be visible
and editable, never silently trusted. **The existing `PlaybackClock` stays the single source of truth for
source↔output conversion; multitrack adds one layer *below* it** (track time → episode/source time) and
changes nothing about output-time mapping. Every time value written anywhere stays an integer millisecond on
the episode timeline, exactly as today.

**Sync failure is a first-class state.** If cross-correlation cannot lock a track (confidence below
threshold), the track is ingested but marked unsynced, is excluded from automatic camera switching, and the
producer is asked to nudge it. Silently misaligning a guest's audio by 400 ms is worse than admitting we
could not align it.

### Diarization → microphone tracks

- **With per-speaker mic tracks, diarization is largely unnecessary**: the loudest track at a moment is the
  speaker, and `speaker_id` on the track is the answer. This is the strongest argument for doing multitrack
  ingest *before* buying a diarization vendor. A gated-energy dominance detector (per 20 ms frame, hysteresis
  and a minimum dwell so crosstalk does not chatter) produces `speaking_intervals` per track and is
  deterministic, key-free and explainable.
- **Diarization is needed only for mixed or shared-mic tracks.** Then: one vendor call (AssemblyAI, Deepgram
  or pyannote — **a key this repo does not have**), producing anonymous `spk_0…spk_n` segments that are mapped
  onto our `speakers` record. The mapping must be producer-confirmable, and the existing manual
  `speaker_map` stays the fallback and the override — a diarizer's opinion never overwrites a human's label.
- Output lands in `analysis/studio/speakers.json` (`{schema_version, source: "tracks" | "diarizer:<name>",
  intervals: [[start_ms, end_ms, speaker_id, confidence]]}`), and `edits.speaker_map` continues to be the
  producer-owned truth layered on top of it.

### Camera-to-speaker assignment

Explicit, in `tracks.json` (`camera_of`), and surfaced as a simple "who does this camera show?" step at
ingest — mirroring the industry's manual camera-setup step rather than guessing. A camera may list several
speakers (a two-shot) or none (a wide/cutaway). The switcher then becomes a decision over real inputs:

- The active speaker (from track dominance or diarization) selects the camera whose `camera_of` contains them.
- Two speakers overlapping → a camera showing both if one exists, otherwise a stacked layout of two cameras.
- Nobody clearly speaking → the wide/cutaway camera, or hold the previous shot.
- **Minimum dwell** (reuse the existing 2 s rule from the visual director) and a cut-rate cap so it does not
  strobe; the existing "unsure → stacked, never a wrong solo" principle carries over unchanged.

Every decision is recorded with its reason, and the producer can pin a shot for any range. A pinned shot wins.

### Scenes and layouts

A scene is a range of episode time with a look. Scenes are **derived then editable**: the switcher proposes
them, the producer edits them, and the edited version is what renders.

```jsonc
"scenes": [
  { "id": "sc1", "start_ms": 0, "end_ms": 42000,
    "layout": "solo" | "stacked" | "grid" | "screen_focus" | "picture_in_picture",
    "sources": ["t2"], "pinned": false, "reason": "s1 speaking 96%" }
]
```

Layouts stay a closed, named set (adding one is a render change, not a config field). Per-scene branding and
caption placement reuse what the clip renderer already does — including seam placement for stacked layouts so
captions never cover a face.

### Screen-share priority

With a real `kind: "screen"` track, share handling stops being a heuristic about small cornered faces:

- While the screen track carries content, the default layout is `screen_focus` (share large, active speaker
  inset), with an explicit priority order: **producer pin > screen share > active speaker > wide**.
- Share start/end come from the track's own presence plus a change detector for long static stretches, so a
  share that sits idle for ten minutes can drop back to faces.
- The current pixel heuristic stays only as the single-track fallback, and keeps its producer override.

### Per-track audio

Per track: mute, gain (dB), noise reduction, high-pass, and (if we ever license one) enhancement — each a
reversible switch in `tracks[].settings`, each applied when the mix is assembled. Crosstalk gating (duck a mic
while it is not the dominant speaker) is the one processing feature that only multitrack can offer, and it is
the one most worth building. **Mastering does not move**: per-track processing → mix → assemble the complete
program (intro, cards, body, outro) → two-pass loudnorm over the assembled program → measure the delivered
file. The final-mastering rule established in the current phase is a prerequisite for this work, not a
casualty of it.

Export gains optional **stems**: `exports/studio/vN/stems/<track_id>.wav` for tracks with `export.stem`.

### An ordered sequence (EDL)

The real unlock, and the reason reordering and sponsor inserts are one feature rather than two. Additive to
`edits/episode-edits.json` — `schema_version` goes to 2 and gains one optional field:

```jsonc
"sequence": [
  { "id": "q1", "kind": "recording", "track_group": "main", "src_start_ms": 0, "src_end_ms": 812000, "enabled": true },
  { "id": "q2", "kind": "insert", "asset": "assets/sponsor-a.mp3", "duration_ms": 38000,
    "transition_in": { "type": "crossfade", "ms": 250 }, "under_video": "hold" },
  { "id": "q3", "kind": "recording", "track_group": "main", "src_start_ms": 812000, "src_end_ms": 3612480, "enabled": true }
]
```

- **Ops stay source-anchored.** `operations[]` keeps referring to source ms and keeps working exactly as it
  does now; the sequence decides which spans of source appear and in what order. This is what keeps the whole
  existing suggestion, proposal, correction and restore machinery valid.
- **Output time is computed by walking the sequence**, applying each item's surviving spans in order. The
  prepared spec's `[[src_s, src_e, out_s]]` map already has exactly the right shape to express a reordered
  program — `sourceToOutput` becomes many-to-one and must return the *first* occurrence, which is the only
  behavioural change the clock needs.
- **Moving a section** = reordering sequence items (sections already exist in `edits.sections`). **A sponsor
  read** = an `insert` item. **A pre-roll** = an insert at index 0. Ad markers for dynamic insertion are the
  natural follow-on.
- Inserts carry their own transitions; the renderer already concatenates parts (intro / card / body / card /
  outro), so an insert is a part with a position rather than a new mechanism.

## Migration path (old projects must keep working)

1. **No `tracks.json` → the project is single-recording.** Every reader treats the absence of the manifest as
   "one implicit track" (`id: "t0"`, `kind: "mix"`, `offset_ms: 0`, reference). Nothing about existing
   projects changes on disk, and no migration job runs.
2. **`sequence` is optional.** Absent → the implicit sequence is one `recording` item spanning the whole
   source, which is exactly today's behaviour. `schema_version` 1 files load unchanged; writers only emit
   `sequence` once a producer reorders or inserts something.
3. **`scenes` is optional.** Absent → the current single-look rendering. A single-track project can never
   produce a `solo`/`stacked` scene across cameras, and the UI must not offer it.
4. **The clock is extended, not replaced.** `PlaybackClock` keeps its three modes and its map; track offsets
   resolve *before* it, and sequence order resolves *inside* the map the prepare node already writes.
5. **Version snapshots stay whole-record.** `edits/versions/NNN.json` snapshots include whatever fields
   existed at the time; `restoreVersion` already copies content wholesale, so restoring a pre-multitrack
   snapshot into a multitrack project simply drops back to the implicit sequence — which is correct, and
   should be stated in the restore confirmation.
6. **The renderer branches once, early**: manifest present and more than one track → assemble from tracks;
   otherwise the existing single-source path, byte-for-byte. No dual maintenance of the audio chain.

## What must not be claimed until this ships

- No "multicam", "camera switching" or "active speaker cuts" language for the current single-camera reframing.
- No "automatic speaker detection" — labels are manual today.
- No "multitrack" or "stems" anywhere in the product surface.
- No "screen share detection" beyond "we guess from the picture, and you can override it".
