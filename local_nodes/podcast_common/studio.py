"""
Full-episode ("studio") editing logic: the pure half of podcast_prepare_clip's
`studio:` branch.

Two jobs live here.

`studio: init` builders — the episode's word timeline (aligned in pieces by the
node, stitched to absolute source milliseconds), a coarse waveform for the
timeline bar, and the deterministic cleanup suggestions (fillers, pauses,
false starts, repeats, dead air, profanity, quiet passages, low-confidence
speech). Every suggestion carries the LEAST aggressive cleanup mode that
includes it, so `natural` ⊆ `balanced` ⊆ `tight` by construction.

`studio: preview|export` builders — the browser's `edits/episode-edits.json`
(which this code only ever reads) is validated into three source-timeline range
lists (cuts, mutes, bleeps), the keep segments and the source↔output map are
derived from them, and captions / chapters are carried onto the output timeline
through the same `TimelineMap` the clip flow uses.

All times are integer milliseconds on the SOURCE timeline unless a name says
`out_`. Nothing in this module touches the store, ffmpeg or the engine except
`analysis_wav` / `peaks_from_wav`, which shell out through `media.run_ffmpeg`.
"""

from __future__ import annotations

import array
import difflib
import math
import re
import time
import wave
from pathlib import Path

from .captions import group_words
from .clips import FILLERS, TimelineMap, map_words_to_output
from .constraints import PROFANITY
from .editing import filler_cut_safety
from .media import keep_segments, run_ffmpeg

SCHEMA_VERSION = 1
EDITS_SCHEMA = 1

PIECE_SECONDS = 60             # alignment window over the episode
WAVE_MS = 100                  # one waveform peak per 100 ms
ANALYSIS_RATE = 16000          # mono analysis wav (what the aligner wants anyway)

SILENCE_MIN_MS = 700           # a "silence" worth showing the user
KEEP_PAUSE_MS = 350            # breath left in place when a pause is tightened
SNAP_MS = 120                  # cut boundaries snap outward to a word gap within this
MIN_PIECE_MS = 200             # keep segments shorter than this are dropped
MIN_SILENCE_SIDE_MS = 150      # shorten_silence leaves at least this much on each side
CROSSFADE_MS = 40              # declick crossfade at every join (same as the clip flow)
LOW_CONFIDENCE = 0.5
QUIET_CEILING = 0.12           # normalised peak below this (but above the floor) is "quiet"
QUIET_FLOOR = 0.015
QUIET_MIN_MS = 1000
DEAD_AIR_MS = 1500

LEVELS = ('natural', 'balanced', 'tight')
CUT_KINDS = ('dead_air_start', 'dead_air_end', 'false_start', 'repeat', 'filler', 'pause', 'quiet')
KIND_PRIORITY = ('dead_air_start', 'dead_air_end', 'false_start', 'repeat', 'filler', 'pause', 'quiet',
                 'profanity', 'low_confidence')
# id prefix + digit width per kind (f001 … fs01 … lc01)
ID_FORMAT = {'filler': ('f', 3), 'pause': ('p', 3), 'false_start': ('fs', 2), 'repeat': ('r', 3),
             'dead_air_start': ('d', 2), 'dead_air_end': ('d', 2), 'profanity': ('pr', 2),
             'quiet': ('q', 2), 'low_confidence': ('lc', 2)}

OPERATION_TYPES = ('cut', 'mute', 'bleep', 'shorten_silence')

DEFAULT_AUDIO = {'noise_reduction': True, 'high_pass': True, 'compression': True, 'master': True,
                 'loudness_lufs': -16}
DEFAULT_CAPTION_STYLE = {'preset': 'clean', 'font': None, 'size': None, 'position': 'bottom', 'color': None,
                         'karaoke': False, 'per_speaker_colors': False}
DEFAULT_VISUAL = {'aspect_ratio': '16:9', 'fit': 'fit', 'background': 'blur', 'captions': True}

_TOKEN_RE = re.compile(r"[a-z0-9']+")


# --------------------------------------------------------------------- words


def compact_words(words: list[dict]) -> list[dict]:
    """`{'word','start_ms','end_ms','probability'}` → the on-disk `{w,s,e,c}` rows."""
    rows = []
    for w in words:
        rows.append({'w': w.get('word', ''), 's': int(w['start_ms']), 'e': int(w['end_ms']),
                     'c': round(float(w.get('probability', w.get('c', 1.0)) or 0.0), 3)})
    return rows


def expand_words(rows: list[dict]) -> list[dict]:
    """The on-disk rows back into the shape the rest of the codebase uses."""
    words = []
    for r in rows or []:
        if 'w' in r:
            words.append({'word': r.get('w', ''), 'start_ms': int(r.get('s', 0)), 'end_ms': int(r.get('e', 0)),
                          'probability': float(r.get('c', 1.0))})
        else:  # already expanded
            words.append({'word': r.get('word', ''), 'start_ms': int(r.get('start_ms', 0)),
                          'end_ms': int(r.get('end_ms', 0)), 'probability': float(r.get('probability', 1.0))})
    return sorted(words, key=lambda w: w['start_ms'])


