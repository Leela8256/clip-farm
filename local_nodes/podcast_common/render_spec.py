"""
The app's translation into the GENERIC render spec.

`media_render` knows nothing about clips, episodes, candidates or the project
layout: it is handed one JSON document that says which file to cut, what to
cut out of it, how the sound is finished, what to burn in, which deliverables
to write and where they go. Everything in this module turns *our* records —
a prepared clip plan (`analysis/clips/<id>/plan.json`) or a prepared episode
(`analysis/studio/prepared-v<n>.json`) — into that document.

The spec (all keys optional beyond `source`, `keep`, `outputs`, `write_to`):

    {"schema_version": 1, "kind": "media_render_spec",
     "source": "<store path>", "media": {"width", "height", "fps", "duration_ms", "has_video"},
     "keep":  [[start_ms, end_ms], ...],        # SOURCE timeline, one list for audio AND picture
     "mutes": [[a, b]], "bleeps": [[a, b]],     # source timeline too
     "audio": {"denoise", "highpass", "compress", "master", "loudness_lufs", "true_peak",
               "channels", "crossfade_ms"},
     "music": {"source", "gain_db", "duck_db", "fade_ms"} | null,
     "overlays": [{"image", "corner", "height", "opacity"}],
     "cards":   [{"text", "subtitle", "seconds", "at": "start|end"}],
     "concat":  [{"source", "at": "start|end"}],
     "subtitles": {"words": [{w, s, e, speaker}] | "groups": [line dicts],
                   "style": <CaptionStyle>, "speaker_colors": {}, "enabled": bool,
                   "sidecars": bool, "map_through_keep": bool, "files": {"srt", "vtt"}},
     "framing_plan": <layout.json>, "framing_offset_ms": int,   # see below
     "outputs": [{"name", "file", "width", "height", "fps_max", "crf", "preset", "container",
                  "audio_channels", "captions", "caption_layout", "framing", "fit", "background",
                  "transcode_from", "primary"}],
     "thumbnail": {"name", "file"} | null,
     "chunking": {"part_ms", "resume_key", "parts_to"} | null,
     "chapters": [{"title", "out_ms"}], "chapter_files": bool,
     "write_to": "<store dir>", "report_to": "<store path>", "status_to": "<store path>",
     "cache_key": "<hash>" | null,
     "meta": {...}}

Notes that are contract, not decoration:

* One timebase. `keep`, `mutes`, `bleeps` and `subtitles.words` are all on the
  SOURCE timeline; the rendered timeline is what falls out of `keep`.
* `subtitles.map_through_keep` says whether the words still have to be mapped
  through the keep list (a clip: yes) or already sit on the output timeline (a
  prepared episode: no).
* `framing_plan` keeps its own clock — the clip's, starting at 0, because the
  frames it was planned from came from a copy that started there.
  `framing_offset_ms` is where that zero sits on the source timeline.
* Assembly order is fixed: concat(at=start), cards(at=start), body,
  cards(at=end), concat(at=end). `chapters` and `subtitles` are on the BODY's
  output timeline; the renderer shifts them by whatever lead-in it added.
* `meta` is echoed into the report verbatim: it is how the caller gets
  its own vocabulary (clip id, version, title, tier) back out of a node that
  does not speak it.
"""

from __future__ import annotations

from .captions import CAPTION_LAYOUTS, resolve_caption_style, style_is_off
from .media import (
    CLIP_ASPECTS,
    EPISODE_PART_MS,
    LAYOUTS,
    aspect_dims,
    dims,
    range_to_keep,
    spec_hash,
)

SPEC_SCHEMA = 1
SPEC_KIND = 'media_render_spec'
LOUDNESS_TARGET_LUFS = -16.0
TRUE_PEAK_DBTP = -1.0


