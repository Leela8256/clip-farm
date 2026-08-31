"""
Clip editing plans: filler / pause cuts with safety rules, per-cut restore,
and duration fitting on word timestamps.

Everything works on the clip's own timeline (0 = clip start) and never cuts
through a spoken word: cut ranges come from word or silence boundaries, a
trim always lands on a word end, and padding only extends into silence.

Cut records are what the UI shows ("um" at 0:03.2 — removed / muted / kept)
and what a user can restore one by one; `edits/clip-edits.json` stores the
ids of the cuts they turned off.
"""

from __future__ import annotations
import re

from .clips import FILLERS, TAIL_MS, TimelineMap
from .media import keep_segments

FILLER_POLICIES = ('smart', 'cut', 'mute', 'keep')
SILENCE_POLICIES = ('tighten', 'keep')

FILLER_PAD_MS = 10
MIN_JOIN_GAP_MS = 120          # words joined with less natural pause than this sound glitchy
MAX_FILLER_MS = 1500           # a "filler" this long is probably a real word
MIN_FILLER_PROBABILITY = 0.5
MAX_LEVEL_STEP_DB = 12.0       # audio discontinuity across a cut we refuse to hard-cut
MAX_PAD_MS = 1000              # strict mode may add up to this much trailing room
_SENTENCE_END = re.compile(r'[.!?…]["”’)]*$')


def _cut_id(kind: str, n: int) -> str:
    return f'{kind[0]}{n:02d}'


def is_sentence_end(word: str) -> bool:
    return bool(_SENTENCE_END.search((word or '').strip()))


def plan_cuts(
    words: list[dict],
    silences: list[tuple[int, int]],
    total_ms: int,
    *,
    filler_policy: str = 'smart',
    silence_policy: str = 'tighten',
    disabled: set[str] | None = None,
    levels: dict[int, float] | None = None,
) -> list[dict]:
    """
    Every edit the clip could receive, with the action the policy chose and
    the safety verdict behind it. `silences` are the cuttable pause ranges
    from detect_silences (pause already kept), `levels` an optional map of
    time → RMS dB used to refuse cuts across a loudness step.
    """
    disabled = disabled or set()
    ordered = sorted(words, key=lambda w: w['start_ms'])
    cuts: list[dict] = []

    if filler_policy != 'keep':
        n = 0
        for i, w in enumerate(ordered):
            clean = w['word'].lower().strip('.,!?;:')
            if clean not in FILLERS:
                continue
            n += 1
            start = max(0, w['start_ms'] - FILLER_PAD_MS)
            end = min(total_ms, w['end_ms'] + FILLER_PAD_MS)
            prev_word = ordered[i - 1] if i > 0 else None
            next_word = ordered[i + 1] if i + 1 < len(ordered) else None
            safe, reason = filler_cut_safety(w, prev_word, next_word, levels)
            if filler_policy == 'cut':
                action = 'cut'
            elif filler_policy == 'mute':
                action = 'mute'
            else:  # smart
                action = 'cut' if safe else ('mute' if reason != 'probably not a filler' else 'keep')
            cut = {'id': _cut_id('filler', n), 'kind': 'filler', 'word': w['word'], 'start_ms': start, 'end_ms': end,
                   'action': action, 'safe': safe, 'reason': reason, 'enabled': True}
            if cut['id'] in disabled:
                cut['enabled'] = False
            cuts.append(cut)

    if silence_policy == 'tighten':
        n = 0
        for start, end in sorted(silences):
            start, end = max(0, int(start)), min(total_ms, int(end))
            if end - start < 100:
                continue
            n += 1
            safe, reason = silence_cut_safety(start, end, ordered, levels)
            cut = {'id': _cut_id('silence', n), 'kind': 'silence', 'word': '', 'start_ms': start, 'end_ms': end,
                   'action': 'cut' if safe else 'keep', 'safe': safe, 'reason': reason, 'enabled': True}
            if cut['id'] in disabled:
                cut['enabled'] = False
            cuts.append(cut)

    cuts.sort(key=lambda c: c['start_ms'])
    return cuts