def correction_index(word_id) -> int | None:
    """`'w42'` → 42 (the word's position in the episode timeline); anything else → None."""
    text = str(word_id or '').strip().lower()
    if not text.startswith('w'):
        return None
    try:
        index = int(text[1:])
    except (TypeError, ValueError):
        return None
    return index if index >= 0 else None


def apply_corrections(words: list[dict], corrections) -> tuple[list[dict], int]:
    """
    The producer's transcript fixes applied to a COPY of the word list.

    A correction row is `{'word_id': 'w<index>', 'text': 'Kubernetes',
    'original': 'cabinets'}` — the index is the word's position in
    `analysis/studio/timeline.json` (immutable after init). Only the DISPLAYED
    text changes: start/end milliseconds, order and count are untouched, so
    captions, cuts and audio all stay exactly where they were. Anything
    unreadable (missing id, wrong shape, out of range, empty text) is ignored.
    """
    out = [dict(w) for w in (words or [])]
    applied = 0
    for row in corrections if isinstance(corrections, list) else []:
        if not isinstance(row, dict):
            continue
        index = correction_index(row.get('word_id'))
        if index is None or index >= len(out):
            continue
        text = str(row.get('text') or '').strip()
        if not text or text == out[index].get('word'):
            continue
        out[index] = {**out[index], 'word': text, 'corrected': True, 'original': out[index].get('word')}
        applied += 1
    return out, applied


def token(word: str) -> str:
    m = _TOKEN_RE.findall((word or '').lower())
    return m[0] if m else ''


def normalize_text(text: str) -> str:
    return ' '.join(_TOKEN_RE.findall((text or '').lower()))


# -------------------------------------------------------------------- ranges


def merge_ranges(ranges, gap_ms: int = 0) -> list[tuple[int, int]]:
    """Sorted, non-overlapping ranges; ranges closer than `gap_ms` are joined."""
    ordered = sorted((int(s), int(e)) for s, e in ranges if int(e) > int(s))
    merged: list[list[int]] = []
    for start, end in ordered:
        if merged and start - merged[-1][1] <= gap_ms:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(s, e) for s, e in merged]


def clamp_range(start, end, duration_ms: int) -> tuple[int, int] | None:
    try:
        s, e = int(round(float(start))), int(round(float(end)))
    except (TypeError, ValueError):
        return None
    s = max(0, s)
    if duration_ms:
        e = min(int(duration_ms), e)
    if e <= s:
        return None
    return s, e


def overlaps(a: tuple[int, int], ranges) -> bool:
    return any(a[0] < e and a[1] > s for s, e in ranges)


def words_between(words: list[dict], start: int, end: int) -> list[dict]:
    return [w for w in words if w['start_ms'] < end and w['end_ms'] > start]


def silences_from_words(words: list[dict], duration_ms: int, min_ms: int = SILENCE_MIN_MS) -> list[tuple[int, int]]:
    """Gaps between spoken words — the fallback when no audio scan is available."""
    ordered = sorted(words, key=lambda w: w['start_ms'])
    out: list[tuple[int, int]] = []
    cursor = 0
    for w in ordered:
        if w['start_ms'] - cursor >= min_ms:
            out.append((cursor, w['start_ms']))
        cursor = max(cursor, w['end_ms'])
    if duration_ms and duration_ms - cursor >= min_ms:
        out.append((cursor, int(duration_ms)))
    return out


def subtract_ranges(ranges, blockers) -> list[tuple[int, int]]:
    """What is left of `ranges` once every `blockers` range is taken out of them."""
    blocked = merge_ranges(blockers)
    out: list[tuple[int, int]] = []
    for start, end in merge_ranges(ranges):
        cursor = start
        for b_start, b_end in blocked:
            if b_end <= cursor or b_start >= end:
                continue
            if b_start > cursor:
                out.append((cursor, min(b_start, end)))
            cursor = max(cursor, b_end)
            if cursor >= end:
                break
        if cursor < end:
            out.append((cursor, end))
    return [r for r in out if r[1] > r[0]]


def speech_free_silences(candidates, words: list[dict], min_ms: int = SILENCE_MIN_MS) -> list[tuple[int, int]]:
    """
    Silences that certainly hold no speech: the detected quiet ranges and the
    gaps between words, with every spoken word carved back out of them (the
    level scan and the aligner disagree at the edges) and the short ones gone.
    """
    spoken = [(w['start_ms'], w['end_ms']) for w in words or []]
    return [r for r in subtract_ranges(candidates, spoken) if r[1] - r[0] >= min_ms]


def cuttable_pause(start: int, end: int, keep_pause_ms: int = KEEP_PAUSE_MS) -> tuple[int, int] | None:
    """The removable middle of a silence — a natural breath is always left in place."""
    pad = keep_pause_ms // 2
    s, e = int(start) + pad, int(end) - pad
    return (s, e) if e - s > 100 else None