def _flag(value, default: bool = False) -> bool:
    """The engine hands booleans through as text as often as not."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def is_render_spec(data) -> bool:
    return isinstance(data, dict) and data.get('kind') == SPEC_KIND


def preview_cache_key(prepared: dict, tier: dict, rng=None) -> str:
    """
    Identity of a finished preview: the same edit (spec hash), the same encode
    (tier) and the same window. Anything else has to be rendered again — a
    cached picture of a different tier is the wrong picture.
    """
    import hashlib

    window = f'{int(rng[0])}-{int(rng[1])}' if rng else 'full'
    blob = f"{spec_hash(prepared)}|{tier.get('tier')}|{window}"
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()[:16]


def render_spec(*, source: str, keep, outputs, write_to: str, report_to: str, media=None, mutes=(), bleeps=(),
                audio=None, music=None, overlays=(), cards=(), concat=(), subtitles=None,
                framing_plan=None, framing_offset_ms: int = 0, framing=None, pan=None, thumbnail=None,
                chunking=None, chapters=(), chapter_files: bool = False, status_to=None,
                cache_key=None, report_meta=None) -> dict:
    """The document above, with every optional part normalised to a stable shape."""
    return {
        'schema_version': SPEC_SCHEMA,
        'kind': SPEC_KIND,
        'source': str(source),
        'media': {k: (media or {}).get(k) for k in ('width', 'height', 'fps', 'duration_ms', 'has_video')},
        'keep': [[int(s), int(e)] for s, e in keep if int(e) > int(s)],
        'mutes': [[int(s), int(e)] for s, e in (mutes or []) if int(e) > int(s)],
        'bleeps': [[int(s), int(e)] for s, e in (bleeps or []) if int(e) > int(s)],
        'audio': dict(audio or {}),
        'music': dict(music) if isinstance(music, dict) and music.get('source') else None,
        'overlays': [dict(o) for o in (overlays or []) if isinstance(o, dict) and o.get('image')],
        'cards': [dict(c) for c in (cards or []) if isinstance(c, dict)],
        'concat': [dict(c) for c in (concat or []) if isinstance(c, dict) and c.get('source')],
        'subtitles': dict(subtitles) if isinstance(subtitles, dict) else None,
        'framing_plan': framing_plan if isinstance(framing_plan, dict) else None,
        'framing_offset_ms': int(framing_offset_ms or 0),
        'framing': dict(framing) if isinstance(framing, dict) else None,
        'pan': list(pan) if pan else None,
        'outputs': [dict(o) for o in outputs],
        'thumbnail': dict(thumbnail) if isinstance(thumbnail, dict) else None,
        'chunking': dict(chunking) if isinstance(chunking, dict) else None,
        'chapters': [{'title': c.get('title'), 'out_ms': int(c.get('out_ms') or 0)}
                     for c in (chapters or []) if isinstance(c, dict)],
        'chapter_files': bool(chapter_files),
        'write_to': str(write_to),
        'report_to': str(report_to),
        'status_to': str(status_to) if status_to else None,
        'cache_key': str(cache_key) if cache_key else None,
        'meta': dict(report_meta or {}),
    }


# ------------------------------------------------------------------ helpers


def clip_audio(loudness_lufs: float = LOUDNESS_TARGET_LUFS, true_peak: float = TRUE_PEAK_DBTP) -> dict:
    """A short piece is always cleaned and mastered — that is what a clip is for."""
    return {'denoise': True, 'highpass': True, 'compress': True, 'master': True,
            'loudness_lufs': float(loudness_lufs), 'true_peak': float(true_peak), 'channels': 2}


def logo_overlay(assets: dict | None) -> list[dict]:
    logo = (assets or {}).get('logo')
    if not isinstance(logo, dict) or not logo.get('path'):
        return []
    overlay = {'image': logo['path']}
    for key in ('corner', 'height', 'opacity'):
        if logo.get(key) not in (None, ''):
            overlay[key] = logo[key]
    return [overlay]


def music_block(assets: dict | None, enabled: bool = True) -> dict | None:
    music = (assets or {}).get('music')
    if not enabled or not isinstance(music, dict) or not music.get('path'):
        return None
    block = {'source': music['path']}
    for key in ('gain_db', 'duck_db', 'fade_ms'):
        if music.get(key) not in (None, ''):
            block[key] = music[key]
    return block


def short_words(words) -> list[dict]:
    """The renderer's word shape: {w, s, e, speaker}."""
    out = []
    for w in words or []:
        if not isinstance(w, dict):
            continue
        word = w.get('word', w.get('w'))
        start, end = w.get('start_ms', w.get('s')), w.get('end_ms', w.get('e'))
        if word is None or start is None or end is None:
            continue
        item = {'w': str(word), 's': int(start), 'e': int(end)}
        if w.get('speaker') is not None:
            item['speaker'] = w['speaker']
        out.append(item)
    return out


