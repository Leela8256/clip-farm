"""
Prompt Director request specs — the structured form of a producer's sentence
("three 42-second clips where Sarah explains why the startup failed, remove
fillers, avoid profanity, yellow captions, end on a complete takeaway").

The stock LLM turns the sentence into JSON; this module makes that JSON safe
to act on: every field is coerced to a known value, contradictions become
warnings instead of silent guesses, and the duration window the discovery and
fitting steps enforce is derived in one place. The browser has a TypeScript
twin of this normaliser (lib/director.ts) because it shows the warnings before
a run starts; the nodes re-normalise defensively so a hand-written request
file can never break a pipeline.
"""

from __future__ import annotations
import re
from typing import Any

SPEC_VERSION = 1

DURATION_MODES = ('natural', 'strict', 'maximum')
FILLER_POLICIES = ('smart', 'cut', 'mute', 'keep')
SILENCE_POLICIES = ('tighten', 'keep')
ASPECT_RATIOS = ('9:16', '16:9', '1:1', '4:5')
# Phase 1 renders these; the others are accepted with a warning and fall back to 9:16.
RENDERABLE_ASPECTS = {'9:16': 'vertical', '16:9': 'wide'}
CAPTION_PRESETS = ('classic', 'yellow-bold', 'white-outline', 'minimal', 'off')
EXCLUDABLE_CONTENT = ('profanity', 'sponsor', 'housekeeping', 'names', 'numbers')

DEFAULT_COUNT = 3
MAX_COUNT = 20
DEFAULT_TARGET_S = 45
DEFAULT_MIN_S = 15
DEFAULT_MAX_S = 90
NATURAL_TOLERANCE_S = 3
STRICT_TOLERANCE_S = 1
# Discovery accepts a wider window than the final tolerance: in natural mode the
# score penalty pulls towards the target (a complete thought beats the number),
# in strict/maximum mode the fit step trims pauses, fillers and trailing
# sentences — so a longer proposal can still land on the target, a much
# shorter one cannot.
NATURAL_WINDOW = (0.6, 1.5)
STRICT_WINDOW = (0.85, 1.5)
MAXIMUM_WINDOW = (0.5, 1.3)


def _as_list(value: Any) -> list[str]:
    if value is None or value is False:
        return []
    if isinstance(value, str):
        parts = re.split(r'[;,]\s*|\s+and\s+', value)
        return [p.strip() for p in parts if p and p.strip()]
    if isinstance(value, (list, tuple, set)):
        out = []
        for item in value:
            if isinstance(item, str) and item.strip():
                out.append(item.strip())
            elif isinstance(item, dict):
                name = item.get('name') or item.get('text') or item.get('value')
                if isinstance(name, str) and name.strip():
                    out.append(name.strip())
        return out
    return [str(value).strip()] if str(value).strip() else []


def _as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().lower()
    m = re.search(r'(\d+(?:\.\d+)?)\s*(m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)?\b', text)
    if not m:
        return None
    number = float(m.group(1))
    unit = m.group(2) or ''
    return number * 60 if unit.startswith('m') else number


def _as_int(value: Any, default: int, lo: int, hi: int) -> int:
    number = _as_float(value)
    if number is None:
        return default
    return int(max(lo, min(hi, round(number))))


def _as_bool(value: Any, default: bool | None = None) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in ('1', 'true', 'yes', 'on', 'remove', 'cut'):
        return True
    if text in ('0', 'false', 'no', 'off', 'keep'):
        return False
    return default


def _choice(value: Any, allowed: tuple, default: str, warnings: list[str], label: str, aliases: dict | None = None) -> str:
    if value is None or value == '':
        return default
    text = str(value).strip().lower()
    if aliases and text in aliases:
        text = aliases[text]
    if text in allowed:
        return text
    warnings.append(f"Unknown {label} '{value}' — using '{default}'.")
    return default