def shorten_silence_cut(start: int, end: int, target_ms: int,
                        min_side_ms: int = MIN_SILENCE_SIDE_MS) -> tuple[int, int] | None:
    """
    `shorten_silence` as a plain cut: remove the middle of the silence so that
    `target_ms` of it survives, never leaving less than `min_side_ms` per side.
    """
    start, end = int(start), int(end)
    target = max(0, int(target_ms))
    head = max(min_side_ms, target // 2)
    tail = max(min_side_ms, target - target // 2)
    if end - start <= head + tail:
        return None
    return start + head, end - tail


def snap_range(start: int, end: int, words: list[dict], tolerance_ms: int = SNAP_MS) -> tuple[int, int]:
    """
    Move a cut's edges outward onto the surrounding word gap when they are
    within `tolerance_ms`, so a cut never clips the head or tail of a word.
    """
    start, end = int(start), int(end)
    if not words:
        return start, end
    ordered = sorted(words, key=lambda w: w['start_ms'])
    before = [w['end_ms'] for w in ordered if w['end_ms'] <= start]
    if before and 0 <= start - before[-1] <= tolerance_ms:
        start = before[-1]
    after = [w['start_ms'] for w in ordered if w['start_ms'] >= end]
    if after and 0 <= after[0] - end <= tolerance_ms:
        end = after[0]
    return start, end


# ------------------------------------------------------------------ waveform


def analysis_wav(src: str | Path, out_path: str | Path, sample_rate: int = ANALYSIS_RATE) -> Path:
    """One mono decode of the recording — reused for alignment, silences and the waveform."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(['-y', '-i', str(src), '-vn', '-ac', '1', '-ar', str(sample_rate), '-c:a', 'pcm_s16le', str(out_path)])
    return out_path


def _rms(samples) -> float:
    if not len(samples):
        return 0.0
    try:
        import numpy as np

        block = np.frombuffer(samples, dtype='<i2').astype('float32') if isinstance(samples, (bytes, bytearray)) \
            else np.asarray(samples, dtype='float32')
        return float(math.sqrt(float((block * block).mean()))) / 32768.0
    except Exception:  # noqa: BLE001 - numpy is optional, the pure path is fine
        total = 0
        for s in samples:
            total += s * s
        return math.sqrt(total / len(samples)) / 32768.0


def peaks_from_wav(path: str | Path, bucket_ms: int = WAVE_MS) -> list[float]:
    """One RMS value per `bucket_ms`, normalised to the loudest bucket (0..1)."""
    with wave.open(str(path), 'rb') as wf:
        if wf.getsampwidth() != 2:
            return []
        rate, channels = wf.getframerate(), wf.getnchannels()
        per_bucket = max(1, rate * bucket_ms // 1000)
        raw: list[float] = []
        while True:
            frames = wf.readframes(per_bucket)
            if not frames:
                break
            block = array.array('h')
            block.frombytes(frames[: (len(frames) // 2) * 2])
            if channels > 1:
                block = array.array('h', block[::channels])
            raw.append(_rms(block))
    top = max(raw) if raw else 0.0
    if top <= 0:
        return [0.0 for _ in raw]
    return [round(min(1.0, v / top), 4) for v in raw]


def waveform_doc(peaks: list[float], duration_ms: int, bucket_ms: int = WAVE_MS) -> dict:
    return {'schema_version': SCHEMA_VERSION, 'per_second': max(1, 1000 // bucket_ms),
            'duration_ms': int(duration_ms), 'peaks': list(peaks)}


def quiet_ranges(peaks: list[float], bucket_ms: int = WAVE_MS, silences=None,
                 ceiling: float = QUIET_CEILING, floor: float = QUIET_FLOOR,
                 min_ms: int = QUIET_MIN_MS) -> list[tuple[int, int]]:
    """Passages the microphone barely picked up — quiet but not silent."""
    silences = list(silences or [])
    found: list[tuple[int, int]] = []
    run_start = None
    for i, peak in enumerate(peaks):
        low = floor < peak < ceiling
        if low and run_start is None:
            run_start = i
        elif not low and run_start is not None:
            found.append((run_start * bucket_ms, i * bucket_ms))
            run_start = None
    if run_start is not None:
        found.append((run_start * bucket_ms, len(peaks) * bucket_ms))
    return [r for r in found if r[1] - r[0] >= min_ms and not overlaps(r, silences)]


def low_confidence_ranges(words: list[dict], threshold: float = LOW_CONFIDENCE,
                          min_ms: int = 400) -> list[tuple[int, int]]:
    """Runs of words the transcriber was unsure about (a "hard to hear" flag)."""
    found: list[tuple[int, int]] = []
    run: list[dict] = []
    for w in sorted(words, key=lambda x: x['start_ms']):
        if float(w.get('probability', 1.0)) < threshold:
            run.append(w)
            continue
        if run and run[-1]['end_ms'] - run[0]['start_ms'] >= min_ms:
            found.append((run[0]['start_ms'], run[-1]['end_ms']))
        run = []
    if run and run[-1]['end_ms'] - run[0]['start_ms'] >= min_ms:
        found.append((run[0]['start_ms'], run[-1]['end_ms']))
    return found


# --------------------------------------------------------------- suggestions


def _sug(kind: str, n: int, start: int, end: int, action: str, level: str, text: str = '',
         confidence: float = 0.8, **extra) -> dict:
    prefix, width = ID_FORMAT[kind]
    return {'id': f'{prefix}{n:0{width}d}', 'kind': kind, 'start_ms': int(start), 'end_ms': int(end),
            'text': text, 'action': action, 'confidence': round(float(confidence), 2), 'level': level, **extra}


def filler_suggestions(words: list[dict]) -> list[dict]:
    ordered = sorted(words, key=lambda w: w['start_ms'])
    out, n = [], 0
    for i, w in enumerate(ordered):
        if token(w['word']) not in FILLERS:
            continue
        n += 1
        prev_word = ordered[i - 1] if i else None
        next_word = ordered[i + 1] if i + 1 < len(ordered) else None
        safe, reason = filler_cut_safety(w, prev_word, next_word)
        if safe:
            level, action = 'natural', 'cut'
        elif reason == 'probably not a filler':
            level, action = 'tight', 'cut'
        else:
            level, action = 'balanced', 'mute'
        out.append(_sug('filler', n, max(0, w['start_ms'] - 10), w['end_ms'] + 10, action, level,
                        text=w['word'], confidence=float(w.get('probability', 0.8)), reason=reason))
    return out


def pause_suggestions(silences, keep_pause_ms: int = KEEP_PAUSE_MS) -> list[dict]:
    out, n = [], 0
    for start, end in merge_ranges(silences):
        span = end - start
        if span < SILENCE_MIN_MS:
            continue
        n += 1
        level = 'natural' if span >= 2000 else ('balanced' if span >= 1200 else 'tight')
        out.append(_sug('pause', n, start, end, 'shorten_silence', level,
                        text=f'{span / 1000:.1f}s pause', confidence=0.9, target_ms=keep_pause_ms))
    return out


def false_start_suggestions(words: list[dict], max_phrase: int = 4, gap_ms: int = 1500) -> list[dict]:
    """A phrase said, abandoned and immediately restarted — the first try goes."""
    ordered = sorted(words, key=lambda w: w['start_ms'])
    tokens = [token(w['word']) for w in ordered]
    out, n, i = [], 0, 0
    while i < len(ordered):
        hit = 0
        for k in range(max_phrase, 0, -1):
            if i + 2 * k > len(ordered):
                continue
            first, second = tokens[i:i + k], tokens[i + k:i + 2 * k]
            if not all(first) or first != second:
                continue
            if ordered[i + k]['start_ms'] - ordered[i + k - 1]['end_ms'] > gap_ms:
                continue
            hit = k
            break
        if not hit:
            i += 1
            continue
        n += 1
        start = ordered[i]['start_ms']
        end = ordered[i + hit]['start_ms']
        level = 'natural' if hit >= 2 else 'balanced'
        out.append(_sug('false_start', n, start, end, 'cut', level,
                        text=' '.join(w['word'] for w in ordered[i:i + hit]), confidence=0.85))
        i += 2 * hit
    return out


def repeat_suggestions(sentences: list[dict], window_ms: int = 60_000, ratio: float = 0.9,
                       min_words: int = 5) -> list[dict]:
    """A sentence said twice inside a minute — the earlier take is the one to drop."""
    ordered = [s for s in sorted(sentences or [], key=lambda s: s.get('start_ms', 0))
               if len(normalize_text(s.get('text')).split()) >= min_words]
    out, n, taken = [], 0, []
    for i, first in enumerate(ordered):
        a = normalize_text(first.get('text'))
        for second in ordered[i + 1:]:
            if second['start_ms'] - first['start_ms'] > window_ms:
                break
            score = difflib.SequenceMatcher(None, a, normalize_text(second.get('text'))).ratio()
            if score < ratio:
                continue
            span = (int(first['start_ms']), int(first.get('end_ms') or second['start_ms']))
            if span[1] <= span[0] or overlaps(span, taken):
                break
            n += 1
            taken.append(span)
            out.append(_sug('repeat', n, span[0], span[1], 'cut', 'balanced' if score >= 0.97 else 'tight',
                            text=(first.get('text') or '')[:120], confidence=round(score, 2)))
            break
    return out


def dead_air_suggestions(words: list[dict], duration_ms: int, min_ms: int = DEAD_AIR_MS) -> list[dict]:
    out = []
    ordered = sorted(words, key=lambda w: w['start_ms'])
    if not ordered or not duration_ms:
        return out
    head = ordered[0]['start_ms']
    if head >= min_ms:
        out.append(_sug('dead_air_start', 1, 0, max(0, head - 250), 'cut', 'natural',
                        text='Silence before the first word', confidence=0.95))
    tail = ordered[-1]['end_ms']
    if duration_ms - tail >= min_ms:
        out.append(_sug('dead_air_end', 2, min(int(duration_ms), tail + 250), int(duration_ms), 'cut', 'natural',
                        text='Silence after the last word', confidence=0.95))
    return out


def profanity_suggestions(words: list[dict]) -> list[dict]:
    out, n = [], 0
    for w in sorted(words, key=lambda x: x['start_ms']):
        if token(w['word']) not in PROFANITY:
            continue
        n += 1
        out.append(_sug('profanity', n, w['start_ms'], w['end_ms'], 'bleep', 'tight', text=w['word'],
                        confidence=float(w.get('probability', 0.8))))
    return out


def quiet_suggestions(ranges, words: list[dict]) -> list[dict]:
    out, n = [], 0
    for start, end in ranges:
        if words_between(words, start, end):
            continue
        n += 1
        out.append(_sug('quiet', n, start, end, 'cut', 'tight',
                        text=f'{(end - start) / 1000:.1f}s of near-silence', confidence=0.6))
    return out


def low_confidence_suggestions(ranges, words: list[dict]) -> list[dict]:
    """
    "Hard to hear" flags. These are NEVER an edit: the transcriber being unsure
    does not mean the speech is wrong, and muting it would delete real content.
    They are offered for review only.
    """
    out, n = [], 0
    for start, end in ranges:
        n += 1
        said = ' '.join(w['word'] for w in words_between(words, start, end))[:120]
        out.append(_sug('low_confidence', n, start, end, 'review', 'tight', text=said, confidence=0.4,
                        review_only=True))
    return out


def _dedupe(suggestions: list[dict]) -> list[dict]:
    """One suggestion per stretch of audio: kind priority wins, ties by start."""
    order = {kind: i for i, kind in enumerate(KIND_PRIORITY)}
    kept: list[dict] = []
    taken: list[tuple[int, int]] = []
    for s in sorted(suggestions, key=lambda s: (order.get(s['kind'], 99), s['start_ms'])):
        span = (s['start_ms'], s['end_ms'])
        if span[1] <= span[0] or overlaps(span, taken):
            continue
        taken.append(span)
        kept.append(s)
    return sorted(kept, key=lambda s: (s['start_ms'], s['id']))


def language_supported(language) -> bool:
    """Filler and profanity word lists are English-only; an unknown language is assumed English."""
    text = str(language or '').strip().lower()
    return not text or text.startswith('en')


def build_suggestions(words: list[dict], *, silences=None, quiet=None, low_confidence=None,
                      sentences=None, duration_ms: int = 0, language: str | None = None) -> dict:
    """
    Every deterministic cleanup the studio can offer, with its cleanup level.

    Filler and profanity detection reads English word lists, so on a recording
    the transcriber reported in another language those two kinds are not
    generated at all and are named in `unsupported` instead — an English filler
    list would otherwise cut real words out of the wrong language.
    """
    words = sorted(words or [], key=lambda w: w['start_ms'])
    silences = list(silences or [])
    english = language_supported(language)
    unsupported = [] if english else ['filler', 'profanity']
    found = (dead_air_suggestions(words, duration_ms)
             + false_start_suggestions(words)
             + repeat_suggestions(sentences or [])
             + (filler_suggestions(words) if english else [])
             + pause_suggestions(silences)
             + quiet_suggestions(quiet or [], words)
             + (profanity_suggestions(words) if english else [])
             + low_confidence_suggestions(low_confidence or [], words))
    kept = _dedupe(found)
    modes = {level: [s['id'] for s in kept if LEVELS.index(s['level']) <= i] for i, level in enumerate(LEVELS)}
    return {'schema_version': SCHEMA_VERSION, 'generated_at': time.time(), 'language': language,
            'unsupported': unsupported, 'modes': modes, 'suggestions': kept}


def suggestions_for_level(doc: dict, level: str) -> list[dict]:
    wanted = LEVELS.index(level if level in LEVELS else 'balanced')
    return [s for s in doc.get('suggestions') or [] if LEVELS.index(s.get('level', 'tight')) <= wanted]


# ------------------------------------------------------------------ timeline


def timeline_doc(*, episode_id: str, duration_ms: int, model: str, words: list[dict], silences,
                 quiet=None, low_confidence=None, sentence_count: int = 0, language: str | None = None) -> dict:
    from local_nodes.podcast_common.align import ALIGN_VERSION
    return {
        'schema_version': SCHEMA_VERSION,
        'align_version': ALIGN_VERSION,
        'episode_id': episode_id,
        'duration_ms': int(duration_ms),
        'model': model,
        'language': language,
        'prepared_at': time.time(),
        'words': compact_words(words),
        'silences': [list(r) for r in merge_ranges(silences)],
        'quiet': [list(r) for r in merge_ranges(quiet or [])],
        'low_confidence': [list(r) for r in merge_ranges(low_confidence or [])],
        'sentence_count': int(sentence_count),
    }


# --------------------------------------------------------------------- edits


def normalize_operations(edits: dict, duration_ms: int, words: list[dict] | None = None) -> dict:
    """
    The browser's edit list turned into three merged, source-timeline range
    lists. Disabled operations are kept in the file but never applied; ranges
    are clamped to the recording; `shorten_silence` becomes a cut of the middle
    of the silence; cut edges snap outward onto a word gap within 120 ms.
    """
    warnings: list[str] = []
    edits = edits if isinstance(edits, dict) else {}
    schema = edits.get('schema_version', EDITS_SCHEMA)
    operations = edits.get('operations') or []
    if schema != EDITS_SCHEMA:
        warnings.append(f'Unsupported edit list (version {schema}) — the recording was prepared without edits.')
        operations = []
    words = sorted(words or [], key=lambda w: w['start_ms'])

    cuts: list[tuple[int, int]] = []
    mutes: list[tuple[int, int]] = []
    bleeps: list[tuple[int, int]] = []
    applied = 0
    for op in operations:
        if not isinstance(op, dict):
            continue
        kind = str(op.get('type') or '').strip().lower()
        if kind not in OPERATION_TYPES:
            warnings.append(f"Skipped an edit of an unknown kind ({op.get('type')!r}).")
            continue
        if op.get('enabled') is False:
            continue
        span = clamp_range(op.get('start_ms'), op.get('end_ms'), duration_ms)
        if span is None:
            warnings.append(f"Skipped {op.get('id') or kind} — it falls outside the recording.")
            continue
        if kind == 'shorten_silence':
            target = op.get('target_ms')
            middle = shorten_silence_cut(span[0], span[1], int(target) if target is not None else KEEP_PAUSE_MS)
            if middle is None:
                continue
            span = middle
            kind = 'cut'
        applied += 1
        if kind == 'cut':
            cuts.append(snap_range(span[0], span[1], words))
        elif kind == 'mute':
            mutes.append(span)
        else:
            bleeps.append(span)

    try:
        version = int(edits.get('version') or 1)
    except (TypeError, ValueError):
        version = 1
    return {'cuts': merge_ranges(cuts), 'mutes': merge_ranges(mutes), 'bleeps': merge_ranges(bleeps),
            'applied': applied, 'warnings': warnings, 'version': version}


# ------------------------------------------------------- output-timeline maps


def timeline_map(keep: list[tuple[int, int]]) -> TimelineMap:
    return TimelineMap([(int(s), int(e)) for s, e in keep])


def map_segments(timeline: TimelineMap) -> list[list[int]]:
    """`[[source_start, source_end, output_start], …]` — the whole source↔output map."""
    return [[int(s), int(e), int(off)] for (s, e), off in zip(timeline.segments, timeline.offsets)]


def speaker_at(speaker_map, t_ms: int) -> str | None:
    for entry in speaker_map or []:
        try:
            start, end, who = entry[0], entry[1], entry[2]
        except (TypeError, IndexError, KeyError):
            continue
        if int(start) <= t_ms < int(end):
            return str(who)
    return None


def caption_groups(words: list[dict], timeline: TimelineMap, speaker_map=None) -> list[dict]:
    """Caption lines on the OUTPUT timeline, built through the keep-segment map."""
    tagged = [{**w, 'source_ms': int(w['start_ms'])} for w in sorted(words or [], key=lambda w: w['start_ms'])]
    out_words = map_words_to_output(tagged, timeline)
    groups = []
    for group in group_words(out_words):
        groups.append({
            'start_ms': int(group[0]['start_ms']),
            'end_ms': int(group[-1]['end_ms']),
            'text': ' '.join(w['word'] for w in group),
            'speaker': speaker_at(speaker_map, group[0].get('source_ms', 0)),
            'source_ms': int(group[0].get('source_ms', 0)),
            'words': [{'w': w['word'], 's': int(w['start_ms']), 'e': int(w['end_ms'])} for w in group],
        })
    return groups


def map_chapters(sections, timeline: TimelineMap, duration_ms: int) -> tuple[list[dict], list[str]]:
    """
    Chapter markers moved onto the output timeline. A chapter whose source
    range was cut away entirely disappears; one whose start was cut moves to
    the first surviving moment inside it.
    """
    warnings: list[str] = []
    ordered = sorted([s for s in (sections or []) if isinstance(s, dict)], key=lambda s: int(s.get('start_ms') or 0))
    chapters: list[dict] = []
    for i, section in enumerate(ordered):
        start = max(0, int(section.get('start_ms') or 0))
        end = int(ordered[i + 1].get('start_ms') or duration_ms) if i + 1 < len(ordered) else int(duration_ms)
        out_ms = timeline.to_output(start)
        if out_ms is None:
            survivor = next((seg for seg in timeline.segments if seg[0] < end and seg[1] > start), None)
            if survivor is None:
                warnings.append(f"Chapter “{section.get('title') or 'Untitled'}” was removed with its section.")
                continue
            out_ms = timeline.to_output(max(start, survivor[0]))
        if out_ms is None:
            continue
        chapters.append({'id': section.get('id'), 'title': str(section.get('title') or 'Chapter'),
                         'out_ms': int(out_ms), 'source_ms': start})
    chapters.sort(key=lambda c: c['out_ms'])
    return chapters, warnings


# ------------------------------------------------------------- prepared spec


def resolve_assets(assets, asset_exists=None) -> tuple[dict, list[str]]:
    """Assets with their files confirmed present; anything missing is skipped with a warning."""
    warnings: list[str] = []
    resolved: dict = {}
    for key, value in (assets or {}).items():
        if not isinstance(value, dict):
            continue
        path = value.get('path')
        if path:
            if asset_exists is not None and not asset_exists(str(path)):
                warnings.append(f'The {key} file is no longer in your library — it was left out.')
                continue
            resolved[key] = dict(value)
        elif value.get('text') or key in ('title_card', 'end_card'):
            if not str(value.get('text') or '').strip():
                continue
            resolved[key] = dict(value)
    return resolved, warnings


def parse_range(text, output_duration_ms: int) -> tuple[list[int] | None, list[str]]:
    """`range: <a>-<b>` from the question — output-timeline milliseconds."""
    if text in (None, ''):
        return None, []
    parts = str(text).replace('..', '-').split('-')
    try:
        a, b = int(float(parts[0])), int(float(parts[1]))
    except (ValueError, IndexError):
        return None, ['That preview range could not be read — the whole recording was prepared instead.']
    a = max(0, min(a, output_duration_ms))
    b = max(0, min(b, output_duration_ms))
    if b - a < 500:
        return None, ['That preview range is too short — the whole recording was prepared instead.']
    return [a, b], []


def build_prepared(*, project: str, episode_id: str, source: str, media: dict, edits: dict,
                   words: list[dict], version: int | None = None, range_text=None, quality: str = 'rough',
                   asset_exists=None, mode: str = 'preview') -> dict:
    """
    The complete episode render spec: what survives, what is silenced, where
    everything lands on the finished timeline, and the finishing settings.
    """
    edits = edits if isinstance(edits, dict) else {}
    media = media or {}
    duration_ms = int(media.get('duration_ms') or edits.get('source_duration_ms') or 0)
    if not duration_ms and words:
        duration_ms = max(w['end_ms'] for w in words)
    ops = normalize_operations(edits, duration_ms, words)
    warnings = list(ops['warnings'])

    keep = keep_segments(ops['cuts'], duration_ms, min_keep_ms=MIN_PIECE_MS) if duration_ms else [(0, 0)]
    timeline = timeline_map(keep)
    # transcript fixes are text-only: the captions (burned in and the SRT/VTT
    # built from these groups) read the corrected words, the timeline does not
    caption_words, corrected = apply_corrections(words, edits.get('corrections'))
    groups = caption_groups(caption_words, timeline, edits.get('speaker_map'))
    chapters, chapter_warnings = map_chapters(edits.get('sections'), timeline, duration_ms)
    warnings += chapter_warnings
    assets, asset_warnings = resolve_assets(edits.get('assets'), asset_exists)
    warnings += asset_warnings

    visual = {**DEFAULT_VISUAL, **{k: v for k, v in (edits.get('visual') or {}).items() if k != 'caption_style'}}
    style = {**DEFAULT_CAPTION_STYLE, **((edits.get('visual') or {}).get('caption_style') or {})}
    visual['caption_style'] = style
    audio = {**DEFAULT_AUDIO, **(edits.get('audio') or {})}
    speakers = edits.get('speakers') if isinstance(edits.get('speakers'), dict) else {}
    try:
        version = int(version) if str(version or '').strip() else int(ops['version'])
    except (TypeError, ValueError):
        version = int(ops['version'])
    out_range, range_warnings = parse_range(range_text, timeline.total_ms)
    warnings += range_warnings
    if not keep or timeline.total_ms <= 0:
        warnings.append('Every part of the recording is cut — nothing would be left to play.')

    return {
        'schema_version': SCHEMA_VERSION,
        'studio': True,
        'mode': mode,
        'version': version,
        'project': project,
        'episode_id': episode_id,
        'clip_id': f'episode-v{version}',
        'source': source,
        'title': edits.get('title') or episode_id,
        'media': {'width': media.get('width'), 'height': media.get('height'), 'fps': media.get('fps'),
                  'duration_ms': duration_ms, 'has_video': bool(media.get('has_video', True))},
        'keep': [[int(s), int(e)] for s, e in keep],
        'mutes': [[int(s), int(e)] for s, e in ops['mutes']],
        'bleeps': [[int(s), int(e)] for s, e in ops['bleeps']],
        'cuts': [[int(s), int(e)] for s, e in ops['cuts']],
        'crossfade_ms': CROSSFADE_MS,
        'output_duration_ms': int(timeline.total_ms),
        'map': map_segments(timeline),
        'captions': {'enabled': bool(visual.get('captions', True)), 'style': style,
                     'speaker_colors': {k: (v or {}).get('color') for k, v in speakers.items()},
                     'groups': groups},
        'chapters': chapters,
        'speakers': speakers,
        'assets': assets,
        'audio': audio,
        'visual': visual,
        'extra_aspects': [a for a in (edits.get('extra_aspects') or []) if isinstance(a, str)],
        'operations_applied': ops['applied'],
        'corrections_applied': corrected,
        'range': out_range,
        'quality': str(quality or 'rough'),
        'prepared_at': time.time(),
        'warnings': warnings,
    }


# -------------------------------------------------------- the render report
#
# Schema 2 of the episode render report. It is the only place a client learns
# whether the finished file is really at the loudness target, what the file's
# timeline means (source? whole-episode preview? a window of it?) and which
# chapters ended up in it. Everything here is measured on the DELIVERABLE, not
# planned — an unverifiable value is reported as null with a warning, never
# asserted.

REPORT_SCHEMA = 2
LOUDNESS_TOLERANCE_LU = 1.0        # integrated may sit this far either side of the target
TRUE_PEAK_CEILING_DBTP = -1.0      # nothing may peak above this…
TRUE_PEAK_TOLERANCE_DB = 0.2       # …give or take the measurement's own error


def loudness_block(measured: dict | None, target_lufs: float | None, *, mastered: bool = True) -> dict:
    """
    The report's `loudness` record: what the finished file measures, next to
    the target it was mastered to. `loudness_ok` is None (unknown) when the
    file was not mastered or could not be measured — it is False only when a
    real measurement is outside tolerance.
    """
    measured = measured if isinstance(measured, dict) else None
    target = float(target_lufs) if target_lufs is not None else None
    block = {
        'target_lufs': target,
        'integrated_lufs': measured.get('integrated_lufs') if measured else None,
        'true_peak_dbtp': measured.get('true_peak_dbtp') if measured else None,
        'loudness_range_lu': measured.get('loudness_range_lu') if measured else None,
        'loudness_ok': None,
    }
    if not mastered or measured is None or target is None:
        return block
    try:
        integrated = float(block['integrated_lufs'])
        peak = float(block['true_peak_dbtp'])
    except (TypeError, ValueError):
        return block
    block['loudness_ok'] = (abs(integrated - target) <= LOUDNESS_TOLERANCE_LU
                            and peak <= TRUE_PEAK_CEILING_DBTP + TRUE_PEAK_TOLERANCE_DB)
    return block


def loudness_warning(block: dict) -> str | None:
    """Plain-language line for a finished file that missed the loudness target."""
    if not isinstance(block, dict) or block.get('loudness_ok') is not False:
        return None
    target, integrated = block.get('target_lufs'), block.get('integrated_lufs')
    peak = block.get('true_peak_dbtp')
    if integrated is not None and target is not None and abs(float(integrated) - float(target)) > LOUDNESS_TOLERANCE_LU:
        louder = 'louder' if float(integrated) > float(target) else 'quieter'
        return (f'The finished sound came out {abs(float(integrated) - float(target)):.1f} LU {louder} '
                f'than the {float(target):.0f} LUFS target.')
    return f'The finished sound peaks at {float(peak):.1f} dBTP — above the -1.0 dBTP ceiling.'


def build_studio_report(*, mode: str, quality: str, version: int, title, check: dict, measured,
                        measurements=None, target_lufs=None, mastered: bool = True,
                        rng=None, preview_output_start_ms: int = 0, total_ms: int, body_ms: int,
                        lead_ms: int = 0, tail_ms: int = 0, files=None, aspect=None, extras=None,
                        fps=None, cuts: int = 0, mutes: int = 0, bleeps: int = 0,
                        captions_on: bool = False, caption_lines: int = 0, chapters=None,
                        music: bool = False, expect_video: bool = True, parts=None,
                        spec_hash: str = '', warnings: list[str] | None = None,
                        seconds: float = 0.0) -> dict:
    """
    Report schema 2 for one studio render. `warnings` is appended to in place
    (the caller keeps the same list), so a duration or loudness problem always
    reaches the producer as words, not just as a flag.
    """
    warnings = warnings if isinstance(warnings, list) else []
    chapters = [{'title': c.get('title'), 'out_ms': int(c.get('out_ms') or 0)}
                for c in (chapters or []) if isinstance(c, dict)]
    duration_ms = int(check.get('duration_ms') or 0)
    delta = duration_ms - int(total_ms)
    loudness = loudness_block(measured, target_lufs, mastered=mastered)
    has_audio, has_video = bool(check.get('has_audio')), bool(check.get('has_video'))
    clock_mode = 'export' if mode == 'export' else ('range_preview' if rng else 'rough_preview')
    report = {
        'schema_version': REPORT_SCHEMA,
        'kind': 'studio',
        'mode': mode,
        'quality': quality,
        'version': int(version),
        'title': title,
        'range': [int(rng[0]), int(rng[1])] if rng else None,
        'duration_ms': duration_ms,
        'output_duration_ms': int(total_ms),
        'body_duration_ms': int(body_ms),
        'lead_ms': int(lead_ms),
        'tail_ms': int(tail_ms),
        'files': files or {},
        'aspect_ratio': aspect,
        'extra_aspects': list(extras or []),
        'width': check.get('width'),
        'height': check.get('height'),
        'fps': fps,
        'has_audio': has_audio,
        'has_video': has_video,
        'cuts': int(cuts),
        'muted': int(mutes),
        'bleeped': int(bleeps),
        'captions': bool(captions_on),
        'caption_lines': int(caption_lines),
        'chapters': chapters,
        'chapter_count': len(chapters),
        'clock': {
            'mode': clock_mode,
            'quality': quality,
            'range': [int(rng[0]), int(rng[1])] if rng else None,
            'preview_output_start_ms': int(preview_output_start_ms or 0),
        },
        'mastered': bool(mastered),
        'unmastered_preview': bool(mode != 'export' and not mastered),
        'music': bool(music),
        'loudness': loudness,
        'loudness_target_lufs': loudness['target_lufs'] if mastered else None,
        'measurements': measurements or {},
        'parts': list(parts or []),
        'spec_hash': spec_hash,
        'warnings': warnings,
        'validation': {
            'expected_duration_ms': int(total_ms),
            'duration_ms': duration_ms,
            'delta_ms': delta,
            'duration_ok': abs(delta) <= 500,
            'has_video': has_video,
            'has_audio': has_audio,
            'streams_ok': bool(has_audio and (has_video or not expect_video)),
            'loudness_ok': loudness['loudness_ok'],
        },
        'rendered_at': time.time(),
        'seconds': seconds,
    }
    if not report['validation']['duration_ok']:
        warnings.append(f'The finished file is {delta / 1000:.1f}s off the planned length.')
    problem = loudness_warning(loudness)
    if problem:
        warnings.append(problem)
    return report