def shift_caption_lines(lines, offset_ms: int, window_ms: int | None = None) -> list[dict]:
    """Caption LINES (the studio's shape) moved onto a window's own timeline, dropping what falls outside."""
    out: list[dict] = []
    for line in lines or []:
        if not isinstance(line, dict):
            continue
        start, end = int(line.get('start_ms') or 0) - offset_ms, int(line.get('end_ms') or 0) - offset_ms
        if end <= 0 or (window_ms is not None and start >= window_ms):
            continue
        words = []
        for w in line.get('words') or []:
            ws, we = int(w.get('s', 0)) - offset_ms, int(w.get('e', 0)) - offset_ms
            if we <= 0 or (window_ms is not None and ws >= window_ms):
                continue
            ws = max(0, ws)
            if window_ms is not None:
                we = min(window_ms, we)
            if we > ws:
                words.append({**w, 's': ws, 'e': we})
        start = max(0, start)
        if window_ms is not None:
            end = min(window_ms, end)
        if end > start:
            out.append({**line, 'start_ms': start, 'end_ms': end, 'words': words})
    return out


def caption_layout_of(shape: str, layout: str) -> str:
    return shape if shape in CAPTION_LAYOUTS else layout


# --------------------------------------------------------------- the clip


def clip_outputs(clip_id: str, *, layouts: list[str], aspect: str, size: int, fps: int, crf: int,
                 preset: str, captions_on: bool, export: bool, has_video: bool) -> list[dict]:
    """
    One entry per rendered file, named exactly as the clip flow has always named
    them: a preview's first pass is `<clip>.mp4` (what a player asks for), every
    other pass carries its layout.
    """
    if not has_video:
        return [{'name': 'audio', 'file': f'{clip_id}.mp3', 'container': 'mp3', 'audio_channels': 2,
                 'tier': 'clip-export' if export else 'clip-preview',
                 'captions': False, 'primary': True}]
    outputs = []
    for i, layout in enumerate(layouts):
        # the shape the pass really renders: an aspect reshapes the vertical pass only
        shape = aspect if (layout == 'vertical' and aspect in ('4:5', '1:1')) else layout
        width, height = dims(shape, size)
        name = f'{clip_id}.mp4' if (not export and i == 0) else f'{clip_id}_{layout}.mp4'
        outputs.append({'name': layout, 'file': name, 'width': width, 'height': height,
                        'tier': 'clip-export' if export else 'clip-preview',
                        'fps_max': int(fps), 'crf': int(crf), 'preset': str(preset), 'container': 'mp4',
                        'audio_channels': 2, 'captions': bool(captions_on),
                        'caption_layout': caption_layout_of(shape, layout),
                        # only the upright pass follows a framing plan, as it always has
                        'framing': layout == 'vertical', 'fit': 'crop', 'primary': i == 0})
    return outputs


def clip_framing(plan: dict, *, write_to: str, thumbnails_to: str, status_to=None,
                 detect_width: int = 640) -> dict:
    """
    What the framing node needs to plan the crops of a clip. Its clock is the
    CLIP's (0 = the clip's first frame), because the frames it sees come from a
    copy that starts there; `source_offset_ms` is where that zero sits on the
    recording. The words are named here for the same reason: the spec's
    subtitles are on the recording's timeline, these are not.
    """
    options = plan.get('options') or {}
    aspect = str(options.get('aspect') or '9:16').strip()
    framing = {
        'layout': options.get('layout_mode') or 'auto',
        'aspect': aspect if aspect in CLIP_ASPECTS else '9:16',
        'source_offset_ms': int(plan['start_ms']),
        'duration_ms': int(plan['duration_ms']),
        'words': plan.get('words') or [],
        'detect_width': int(detect_width),
        'write_to': write_to,
        'thumbnails_to': thumbnails_to,
        'status_to': status_to or '',
        'echo': {'clip_id': str(plan['clip_id'])},
    }
    if options.get('subject'):
        framing['subject'] = options['subject']
    if isinstance(options.get('focus'), dict):
        framing['focus'] = options['focus']
    return framing