def filler_cut_safety(word: dict, prev_word: dict | None, next_word: dict | None, levels: dict[int, float] | None = None) -> tuple[bool, str | None]:
    """Would removing this filler leave a natural join?"""
    if float(word.get('probability', 1.0)) < MIN_FILLER_PROBABILITY:
        return False, 'probably not a filler'
    if word['end_ms'] - word['start_ms'] > MAX_FILLER_MS:
        return False, 'probably not a filler'
    gap_before = word['start_ms'] - prev_word['end_ms'] if prev_word else MIN_JOIN_GAP_MS
    gap_after = next_word['start_ms'] - word['end_ms'] if next_word else MIN_JOIN_GAP_MS
    at_boundary = prev_word is not None and is_sentence_end(prev_word['word'])
    if gap_before + gap_after < MIN_JOIN_GAP_MS and not at_boundary:
        return False, 'words would be joined without a natural pause'
    if levels:
        step = level_step(levels, word['start_ms'], word['end_ms'])
        if step is not None and step > MAX_LEVEL_STEP_DB:
            return False, f'loudness jumps {step:.0f} dB across the cut'
    return True, None


def silence_cut_safety(start: int, end: int, words: list[dict], levels: dict[int, float] | None = None) -> tuple[bool, str | None]:
    """A pause cut must not swallow speech and must join similar room tone."""
    for w in words:
        if w['start_ms'] < end and w['end_ms'] > start:
            return False, f"speech inside the pause ('{w['word']}')"
    if levels:
        step = level_step(levels, start, end)
        if step is not None and step > MAX_LEVEL_STEP_DB:
            return False, f'loudness jumps {step:.0f} dB across the cut'
    return True, None


def level_step(levels: dict[int, float], start: int, end: int) -> float | None:
    """|RMS dB after − RMS dB before| for a cut, from the measured level map (keys = ms)."""
    before = levels.get(start)
    after = levels.get(end)
    if before is None or after is None:
        return None
    return abs(after - before)


def cut_ranges(cuts: list[dict]) -> list[tuple[int, int]]:
    return [(c['start_ms'], c['end_ms']) for c in cuts if c['enabled'] and c['action'] == 'cut']


def mute_ranges(cuts: list[dict]) -> list[tuple[int, int]]:
    return [(c['start_ms'], c['end_ms']) for c in cuts if c['enabled'] and c['action'] == 'mute']


def rendered_ms(keep: list[tuple[int, int]]) -> int:
    return sum(e - s for s, e in keep)