def normalize_spec(raw: Any, defaults: dict | None = None) -> dict:
    """
    Coerce the LLM's JSON (or anything a client sent) into the canonical spec.
    Never raises: unusable values become defaults plus a warning.
    """
    defaults = defaults or {}
    data = raw if isinstance(raw, dict) else {}
    warnings: list[str] = [str(w) for w in (data.get('warnings') or []) if str(w).strip()]

    count = _as_int(data.get('count'), int(defaults.get('count', DEFAULT_COUNT)), 1, MAX_COUNT)
    if _as_float(data.get('count')) not in (None, float(count)):
        warnings.append(f'Clip count clamped to {count} (1-{MAX_COUNT}).')

    # duration: accept flat keys or a nested object
    dur = data.get('duration') if isinstance(data.get('duration'), dict) else {}
    target = _as_float(data.get('target_duration_seconds', dur.get('target_seconds', dur.get('target'))))
    min_s = _as_float(data.get('min_duration_seconds', dur.get('min_seconds', dur.get('min'))))
    max_s = _as_float(data.get('max_duration_seconds', dur.get('max_seconds', dur.get('max'))))
    mode_raw = data.get('duration_mode', dur.get('mode'))
    mode = _choice(mode_raw, DURATION_MODES, 'natural', warnings, 'duration mode',
                   {'exact': 'strict', 'exactly': 'strict', 'precise': 'strict', 'max': 'maximum', 'at most': 'maximum',
                    'under': 'maximum', 'up to': 'maximum', 'around': 'natural', 'about': 'natural', 'approx': 'natural',
                    'approximately': 'natural', 'flexible': 'natural'})
    if min_s is not None and max_s is not None and min_s > max_s:
        warnings.append(f'Minimum duration ({min_s:g}s) was above the maximum ({max_s:g}s) — swapped.')
        min_s, max_s = max_s, min_s
    if target is None:
        if min_s is not None and max_s is not None:
            target = (min_s + max_s) / 2
        elif max_s is not None and mode == 'maximum':
            target = max_s
        elif max_s is not None:
            target = max_s * 0.8
        elif min_s is not None:
            target = min_s * 1.3
        else:
            target = float(defaults.get('target_seconds', DEFAULT_TARGET_S))
    if target < 5:
        warnings.append(f'Target duration {target:g}s is too short — using 5s.')
        target = 5.0
    if target > 600:
        warnings.append(f'Target duration {target:g}s is too long for a clip — using 600s.')
        target = 600.0
    if min_s is not None and min_s > target:
        warnings.append(f'Minimum duration ({min_s:g}s) is above the target ({target:g}s) — dropped.')
        min_s = None
    if max_s is not None and max_s < target:
        if mode == 'maximum':
            target = max_s
        else:
            warnings.append(f'Maximum duration ({max_s:g}s) is below the target ({target:g}s) — dropped.')
            max_s = None
    if mode == 'strict' and (min_s is not None or max_s is not None):
        warnings.append('Strict duration ignores min/max bounds — the clip is fitted to the target.')
    if mode == 'maximum' and max_s is None:
        max_s = target

    fillers = _choice(data.get('filler_policy', data.get('fillers')), FILLER_POLICIES, 'smart', warnings, 'filler policy',
                      {'remove': 'smart', 'remove_fillers': 'smart', 'auto': 'smart', 'hard': 'cut', 'hard cut': 'cut',
                       'silence': 'mute', 'leave': 'keep', 'none': 'keep'})
    remove = _as_bool(data.get('remove_fillers'))
    if remove is False:
        fillers = 'keep'
    elif remove is True and fillers == 'keep':
        fillers = 'smart'
    silences = _choice(data.get('silence_policy', data.get('silences', data.get('pauses'))), SILENCE_POLICIES, 'tighten',
                       warnings, 'pause policy', {'remove': 'tighten', 'trim': 'tighten', 'cut': 'tighten', 'leave': 'keep',
                                                  'preserve': 'keep', 'natural': 'keep'})
    if _as_bool(data.get('tighten_pauses')) is False:
        silences = 'keep'

    aspect = _choice(data.get('aspect_ratio', data.get('aspect')), ASPECT_RATIOS, '9:16', warnings, 'aspect ratio',
                     {'vertical': '9:16', 'portrait': '9:16', 'reels': '9:16', 'shorts': '9:16', 'tiktok': '9:16',
                      'horizontal': '16:9', 'landscape': '16:9', 'wide': '16:9', 'youtube': '16:9', 'square': '1:1'})
    if aspect not in RENDERABLE_ASPECTS:
        warnings.append(f'{aspect} exports arrive with Brand Studio (phase 3) — rendering 9:16 for now.')
    caption_raw = data.get('caption_preset', data.get('captions'))
    if isinstance(caption_raw, dict):
        caption_raw = caption_raw.get('preset') or caption_raw.get('style') or ('off' if caption_raw.get('enabled') is False else None)
    if _as_bool(caption_raw) is False:
        caption_raw = 'off'
    elif _as_bool(caption_raw) is True:
        caption_raw = 'classic'
    captions = _choice(caption_raw, CAPTION_PRESETS, 'classic', warnings, 'caption preset',
                       {'yellow': 'yellow-bold', 'bold yellow': 'yellow-bold', 'yellow bold': 'yellow-bold', 'white': 'white-outline',
                        'outline': 'white-outline', 'default': 'classic', 'none': 'off', 'no captions': 'off', 'plain': 'minimal'})

    exclude_content = []
    for item in _as_list(data.get('exclude_content', data.get('exclude'))):
        key = item.lower().replace(' ', '_')
        if key in ('swearing', 'cursing', 'curse_words', 'swear_words', 'explicit', 'bad_language'):
            key = 'profanity'
        if key in ('ads', 'ad_reads', 'sponsors', 'sponsor_reads', 'advertising'):
            key = 'sponsor'
        if key in ('intro', 'outro', 'greetings', 'banter'):
            key = 'housekeeping'
        if key in EXCLUDABLE_CONTENT:
            if key not in exclude_content:
                exclude_content.append(key)
        else:
            warnings.append(f"Can't filter content of type '{item}' — treating it as an excluded subject.")
            data.setdefault('_extra_exclude_subjects', []).append(item)

    speakers = _as_list(data.get('speakers', data.get('speaker')))
    subjects = _as_list(data.get('subjects', data.get('subject', data.get('topic', data.get('topics')))))
    exclude_subjects = _as_list(data.get('exclude_subjects')) + list(data.get('_extra_exclude_subjects') or [])
    if speakers:
        warnings.append('Speaker constraints are matched from what is said (names, first person) until speaker '
                        'tracking arrives in phase 2 — check the compliance flag.')

    platform = str(data.get('platform') or '').strip() or None
    tone = str(data.get('tone') or '').strip() or None
    hook = str(data.get('hook', data.get('hook_style')) or '').strip() or None
    ending = str(data.get('ending', data.get('ending_requirement')) or '').strip() or None

    return {
        'spec_version': SPEC_VERSION,
        'count': count,
        'duration': {
            'target_seconds': round(target, 1),
            'min_seconds': round(min_s, 1) if min_s is not None else None,
            'max_seconds': round(max_s, 1) if max_s is not None else None,
            'mode': mode,
        },
        'speakers': speakers,
        'subjects': subjects,
        'exclude_subjects': exclude_subjects,
        'exclude_content': exclude_content,
        'tone': tone,
        'hook': hook,
        'ending': ending,
        'filler_policy': fillers,
        'silence_policy': silences,
        'caption_preset': captions,
        'aspect_ratio': aspect,
        'platform': platform,
        'warnings': warnings,
    }