def clip_render_spec(plan: dict, *, encode: dict, write_to: str, report_to: str, status_to=None,
                     framing: dict | None = None) -> dict:
    """
    A prepared clip plan -> the generic spec. The plan's own timeline starts at
    the clip; the spec's starts at the recording, so everything is shifted by
    `start_ms` on the way out and the renderer never has to be told where the
    clip begins.
    """
    options = plan.get('options') or {}
    media = plan.get('media') or {}
    clip_id = str(plan['clip_id'])
    start, end = int(plan['start_ms']), int(plan['end_ms'])
    export = str(encode.get('mode') or 'preview').lower() == 'export'

    wanted = str(options.get('layouts') or encode.get('layouts') or 'vertical')
    layouts = [l.strip() for l in wanted.split(',') if l.strip() in LAYOUTS] or ['vertical']
    aspect = str(options.get('aspect') or '9:16').strip()
    if aspect not in CLIP_ASPECTS:
        aspect = '9:16'
    preset_name = str(options.get('caption_preset') or 'classic')
    style = resolve_caption_style(options.get('caption_style') or preset_name)
    captions_on = (_flag(options.get('captions'), True) and not style_is_off(style)
                   and bool(encode.get('captions', True)))
    has_video = bool(media.get('has_video', True))

    keep = [[start + int(s), start + int(e)] for s, e in (plan.get('keep') or [[0, end - start]])]
    mutes = [[start + int(s), start + int(e)] for s, e in (plan.get('mutes') or [])]
    words = [{**w, 's': w['s'] + start, 'e': w['e'] + start} for w in short_words(plan.get('words'))]

    outputs = clip_outputs(clip_id, layouts=layouts, aspect=aspect, size=int(encode.get('size') or 960),
                           fps=int(encode.get('fps') or 30), crf=int(encode.get('crf') or 28),
                           preset=str(encode.get('preset') or 'ultrafast'), captions_on=captions_on,
                           export=export, has_video=has_video)
    subtitles = {'words': words, 'style': style, 'enabled': bool(captions_on),
                 'sidecars': bool(encode.get('sidecars')), 'map_through_keep': True,
                 'files': {'srt': f'{clip_id}.srt', 'vtt': f'{clip_id}.vtt'}}
    return render_spec(
        source=str(plan['source']), media=media, keep=keep, mutes=mutes, outputs=outputs,
        audio=clip_audio(), overlays=logo_overlay(options.get('assets')), subtitles=subtitles,
        framing_offset_ms=start, framing=framing,
        thumbnail={'name': 'thumbnail', 'file': f'{clip_id}.jpg'} if has_video else None,
        write_to=write_to, report_to=report_to, status_to=status_to,
        report_meta={
            'kind': 'clip', 'mode': 'export' if export else 'preview', 'project': plan.get('project'),
            'episode_id': plan.get('episode_id'), 'clip_id': clip_id, 'title': plan.get('title'),
            'candidate': plan.get('candidate'), 'request_id': plan.get('request_id'),
            'version': plan.get('version'), 'aspect': aspect, 'layouts': layouts,
            'caption_preset': (style.get('preset') or preset_name) if captions_on else 'off',
            'caption_style': style, 'brand': plan.get('options', {}).get('brand'),
            'start_ms': start, 'end_ms': end, 'source_duration_ms': end - start,
            'plan': {'fit': plan.get('fit')},
        },
    )


# -------------------------------------------------------------- the studio


def studio_preview_name(version: int, rng=None) -> str:
    """A preview's file name: one slot per kind, so a re-render replaces its own picture."""
    return f'range-v{int(version)}' if rng else f'standard-v{int(version)}'