def fit_duration(
    words: list[dict],
    cuts: list[dict],
    total_ms: int,
    *,
    target_ms: int,
    mode: str = 'natural',
    tolerance_ms: int = 3000,
    room_after_ms: int = 0,
    min_clip_ms: int = 3000,
) -> dict:
    """
    Make the rendered clip land on the requested duration.

    natural  — report only; complete thoughts beat the number.
    strict   — trim the end to a word (preferring a sentence end) so the
               rendered length is within ±tolerance; if short, first give
               back pause cuts (largest first), then pad into trailing
               silence up to MAX_PAD_MS.
    maximum  — never longer than the target: trim like strict without padding.

    Returns the possibly shortened clip length (`end_ms`), the updated cut list
    (restored pause cuts are disabled with `restored_for_fit`), the keep
    segments and a report for compliance.json.
    """
    cuts = [dict(c) for c in cuts]
    actions: list[str] = []
    warnings: list[str] = []
    end_ms = int(total_ms)

    def keep_for(end: int) -> list[tuple[int, int]]:
        ranges = [(s, min(e, end)) for s, e in cut_ranges(cuts) if s < end]
        return keep_segments(ranges, end)

    before = rendered_ms(keep_for(end_ms))
    if mode not in ('strict', 'maximum'):
        met = abs(before - target_ms) <= tolerance_ms
        return {'mode': mode, 'target_ms': target_ms, 'tolerance_ms': tolerance_ms, 'before_ms': before, 'after_ms': before,
                'met': met, 'actions': actions, 'warnings': [] if met else [f'{before / 1000:.1f}s is {abs(before - target_ms) / 1000:.1f}s off the {target_ms / 1000:g}s target.'],
                'end_ms': end_ms, 'cuts': cuts, 'keep': keep_for(end_ms)}

    tol = tolerance_ms if mode == 'strict' else 0
    upper = target_ms + tol
    lower = target_ms - tol if mode == 'strict' else 0

    # --- too long: trim the end to a word boundary ----------------------------
    if before > upper:
        timeline = TimelineMap(keep_for(end_ms))
        ordered = sorted(words, key=lambda w: w['start_ms'])
        choices = []
        for i, w in enumerate(ordered):
            out_end = timeline.to_output(w['end_ms'])
            if out_end is None or out_end > upper:
                continue
            nxt = ordered[i + 1]['start_ms'] if i + 1 < len(ordered) else end_ms
            tail = min(TAIL_MS, max(0, nxt - w['end_ms']))
            choices.append((out_end, is_sentence_end(w['word']), w, tail))
        pick = None
        in_window = [c for c in choices if c[0] >= lower]
        sentence_ends = [c for c in in_window if c[1]]
        if sentence_ends:
            pick = min(sentence_ends, key=lambda c: (abs(c[0] - target_ms), -c[0]))
        elif in_window:
            pick = min(in_window, key=lambda c: (abs(c[0] - target_ms), -c[0]))
        elif choices:
            pick = max(choices, key=lambda c: c[0])
            warnings.append('No sentence or word ends inside the tolerance window — trimmed to the nearest word before it.')
        if pick is None:
            warnings.append(f'Even the first word runs past {target_ms / 1000:g}s — the clip cannot be fitted.')
        else:
            out_end, at_sentence, w, tail = pick
            new_end = min(end_ms, w['end_ms'] + tail)
            if new_end < min_clip_ms:
                warnings.append('Fitting would leave less than the minimum clip length — left unchanged.')
            else:
                end_ms = new_end
                actions.append(f"trimmed the end to {'the sentence ending' if at_sentence else 'the word'} “{w['word']}” at {w['end_ms'] / 1000:.1f}s")
        after = rendered_ms(keep_for(end_ms))
    else:
        after = before

    # --- too short (strict only): give back pauses, then pad --------------------
    if mode == 'strict' and after < lower:
        restorable = sorted((c for c in cuts if c['enabled'] and c['action'] == 'cut' and c['kind'] == 'silence' and c['start_ms'] < end_ms),
                            key=lambda c: -(c['end_ms'] - c['start_ms']))
        for cut in restorable:
            gain = min(cut['end_ms'], end_ms) - cut['start_ms']
            if after + gain > upper:
                continue
            cut['enabled'] = False
            cut['restored_for_fit'] = True
            after += gain
            actions.append(f"kept the pause at {cut['start_ms'] / 1000:.1f}s ({gain / 1000:.1f}s)")
            if after >= lower:
                break
        if after < lower:
            pad = min(MAX_PAD_MS, int(room_after_ms), target_ms - after)
            if pad > 0:
                end_ms += pad
                after += pad
                actions.append(f'padded {pad / 1000:.1f}s of trailing silence')
        if after < lower:
            warnings.append(f'Only {after / 1000:.1f}s of speech is available — {target_ms / 1000:g}s cannot be reached without cutting into a word.')

    met = lower <= after <= upper if mode == 'strict' else after <= upper
    return {'mode': mode, 'target_ms': target_ms, 'tolerance_ms': tol, 'before_ms': before, 'after_ms': after, 'met': met,
            'actions': actions, 'warnings': warnings, 'end_ms': end_ms, 'cuts': cuts, 'keep': keep_for(end_ms)}
