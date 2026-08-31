"""
Prompt Director selection: hard constraints first, quality ranking second.

A candidate that breaks a hard constraint of the request (wrong speaker, topic
missing, excluded content, outside the duration window, cut mid-thought,
overlapping a better clip) is rejected with a reason; the survivors are ranked
on explainable component scores. Nothing here fabricates compliance — when a
constraint cannot be verified (speaker identity without diarization) the
compliance flag is None and a warning says why.
"""

from __future__ import annotations
import re
from typing import Any

from .clips import _clamp_score, parse_json_payload, parse_timestamp, snap_to_sentences, quote_for

DIRECTOR_WEIGHTS = {'prompt_match': 0.35, 'hook': 0.25, 'standalone': 0.20, 'clarity': 0.10, 'energy': 0.10}
DIRECTOR_AXES = {
    'prompt_match': 'How well the moment answers the producer’s direction (subject, tone, hook, ending).',
    'hook': 'Would the first three seconds stop a scroll?',
    'standalone': 'Does it work with zero episode context?',
    'clarity': 'Is the point easy to follow with no visuals?',
    'energy': 'Vocal and visual energy: pace, emphasis, emotion.',
}
# score points lost per second outside the tolerance window (natural mode)
DURATION_PENALTY_PER_S = 0.15
MAX_DURATION_PENALTY = 2.0
OVERLAP_LIMIT = 0.4

PROFANITY = {
    'fuck', 'fucking', 'fucked', 'fucker', 'motherfucker', 'shit', 'shitty', 'bullshit', 'asshole', 'bitch', 'bastard',
    'damn', 'goddamn', 'crap', 'dick', 'cunt', 'piss', 'pissed', 'wanker', 'bollocks', 'arsehole', 'prick', 'slut', 'whore',
}
_WORD_RE = re.compile(r"[a-z']+")


def find_profanity(text: str) -> list[str]:
    """Distinct profane words in the text, in order of appearance."""
    found: list[str] = []
    for token in _WORD_RE.findall((text or '').lower()):
        clean = token.strip("'")
        if clean in PROFANITY and clean not in found:
            found.append(clean)
    return found


def _text(value: Any, limit: int) -> str:
    return str(value or '').strip()[:limit]


