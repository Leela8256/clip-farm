"""
The render spec, normalized. Pure functions — no store, no ffmpeg, no engine —
so the whole contract of the node can be exercised in a unit test.

A spec is one JSON document on the text lane. Only `source`, `outputs` and
`write_to` are required; everything else has a documented default:

    {
      "source": "<store path>",                  # the recording to cut from
      "source_range": [start_ms, end_ms],        # decode window; `keep` is relative to it
      "keep":   [[s, e], …],                     # what survives, in source ms
      "map":    [[src_s, src_e, out_s], …],      # source <-> output map (default: from `keep`)
      "window": [out_a, out_b],                  # render only this slice of the output timeline
      "mutes":  [[s, e], …], "bleeps": [[s, e], …],   # both on the SOURCE timeline

      "audio":  {"denoise": true, "highpass": true, "compress": true, "master": true,
                 "loudness_lufs": -16, "true_peak": -1, "channels": 2},
      "music":  {"source": "<store path>", "gain_db": -22, "duck_db": -12, "fade_ms": 1500},
      "overlays": [{"image": "<store path>", "corner": "tr", "height": 0.1, "opacity": 1}],
      "cards":  [{"text": "…", "subtitle": "…", "seconds": 3, "at": "start"|"end"}],
      "concat": [{"source": "<store path>", "at": "start"|"end"}],

      "subtitles": {"words": [{"w"|"word", "s"|"start_ms", "e"|"end_ms", "speaker"}],
                    "groups": [ … ],             # already grouped, on the OUTPUT timeline
                    "style": <CaptionStyle>, "speaker_colors": {}, "sidecars": false,
                    "name": "captions", "map_through_keep": true},

      "framing_plan": <plan>,                    # speaker_framing's plan (`pan`/`layout` also read)

      "outputs": [{"key",                        # the key this file gets in the report
                   "name",                       # file name without the extension
                   "file",                       # or the full file name, extension included
                   "container": "mp4|mp3|wav",
                   "layout"|"aspect"|"width"/"height",   # the shape; `long_edge`/`short_edge` size it
                   "fps_max", "crf", "preset", "captions", "audio_channels", "tier",
                   "fit": "fit"|"fill", "background": "blur"|"#rrggbb",
                   "framing": true|false,        # drive this output with the framing plan
                   "from": "<key>"|"programme_audio"}],   # derive instead of rendering
      "thumbnail": true | {"name", "at_ms"},     # default: on for `clip`, off for `programme`
      "chunking": {"part_ms": 300000, "resume": true},
      "chapters": [{"title", "out_ms"}],         # files are written in `export` mode

      "pipeline": "clip"|"programme",            # default: derived (see choose_pipeline)
      "mode": "preview"|"export",                # a draft to be re-made vs the deliverable
      "quality": "<label>", "title": "…", "version": 3, "name": "…",
      "media": {"width", "height", "fps", "has_video"},   # what the source is (for the report)
      "fit", "background", "long_edge", "aspect",         # defaults for every output
      "write_to": "<store dir>", "report_to": "<store path>", "status_to": "<store path>",
      "cache_key": "<hash>", "cache": true,      # reuse an identical finished preview
      "status_meta": { … added to every progress event … },
      "warnings": [ … ], "meta": { … merged under the report … }
    }

Nothing in here (or anywhere else in the node) knows what the files are for.
"""

from __future__ import annotations

from local_nodes.podcast_common.captions import (
    CAPTION_LAYOUTS,
    group_words,
    group_words_for,
    resolve_caption_style,
    style_is_off,
)

from .render_lib import (
    EPISODE_PART_MS,
    LOUDNESS_TARGET_LUFS,
    TRUE_PEAK_DBTP,
    TimelineMap,
    aspect_dims,
    capped_dims,
    caption_layout_for,
    dims,
    map_words_to_output,
    range_to_keep,
    spec_hash,
)

VIDEO_CONTAINERS = ('mp4', 'mov', 'mkv', 'webm')
AUDIO_CONTAINERS = ('mp3', 'wav', 'm4a', 'aac', 'flac')
LAYOUT_NAMES = ('vertical', 'wide', '9:16', '16:9', '4:5', '1:1')
PROGRAMME_AUDIO = 'programme_audio'          # reserved `from:` — the mastered programme

# Config defaults (services.json fields). They only ever fill in what an
# output left out; a spec that states its encode is never overruled.
DEFAULTS = {'long_edge': 1920, 'fps': 30, 'crf': 20, 'preset': 'veryfast', 'captions': True,
            'sidecars': True, 'part_ms': EPISODE_PART_MS}