def studio_outputs(*, export: bool, has_video: bool, tier: dict, aspect: str, extras: list,
                   captions_on: bool, preview_name: str, fit: str, background: str) -> list[dict]:
    """The episode's deliverables: one picture, the alternate shapes, and the audio masters."""
    width, height, fps = int(tier['width']), int(tier['height']), int(tier['fps'])
    crf, preset, channels = int(tier['crf']), str(tier['preset']), int(tier['channels'])
    if not export:
        return [{'name': 'preview', 'file': f"{preview_name}.{'mp4' if has_video else 'mp3'}",
                 'tier': tier.get('tier'),
                 'width': width, 'height': height, 'fps_max': fps, 'crf': crf, 'preset': preset,
                 'container': 'mp4' if has_video else 'mp3', 'audio_channels': channels,
                 'captions': bool(captions_on and has_video), 'fit': fit, 'background': background,
                 'primary': True}]
    outputs = [{'name': 'episode', 'file': 'episode.mp4' if has_video else 'episode-audio.mp3',
                'tier': tier.get('tier'),
                'width': width if has_video else None, 'height': height if has_video else None,
                'fps_max': fps, 'crf': crf, 'preset': preset,
                'container': 'mp4' if has_video else 'mp3', 'audio_channels': channels,
                'captions': bool(captions_on and has_video), 'fit': fit, 'background': background,
                'primary': True}]
    if has_video:
        for extra in extras:
            tag = str(extra).replace(':', 'x')
            ew, eh = aspect_dims(extra, min(width, height))
            outputs.append({'name': f'episode_{tag}', 'file': f'episode-{tag}.mp4', 'width': ew, 'height': eh,
                            'fps_max': fps, 'crf': crf, 'preset': preset, 'container': 'mp4',
                            'audio_channels': channels, 'captions': False, 'fit': fit,
                            'background': background, 'transcode_from': 'episode'})
    outputs.append({'name': 'mp3', 'file': 'episode.mp3', 'container': 'mp3', 'audio_channels': channels,
                    'captions': False, 'transcode_from': 'audio'})
    outputs.append({'name': 'wav', 'file': 'episode.wav', 'container': 'wav', 'audio_channels': channels,
                    'captions': False, 'transcode_from': 'audio'})
    return outputs