def duration_window(spec: dict, defaults: dict | None = None) -> dict:
    """
    The millisecond window the discovery step accepts and the tolerance the fit
    step must land in, per duration mode:
      natural  aim for the target, ±NATURAL_TOLERANCE, keep complete thoughts;
      strict   ±STRICT_TOLERANCE after pause/filler edits (fit trims/pads);
      maximum  never longer than the target.
    """
    defaults = defaults or {}
    dur = spec.get('duration') or {}
    mode = dur.get('mode') if dur.get('mode') in DURATION_MODES else 'natural'
    target = float(dur.get('target_seconds') or defaults.get('target_seconds', DEFAULT_TARGET_S))
    min_s = dur.get('min_seconds')
    max_s = dur.get('max_seconds')
    floor = float(defaults.get('min_seconds', DEFAULT_MIN_S))
    if mode == 'natural':
        tolerance = NATURAL_TOLERANCE_S
        lo = float(min_s) if min_s is not None else max(floor, target * NATURAL_WINDOW[0])
        hi = float(max_s) if max_s is not None else target * NATURAL_WINDOW[1]
    elif mode == 'strict':
        tolerance = STRICT_TOLERANCE_S
        lo = max(floor, target * STRICT_WINDOW[0])
        hi = target * STRICT_WINDOW[1]
    else:  # maximum — the fit step trims longer proposals back under the target
        tolerance = 0
        lo = float(min_s) if min_s is not None else max(floor, target * MAXIMUM_WINDOW[0])
        hi = target * MAXIMUM_WINDOW[1]
    lo = max(3.0, min(lo, target))
    hi = max(hi, target)
    return {
        'mode': mode,
        'target_ms': int(round(target * 1000)),
        'min_ms': int(round(lo * 1000)),
        'max_ms': int(round(hi * 1000)),
        'tolerance_ms': int(tolerance * 1000),
    }


def describe_spec(spec: dict) -> str:
    """One readable line for logs, status events and the request card."""
    dur = spec.get('duration') or {}
    parts = [f"{spec.get('count', DEFAULT_COUNT)} clip(s)", f"{dur.get('target_seconds', DEFAULT_TARGET_S):g}s {dur.get('mode', 'natural')}"]
    if spec.get('speakers'):
        parts.append('speaker ' + ', '.join(spec['speakers']))
    if spec.get('subjects'):
        parts.append('about ' + '; '.join(spec['subjects']))
    if spec.get('exclude_content'):
        parts.append('no ' + ', '.join(spec['exclude_content']))
    if spec.get('hook'):
        parts.append(f"hook: {spec['hook']}")
    if spec.get('ending'):
        parts.append(f"ending: {spec['ending']}")
    return ' · '.join(parts)