def as_ranges(rows) -> list[tuple[int, int]]:
    """[[s, e], …] or [{start_ms, end_ms}, …] -> sorted, non-empty (s, e) pairs."""
    out: list[tuple[int, int]] = []
    for row in rows or []:
        if isinstance(row, dict):
            start, end = row.get('start_ms', row.get('s')), row.get('end_ms', row.get('e'))
        elif isinstance(row, (list, tuple)) and len(row) >= 2:
            start, end = row[0], row[1]
        else:
            continue
        try:
            start, end = int(start), int(end)
        except (TypeError, ValueError):
            continue
        if end > start:
            out.append((start, end))
    return out


def map_from_keep(keep: list[tuple[int, int]]) -> list[list[int]]:
    """The source <-> output map, rebuilt from the keep list when a spec omits it."""
    rows, out = [], 0
    for start, end in keep:
        rows.append([start, end, out])
        out += end - start
    return rows


def resolve_keep(spec: dict) -> dict:
    """
    The keep list this render really cuts, plus the output offset its captions
    live on. A `window` renders only the source slices behind an output-time
    window (the range preview) — everything else renders the whole keep list.
    """
    full = as_ranges(spec.get('keep'))
    source_range = spec.get('source_range') if isinstance(spec.get('source_range'), (list, tuple)) else None
    if not full and source_range:
        full = [(0, int(source_range[1]) - int(source_range[0]))]
    if not full:
        raise ValueError('the spec has no keep segments')
    rows = spec.get('map') or map_from_keep(full)
    window = spec.get('window') if isinstance(spec.get('window'), (list, tuple)) and len(spec.get('window')) == 2 else None
    keep, offset_ms = full, 0
    if window:
        offset_ms = max(0, int(window[0]))
        keep = [(s, e) for s, e in range_to_keep(rows, offset_ms, int(window[1])) if e > s]
        if not keep:
            raise ValueError('the requested window falls entirely inside a cut')
    return {'full_keep': full, 'keep': keep, 'map': rows, 'window': list(window) if window else None,
            'offset_ms': offset_ms, 'body_ms': sum(e - s for s, e in keep),
            'source_range': [int(source_range[0]), int(source_range[1])] if source_range else None}


def choose_pipeline(spec: dict) -> str:
    """
    `clip` — one short piece: a single audio pass (cut, cleaned, mastered) and
    one encode per output.
    `programme` — a long timeline: resumable video parts, an unmastered body
    pass with bleeps and ducked music, lead-in / tail-out material concatenated
    around it and the mastering run LAST over the finished programme.

    Stated with `pipeline:`; derived from the spec's own shape otherwise.
    """
    named = str(spec.get('pipeline') or '').strip().lower()
    if named in ('clip', 'programme'):
        return named
    if (spec.get('chunking') or spec.get('bleeps') or spec.get('music') or spec.get('cards')
            or spec.get('concat') or spec.get('chapters')):
        return 'programme'
    return 'clip'


def normalize_audio(spec: dict) -> dict:
    """The audio chain flags, defaulted the way the renderer has always run them."""
    audio = spec.get('audio') if isinstance(spec.get('audio'), dict) else {}
    return {
        'denoise': bool(audio.get('denoise', audio.get('noise_reduction', True))),
        'highpass': bool(audio.get('highpass', audio.get('high_pass', True))),
        'compress': bool(audio.get('compress', audio.get('compression', True))),
        'master': bool(audio.get('master', True)),
        'loudness_lufs': float(audio.get('loudness_lufs') or LOUDNESS_TARGET_LUFS),
        'true_peak': float(audio.get('true_peak') if audio.get('true_peak') is not None else TRUE_PEAK_DBTP),
        'channels': int(audio.get('channels') or 2),
    }