def studio_render_spec(prepared: dict, *, tier: dict, write_to: str, report_to: str, status_to=None,
                       assets: dict | None = None, warnings=None, cache_key: str | None = None,
                       parts_to: str | None = None) -> dict:
    """
    A prepared episode (`analysis/studio/prepared-v<n>.json`) -> the generic
    spec. The tier decides the encode and what the pass is allowed to include
    (music and cards belong to the full renders, not the quick one); a range
    preview is resolved here into the source slices behind the window, so the
    renderer only ever sees a keep list.
    """
    mode = 'export' if str(prepared.get('mode') or '').lower() == 'export' else 'preview'
    export = mode == 'export'
    version = int(prepared.get('version') or 1)
    media = prepared.get('media') or {}
    has_video = bool(media.get('has_video', True))
    visual = prepared.get('visual') or {}
    audio_cfg = prepared.get('audio') or {}
    assets = assets if isinstance(assets, dict) else (prepared.get('assets') or {})
    aspect = str(visual.get('aspect_ratio') or '16:9')
    fit = str(visual.get('fit') or 'fit')
    background = visual.get('background') or 'blur'
    captions = prepared.get('captions') if isinstance(prepared.get('captions'), dict) else {}
    lines = [g for g in (captions.get('groups') or []) if isinstance(g, dict)]

    full_keep = [(int(s), int(e)) for s, e in (prepared.get('keep') or []) if int(e) > int(s)]
    rng = prepared.get('range') if isinstance(prepared.get('range'), (list, tuple)) and len(prepared.get('range')) == 2 else None
    offset_ms = 0
    keep = full_keep
    if not export and rng:
        offset_ms = max(0, int(rng[0]))
        keep = [(s, e) for s, e in range_to_keep(prepared.get('map') or [], offset_ms, int(rng[1])) if e > s]
        lines = shift_caption_lines(lines, offset_ms)
    body_ms = sum(e - s for s, e in keep)

    captions_on = bool(visual.get('captions', True)) and bool(lines)
    preview_name = studio_preview_name(version, rng)
    outputs = studio_outputs(export=export, has_video=has_video, tier=tier, aspect=aspect,
                             extras=[a for a in (prepared.get('extra_aspects') or []) if str(a) != aspect],
                             captions_on=captions_on, preview_name=preview_name, fit=fit,
                             background=background)

    cards, concat = [], []
    if tier.get('cards'):
        if isinstance(assets.get('intro'), dict) and assets['intro'].get('path'):
            concat.append({'source': assets['intro']['path'], 'at': 'start'})
        title_card = assets.get('title_card') if isinstance(assets.get('title_card'), dict) else None
        if title_card:
            cards.append({'text': title_card.get('text') or prepared.get('title') or '',
                          'subtitle': title_card.get('subtitle') or '',
                          'seconds': float(title_card.get('seconds') or 3), 'at': 'start'})
        end_card = assets.get('end_card') if isinstance(assets.get('end_card'), dict) else None
        if end_card:
            cards.append({'text': end_card.get('text') or '', 'subtitle': end_card.get('subtitle') or '',
                          'seconds': float(end_card.get('seconds') or 3), 'at': 'end'})
        if isinstance(assets.get('outro'), dict) and assets['outro'].get('path'):
            concat.append({'source': assets['outro']['path'], 'at': 'end'})

    style = captions.get('style') or visual.get('caption_style') or {}
    subtitles = {'groups': lines, 'style': style, 'speaker_colors': captions.get('speaker_colors') or {},
                 'enabled': bool(captions_on), 'sidecars': bool(export and lines),
                 'map_through_keep': False, 'files': {'srt': 'captions.srt', 'vtt': 'captions.vtt'}}
    clean = tier.get('clean') or (True, True, True)
    audio = {'denoise': bool(clean[0]), 'highpass': bool(clean[1]), 'compress': bool(clean[2]),
             'master': bool(tier.get('master')), 'loudness_lufs': float(audio_cfg.get('loudness_lufs') or -16),
             'true_peak': TRUE_PEAK_DBTP, 'channels': int(tier.get('channels') or 2),
             'crossfade_ms': int(prepared.get('crossfade_ms') or 0)}
    chunking = {'part_ms': EPISODE_PART_MS,
                'resume_key': spec_hash(prepared) if export else None,
                'parts_to': (parts_to or f'{write_to}/parts') if export else None}
    return render_spec(
        source=str(prepared['source']), media=media, keep=keep, mutes=prepared.get('mutes') or [],
        bleeps=prepared.get('bleeps') or [], outputs=outputs, audio=audio,
        music=music_block(assets, enabled=bool(tier.get('music'))), overlays=logo_overlay(assets),
        cards=cards, concat=concat, subtitles=subtitles, chunking=chunking,
        chapters=prepared.get('chapters') if export else [], chapter_files=bool(export),
        write_to=write_to, report_to=report_to, status_to=status_to,
        cache_key=None if export else (cache_key or preview_cache_key(prepared, tier, rng)),
        report_meta={
            'kind': 'studio', 'mode': mode, 'studio': mode, 'project': prepared.get('project'),
            'episode_id': prepared.get('episode_id'), 'clip_id': prepared.get('clip_id'),
            'title': prepared.get('title'), 'version': version,
            'quality': tier.get('quality') or tier.get('tier'), 'tier': tier.get('tier'),
            'aspect_ratio': aspect, 'extra_aspects': [o['name'] for o in outputs if o.get('transcode_from') == 'episode'],
            'range': [int(rng[0]), int(rng[1])] if rng else None,
            'preview_output_start_ms': offset_ms, 'body_duration_ms': body_ms,
            'output_duration_ms': int(prepared.get('output_duration_ms') or 0),
            'cuts': max(0, len(full_keep) - 1), 'mutes': len(prepared.get('mutes') or []),
            'bleeps': len(prepared.get('bleeps') or []),
            'spec_hash': spec_hash(prepared), 'brand': prepared.get('brand'),
            'source_width': media.get('width'), 'source_height': media.get('height'),
            'expect_video': has_video, 'warnings': list(warnings or prepared.get('warnings') or []),
        },
    )