def _flag(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ('true', 'yes', '1'):
        return True
    if text in ('false', 'no', '0'):
        return False
    return None


def parse_director_answer(payload: Any) -> list[dict]:
    """
    Candidates from one discovery answer. Same tolerant parsing as the episode
    analysis, plus the director-specific fields: prompt_match / energy scores,
    the speaker the model believes is talking (with its evidence), and the
    compliance flags it was asked to assert.
    """
    data = parse_json_payload(payload)
    items = data
    if isinstance(data, dict):
        items = data.get('candidates') or data.get('clips') or []
    if not isinstance(items, list):
        return []
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        start = parse_timestamp(item.get('start_ms', item.get('start')))
        end = parse_timestamp(item.get('end_ms', item.get('end')))
        if start is None or end is None or end <= start:
            continue
        raw = item.get('scores') if isinstance(item.get('scores'), dict) else {}
        scores = {k: _clamp_score(raw.get(k, item.get(k))) for k in DIRECTOR_WEIGHTS}
        speaker = item.get('speaker')
        out.append({
            'start_ms': start,
            'end_ms': end,
            'title': _text(item.get('title'), 120),
            'hook': _text(item.get('hook'), 200),
            'reason': _text(item.get('reason') or item.get('why'), 600),
            'quote': _text(item.get('quote'), 400),
            'takeaway': _text(item.get('takeaway') or item.get('ending'), 300),
            'speaker': _text(speaker, 60) or None,
            'speaker_evidence': _text(item.get('speaker_evidence'), 200),
            'topic_found': _flag(item.get('topic_found', item.get('required_topic_found'))),
            'excluded_found': _flag(item.get('excluded_found', item.get('excluded_subject_found'))),
            'complete_ending': _flag(item.get('complete_ending')),
            'scores': scores,
        })
    return out


def director_score(cand: dict, window: dict) -> float:
    """Weighted component score minus a small penalty for missing the duration target (natural mode only)."""
    scores = cand.get('scores') or {}
    total = sum(DIRECTOR_WEIGHTS.values())
    base = sum(float(scores.get(k, 5.0)) * w for k, w in DIRECTOR_WEIGHTS.items()) / total
    penalty = 0.0
    if window.get('mode') == 'natural':
        off = abs((cand['end_ms'] - cand['start_ms']) - window['target_ms']) - window.get('tolerance_ms', 0)
        if off > 0:
            penalty = min(MAX_DURATION_PENALTY, off / 1000 * DURATION_PENALTY_PER_S)
    return round(max(0.0, base - penalty), 2)


def _speaker_matches(wanted: list[str], found: str | None) -> bool | None:
    if not wanted:
        return True
    if not found:
        return None
    f = found.lower()
    return any(w.lower() in f or f in w.lower() for w in wanted)


def check_constraints(cand: dict, spec: dict, window: dict, text: str) -> dict:
    """
    Hard-constraint verdict for one candidate. Returns the compliance record
    (`ok` plus per-constraint flags and warnings). `text` is the transcript of
    the candidate's final boundaries.
    """
    warnings: list[str] = []
    reasons: list[str] = []
    duration_ms = cand['end_ms'] - cand['start_ms']
    duration_ok = window['min_ms'] <= duration_ms <= window['max_ms']
    if not duration_ok:
        reasons.append(f"{duration_ms / 1000:.1f}s is outside the {window['min_ms'] / 1000:g}-{window['max_ms'] / 1000:g}s window")

    profane = find_profanity(text)
    profanity_found = bool(profane)
    if profanity_found and 'profanity' in (spec.get('exclude_content') or []):
        reasons.append('contains profanity (' + ', '.join(profane[:3]) + ')')

    speaker_match = _speaker_matches(spec.get('speakers') or [], cand.get('speaker'))
    if spec.get('speakers'):
        if speaker_match is False:
            reasons.append(f"speaker is {cand.get('speaker')}, not {' / '.join(spec['speakers'])}")
        elif speaker_match is None:
            warnings.append('Speaker could not be verified from the transcript (no diarization yet).')

    topic_found = cand.get('topic_found')
    if spec.get('subjects'):
        if topic_found is False:
            reasons.append('required subject not covered')
        elif topic_found is None:
            warnings.append('Subject coverage was not asserted by the model.')
    else:
        topic_found = True if topic_found is None else topic_found

    excluded_found = cand.get('excluded_found')
    if spec.get('exclude_subjects') and excluded_found:
        reasons.append('touches an excluded subject')

    complete_ending = cand.get('complete_ending')
    if complete_ending is False:
        reasons.append('does not end on a complete thought')
    elif complete_ending is None:
        complete_ending = bool(re.search(r'[.!?…]["”’)]*\s*$', text or ''))
        if not complete_ending:
            warnings.append('The last sentence has no terminal punctuation — check the ending.')

    return {
        'ok': not reasons,
        'rejected_for': reasons,
        'duration_requested': round(window['target_ms'] / 1000, 1),
        'duration_planned': round(duration_ms / 1000, 1),
        'duration_ok': duration_ok,
        'speaker_match': speaker_match if spec.get('speakers') else None,
        'required_topic_found': topic_found,
        'excluded_subject_found': bool(excluded_found) if spec.get('exclude_subjects') else False,
        'profanity_found': profanity_found,
        'profane_words': profane,
        'complete_ending': bool(complete_ending),
        'warnings': warnings,
    }


def _overlap_ms(a: dict, b: dict) -> int:
    return max(0, min(a['end_ms'], b['end_ms']) - max(a['start_ms'], b['start_ms']))


def select_candidates(proposed: list[dict], spec: dict, window: dict, sentences: list[dict], duration_ms: int) -> tuple[list[dict], list[dict]]:
    """
    Snap every proposal to sentence boundaries, apply the hard constraints,
    rank the survivors and keep the best non-overlapping `count`. Returns
    (kept, rejected); rejected entries carry `rejected_for`.
    """
    want = int(spec.get('count') or 1)
    checked: list[dict] = []
    for raw in proposed:
        cand = dict(raw)
        cand['proposed'] = {'start_ms': cand['start_ms'], 'end_ms': cand['end_ms']}
        cand['start_ms'], cand['end_ms'] = snap_to_sentences(cand['start_ms'], cand['end_ms'], sentences)
        cand['start_ms'] = max(0, cand['start_ms'])
        if duration_ms:
            cand['end_ms'] = min(duration_ms, cand['end_ms'])
        if cand['end_ms'] - cand['start_ms'] > window['max_ms'] and sentences:
            # trim back to the last sentence end inside the window (never mid-sentence)
            limit = cand['start_ms'] + window['max_ms']
            ends = [s['end_ms'] for s in sentences if cand['start_ms'] < s['end_ms'] <= limit]
            if ends:
                cand['end_ms'] = max(ends)
        cand['duration_ms'] = cand['end_ms'] - cand['start_ms']
        cand['text'] = quote_for(sentences, cand['start_ms'], cand['end_ms'], max_chars=6000)
        cand['quote'] = cand.get('quote') or quote_for(sentences, cand['start_ms'], cand['end_ms'])
        cand['compliance'] = check_constraints(cand, spec, window, cand['text'])
        cand['score'] = director_score(cand, window)
        checked.append(cand)

    checked.sort(key=lambda c: (-c['score'], c['start_ms']))
    kept: list[dict] = []
    rejected: list[dict] = []
    for cand in checked:
        if not cand['compliance']['ok']:
            cand['rejected_for'] = cand['compliance']['rejected_for']
            rejected.append(cand)
            continue
        length = max(1, cand['end_ms'] - cand['start_ms'])
        clash = next((k for k in kept if _overlap_ms(cand, k) > OVERLAP_LIMIT * length), None)
        if clash is not None:
            cand['rejected_for'] = [f"overlaps a higher-ranked clip ({clash.get('title') or clash['start_ms']})"]
            rejected.append(cand)
            continue
        if len(kept) >= want:
            cand['rejected_for'] = [f'beyond the requested {want} clip(s)']
            rejected.append(cand)
            continue
        kept.append(cand)
    return kept, rejected


def request_compliance(kept: list[dict], rejected: list[dict], spec: dict, window: dict) -> dict:
    """Aggregate report for analysis/requests/<id>.json."""
    want = int(spec.get('count') or 1)
    warnings: list[str] = list(spec.get('warnings') or [])
    if len(kept) < want:
        warnings.append(f'Only {len(kept)} of the {want} requested clip(s) met every constraint.')
    unverified = [c for c in kept if c['compliance'].get('speaker_match') is None and spec.get('speakers')]
    if unverified:
        warnings.append(f'{len(unverified)} clip(s) could not have their speaker verified.')
    reasons: dict[str, int] = {}
    for cand in rejected:
        for reason in cand.get('rejected_for') or []:
            key = reason.split(' (')[0]
            reasons[key] = reasons.get(key, 0) + 1
    return {
        'requested': want,
        'delivered': len(kept),
        'proposed': len(kept) + len(rejected),
        'rejected': len(rejected),
        'rejection_reasons': reasons,
        'duration': {'mode': window['mode'], 'target_seconds': window['target_ms'] / 1000,
                     'window_seconds': [window['min_ms'] / 1000, window['max_ms'] / 1000]},
        'all_topic_found': all(c['compliance'].get('required_topic_found') is not False for c in kept),
        'profanity_free': not any(c['compliance'].get('profanity_found') for c in kept),
        'warnings': warnings,
    }