def _geometry(entry: dict, spec: dict, config: dict) -> tuple[int, int]:
    width, height = entry.get('width'), entry.get('height')
    if width and height:
        return max(2, int(width) // 2 * 2), max(2, int(height) // 2 * 2)
    long_edge = int(entry.get('long_edge') or spec.get('long_edge') or config['long_edge'])
    layout = str(entry.get('layout') or '').strip().lower()
    if layout in LAYOUT_NAMES:
        return dims(layout, long_edge)
    aspect = entry.get('aspect') or spec.get('aspect')
    short_edge = entry.get('short_edge')
    if aspect and short_edge:
        return aspect_dims(aspect, int(short_edge))
    return capped_dims(aspect or '16:9', long_edge)


def normalize_output(entry, index: int, spec: dict, config: dict, has_video: bool = True) -> dict:
    """One entry of `outputs` with every gap filled from the spec and the node config."""
    if isinstance(entry, str):
        entry = {'key': entry, 'layout': entry} if entry in LAYOUT_NAMES else {'key': entry}
    if not isinstance(entry, dict):
        raise ValueError(f'output {index} is not an object')
    layout = str(entry.get('layout') or '').strip().lower() or None
    key = str(entry.get('key') or layout or entry.get('name') or f'out{index + 1}')
    name = str(entry.get('name') or spec.get('name') or key)
    # an output that states a shape is a picture; one that asks for the
    # programme's audio is not; anything else follows the source
    if layout or entry.get('aspect') or (entry.get('width') and entry.get('height')):
        default_container = 'mp4'
    elif entry.get('from') == PROGRAMME_AUDIO:
        default_container = 'mp3'
    else:
        default_container = 'mp4' if has_video else 'mp3'
    container = str(entry.get('container') or default_container).lower().lstrip('.')
    if container not in VIDEO_CONTAINERS + AUDIO_CONTAINERS:
        raise ValueError(f'output {key!r} asks for an unknown container {container!r}')
    video = container in VIDEO_CONTAINERS
    audio_cfg = normalize_audio(spec)
    out: dict = {
        'key': key,
        'name': name,
        'container': container,
        'video': video,
        'layout': layout,
        'aspect': entry.get('aspect'),
        'file': str(entry.get('file') or f'{name}.{container}'),
        'fps': max(1, int(entry.get('fps_max') or entry.get('fps') or config['fps'])),
        'crf': int(entry.get('crf') if entry.get('crf') is not None else config['crf']),
        'preset': str(entry.get('preset') or config['preset']),
        'captions': bool(entry.get('captions', True)) and bool(config['captions']),
        'audio_channels': int(entry.get('audio_channels') or audio_cfg['channels']),
        'tier': str(entry.get('tier') or spec.get('quality') or spec.get('mode') or 'preview'),
        'fit': str(entry.get('fit') or spec.get('fit') or 'fit'),
        'background': entry.get('background') or spec.get('background') or 'blur',
        'framing': entry.get('framing'),
        'from': entry.get('from') or entry.get('derive_from'),
    }
    if video:
        out['width'], out['height'] = _geometry(entry, spec, config)
        caption_layout = entry.get('caption_layout') or (layout if layout in CAPTION_LAYOUTS else None)
        out['caption_layout'] = caption_layout or caption_layout_for(out['width'], out['height'])
        # a framing plan drives the portrait / square passes; a wide pass is
        # letterboxed as it always was unless the output asks for it by name
        if out['framing'] is None:
            out['framing'] = out['height'] >= out['width']
    else:
        out['width'] = out['height'] = 0
        out['caption_layout'] = None
        out['framing'] = False
    return out


def normalize_outputs(spec: dict, config: dict | None = None, has_video: bool = True) -> list[dict]:
    config = {**DEFAULTS, **(config or {})}
    entries = spec.get('outputs')
    if isinstance(entries, (str, dict)):
        entries = [entries]
    if not entries:
        raise ValueError('the spec asks for no outputs')
    outputs = [normalize_output(entry, i, spec, config, has_video) for i, entry in enumerate(entries)]
    if not has_video:
        outputs = [o for o in outputs if not o['video']]
        if not outputs:
            raise ValueError('the source has no picture and the spec asks for no audio output')
    keys = [o['key'] for o in outputs]
    if len(set(keys)) != len(keys):
        raise ValueError(f'two outputs share a key: {sorted(keys)}')
    return outputs


def normalize_words(items) -> list[dict]:
    """Words in either the spec's short form ({w, s, e}) or the caption form."""
    words = []
    for w in items or []:
        if not isinstance(w, dict):
            continue
        word = w.get('word', w.get('w'))
        start, end = w.get('start_ms', w.get('s')), w.get('end_ms', w.get('e'))
        if word is None or start is None or end is None:
            continue
        words.append({'word': str(word), 'start_ms': int(start), 'end_ms': int(end), 'speaker': w.get('speaker')})
    return words


def caption_plan(spec: dict, keep: list[tuple[int, int]] | None = None) -> dict:
    """
    The burned-in / sidecar captions: the caption lines on the OUTPUT timeline,
    the resolved style and the per-speaker colours.

    `words` are on the source timeline and are mapped through the keep list
    (words inside a cut disappear); `groups` are already grouped lines on the
    output timeline (a caller that did its own grouping — one dict per line
    with the timed words nested, or a flat word list per line).
    """
    subs = spec.get('subtitles') if isinstance(spec.get('subtitles'), dict) else {}
    style = resolve_caption_style(subs.get('style') if subs.get('style') is not None else subs.get('preset'))
    groups: list[list[dict]] = []
    raw = subs.get('groups') or []
    if raw:
        if isinstance(raw[0], dict) and isinstance(raw[0].get('words'), list):
            for group in raw:                     # one dict per caption line
                words = normalize_words(group.get('words'))
                for w in words:
                    if w.get('speaker') is None:
                        w['speaker'] = group.get('speaker')
                if words:
                    groups.append(words)
        elif isinstance(raw[0], dict):
            groups = group_words(normalize_words(raw))
        else:
            for group in raw:                     # a list of word lists
                words = normalize_words(group)
                if words:
                    groups.append(words)
    elif subs.get('words'):
        words = normalize_words(subs.get('words'))
        through = subs.get('map_through_keep')
        if through is None:
            through = True
        if through and keep:
            words = map_words_to_output(words, TimelineMap(list(keep)))
        groups = group_words_for(words, style)
    return {
        'groups': groups,
        'style': style,
        'speaker_colors': subs.get('speaker_colors') or {},
        'sidecars': bool(subs.get('sidecars')),
        'name': str(subs.get('name') or ''),
        'enabled': bool(groups) and not style_is_off(style) and bool(subs.get('enabled', True)),
    }


def framing_plan(spec: dict) -> dict | None:
    """The framing plan (speaker_framing's output), whatever shape it arrived in."""
    plan = spec.get('framing_plan') if isinstance(spec.get('framing_plan'), dict) else None
    if plan is None and isinstance(spec.get('layout'), dict):
        plan = spec['layout']                     # the schema-1 name
    if plan is None and spec.get('pan'):
        plan = {'segments': spec.get('segments') or [], 'paths': spec.get('pan')}
    return plan if isinstance(plan, dict) else None


def reframes(plan: dict | None) -> bool:
    """Whether a plan actually moves the picture — a plan of full frames does not."""
    if not isinstance(plan, dict):
        return False
    return any(s.get('layout') not in ('full_frame', 'original') for s in plan.get('segments') or [])


def framing_summary(plan: dict | None, applied: bool) -> dict | None:
    """What the report says about the framing plan it was handed."""
    if not isinstance(plan, dict):
        return None
    return {
        'mode': plan.get('mode'),
        'subject_override': plan.get('subject_override'),
        'applied': bool(applied),
        'segments': [{k: s.get(k) for k in ('start_ms', 'end_ms', 'layout', 'subjects', 'reason')}
                     for s in plan.get('segments') or []],
        'people': [{k: t.get(k) for k in ('id', 'coverage', 'first_ms', 'last_ms', 'mean_center', 'mean_face_h')}
                   for t in plan.get('tracks') or []],
        'thumbnails': plan.get('thumbnails') or {},
        'speaking': plan.get('speaking') or [],
        'metrics': plan.get('metrics') or {},
        'method': plan.get('method'),
        'error': plan.get('error'),
    }


def cache_key_for(spec: dict) -> str:
    """
    Identity of a render: the caller's own `cache_key` when it sets one, the
    hash of the spec minus its volatile fields otherwise. A part already on
    disk under the same key is reused on a re-run.
    """
    given = str(spec.get('cache_key') or '').strip()
    return given or spec_hash(spec, exclude=('window', 'range', 'quality', 'prepared_at', 'warnings',
                                             'status_to', 'report_to', 'meta'))


def part_ms_for(spec: dict, config: dict | None = None) -> int:
    chunking = spec.get('chunking') if isinstance(spec.get('chunking'), dict) else {}
    config = {**DEFAULTS, **(config or {})}
    return max(1000, int(chunking.get('part_ms') or config['part_ms']))


def overlay_for(spec: dict) -> dict | None:
    """The first image overlay (a watermark) — the one the graphs support today."""
    for item in spec.get('overlays') or []:
        if isinstance(item, dict) and (item.get('image') or item.get('path')):
            return {'path': item.get('image') or item.get('path'), 'corner': item.get('corner') or 'tr',
                    'height': item.get('height', 0.10), 'opacity': item.get('opacity', 1.0)}
    return None


def cards_for(spec: dict, at: str) -> list[dict]:
    return [c for c in (spec.get('cards') or [])
            if isinstance(c, dict) and str(c.get('at') or 'start').lower() == at]


def concat_for(spec: dict, at: str) -> list[dict]:
    return [c for c in (spec.get('concat') or [])
            if isinstance(c, dict) and str(c.get('at') or 'start').lower() == at and c.get('source')]
