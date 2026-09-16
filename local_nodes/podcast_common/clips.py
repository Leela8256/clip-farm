"""
Pure clip logic shared by the podcast nodes: transcript chunking for the LLM,
tolerant parsing of its answers, sentence/word boundary snapping, candidate
validation and ranking, and the source-time -> rendered-time mapping used to
place captions after silence/filler cuts.

A candidate is a [start_ms, end_ms] window over the episode plus the LLM's
explanation (title, hook, reason, scores). Sentence timestamps from the stock
transcriber are the coarse ground truth; word timestamps (aligned per clip)
are the fine one.
"""

from __future__ import annotations
import difflib
import json
import re
from typing import Any

SCORE_WEIGHTS = {'hook': 0.4, 'standalone': 0.3, 'clarity': 0.3}
FILLERS = {'um', 'uh', 'erm', 'hmm', 'mhm', 'uh-huh', 'umm', 'uhh'}

# Breathing room added around snapped word boundaries, limited by the gap to
# the neighbouring word so the pad never eats into adjacent speech.
LEAD_IN_MS = 150
TAIL_MS = 300

_TIMESTAMP_RE = re.compile(r'^\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\s*$')


def fmt_timestamp(ms: int) -> str:
    """mm:ss under an hour, h:mm:ss above — the format the LLM sees and returns."""
    s = int(ms) // 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f'{h}:{m:02d}:{sec:02d}' if h else f'{m:02d}:{sec:02d}'


def parse_timestamp(value: Any) -> int | None:
    """Accept milliseconds (int/float/digit string) or 'mm:ss' / 'h:mm:ss[.fff]'."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if text.isdigit():
        return int(text)
    m = _TIMESTAMP_RE.match(text)
    if not m:
        return None
    hours = int(m.group(1) or 0)
    minutes, seconds = int(m.group(2)), int(m.group(3))
    frac = m.group(4) or ''
    millis = int(frac.ljust(3, '0')) if frac else 0
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def slugify(text: str, fallback: str = 'clip') -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', (text or '').lower()).strip('-')
    return slug[:60] or fallback


# ----------------------------------------------------------------- transcript


def sentence_lines(sentences: list[dict]) -> str:
    lines = []
    for s in sentences:
        text = (s.get('text') or '').strip()
        if text:
            lines.append(f"[{fmt_timestamp(s['start_ms'])} - {fmt_timestamp(s['end_ms'])}] {text}")
    return '\n'.join(lines)


def chunk_sentences(sentences: list[dict], chunk_ms: int, overlap_ms: int = 0) -> list[list[dict]]:
    """
    Split the transcript into prompt-sized parts by time. Each part starts a
    little before its window (overlap) so a moment straddling a boundary is
    still seen whole by at least one part; a short trailing part is folded
    into the previous one.
    """
    if not sentences:
        return []
    ordered = sorted(sentences, key=lambda s: s['start_ms'])
    chunks: list[list[dict]] = []
    cursor = ordered[0]['start_ms']
    last = ordered[-1]['end_ms']
    while cursor < last:
        window_end = cursor + chunk_ms
        part = [s for s in ordered if cursor - overlap_ms <= s['start_ms'] < window_end]
        if part:
            chunks.append(part)
        cursor = window_end
    if len(chunks) > 1:
        tail = chunks[-1]
        if tail[-1]['end_ms'] - tail[0]['start_ms'] < chunk_ms * 0.25:
            seen = {id(s) for s in chunks[-2]}
            chunks[-2].extend(s for s in tail if id(s) not in seen)
            chunks.pop()
    return chunks


def quote_for(sentences: list[dict], start_ms: int, end_ms: int, max_chars: int = 320) -> str:
    text = ' '.join((s.get('text') or '').strip() for s in sentences
                    if s['start_ms'] < end_ms and s['end_ms'] > start_ms)
    return text[:max_chars].rstrip() + ('…' if len(text) > max_chars else '')


# ---------------------------------------------------------------- LLM answers


def parse_json_payload(answer: Any) -> Any:
    """The parsed dict/list the SDK returns for expectJson answers, or a tolerant parse of raw text."""
    if not isinstance(answer, str):
        return answer
    text = answer.strip()
    fence = re.search(r'```(?:json)?\s*(.*?)```', text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r'(\{.*\}|\[.*\])', text, re.S)
        if not match:
            return None
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            return None


def _clamp_score(value: Any, default: float = 5.0) -> float:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(10.0, round(score, 1)))


def overall_score(scores: dict, weights: dict | None = None) -> float:
    weights = weights or SCORE_WEIGHTS
    total = sum(weights.values()) or 1.0
    return round(sum(float(scores.get(k, 5.0)) * w for k, w in weights.items()) / total, 2)


def parse_candidate_answer(payload: Any) -> list[dict]:
    """Normalise one LLM answer into candidate dicts; malformed entries are dropped, not fatal."""
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
        raw_scores = item.get('scores') if isinstance(item.get('scores'), dict) else {}
        fallback = item.get('score')
        scores = {
            'hook': _clamp_score(raw_scores.get('hook', fallback)),
            'clarity': _clamp_score(raw_scores.get('clarity', fallback)),
            'standalone': _clamp_score(raw_scores.get('standalone', fallback)),
        }
        out.append(
            {
                'start_ms': start,
                'end_ms': end,
                'title': str(item.get('title') or '').strip()[:120],
                'hook': str(item.get('hook') or '').strip()[:200],
                'reason': str(item.get('reason') or item.get('why') or '').strip()[:600],
                'quote': str(item.get('quote') or '').strip()[:400],
                'scores': scores,
                'score': overall_score(scores),
            }
        )
    return out


def parse_chapters(payload: Any) -> list[dict]:
    data = parse_json_payload(payload)
    items = data.get('chapters') if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        start = parse_timestamp(item.get('start_ms', item.get('start')))
        title = str(item.get('title') or '').strip()[:120]
        if start is not None and title:
            out.append({'start_ms': start, 'title': title})
    return out


def merge_chapters(chapters: list[dict], duration_ms: int, min_gap_ms: int = 60_000) -> list[dict]:
    """Dedupe chapters proposed by overlapping parts (first wins inside min_gap) and add end times."""
    merged: list[dict] = []
    for ch in sorted(chapters, key=lambda c: c['start_ms']):
        if merged and ch['start_ms'] - merged[-1]['start_ms'] < min_gap_ms:
            continue
        merged.append(dict(ch))
    for i, ch in enumerate(merged):
        ch['end_ms'] = merged[i + 1]['start_ms'] if i + 1 < len(merged) else duration_ms
        ch['id'] = f'ch{i + 1:02d}'
    return merged


# ------------------------------------------------------------------ snapping


def snap_to_sentences(start_ms: int, end_ms: int, sentences: list[dict]) -> tuple[int, int]:
    """Move a window onto the nearest sentence start / sentence end."""
    if not sentences:
        return start_ms, end_ms
    ordered = sorted(sentences, key=lambda s: s['start_ms'])
    first = min(ordered, key=lambda s: abs(s['start_ms'] - start_ms))
    last = min(ordered, key=lambda s: abs(s['end_ms'] - end_ms))
    new_start = first['start_ms']
    new_end = max(last['end_ms'], first['end_ms'])
    return new_start, new_end


def _overlap_ms(a: dict, b: dict) -> int:
    return max(0, min(a['end_ms'], b['end_ms']) - max(a['start_ms'], b['start_ms']))


def validate_candidates(
    candidates: list[dict],
    total_duration_ms: int,
    min_ms: int,
    max_ms: int,
    max_count: int,
    sentences: list[dict] | None = None,
) -> list[dict]:
    """
    Clamp to the episode, drop clips that are too short, trim ones that run too
    long (back to a sentence end when the transcript is given), dedupe heavy
    overlaps (highest score wins) and return the top N, best first.
    """
    cleaned = []
    for cand in candidates:
        start = max(0, int(cand['start_ms']))
        end = min(int(total_duration_ms), int(cand['end_ms'])) if total_duration_ms else int(cand['end_ms'])
        if end - start > max_ms:
            limit = start + max_ms
            ends = [s['end_ms'] for s in (sentences or []) if start < s['end_ms'] <= limit]
            end = max(ends) if ends else limit
        if end - start < min_ms:
            continue
        cleaned.append({**cand, 'start_ms': start, 'end_ms': end, 'duration_ms': end - start})

    cleaned.sort(key=lambda c: (-float(c.get('score') or 0), c['start_ms']))
    kept: list[dict] = []
    for cand in cleaned:
        length = cand['end_ms'] - cand['start_ms']
        if any(_overlap_ms(cand, k) > 0.4 * length for k in kept):
            continue
        kept.append(cand)
        if len(kept) >= max_count:
            break
    return kept


def assign_ids(candidates: list[dict]) -> list[dict]:
    for i, cand in enumerate(candidates, start=1):
        cand['id'] = f'c{i:02d}'
        cand['rank'] = i
    return candidates


# -------------------------------------------------------------------- words


def snap_to_word_boundaries(start_ms: int, end_ms: int, words: list[dict]) -> tuple[int, int]:
    """
    Move the window edges onto the nearest word start / word end so a clip
    never opens or closes mid-word, then pad slightly into the surrounding
    silence (never into the neighbouring word).
    """
    if not words:
        return start_ms, end_ms
    ordered = sorted(words, key=lambda w: w['start_ms'])
    first_idx = min(range(len(ordered)), key=lambda i: abs(ordered[i]['start_ms'] - start_ms))
    last_idx = min(range(len(ordered)), key=lambda i: abs(ordered[i]['end_ms'] - end_ms))
    if last_idx < first_idx:
        last_idx = first_idx
    first, last = ordered[first_idx], ordered[last_idx]
    prev_end = ordered[first_idx - 1]['end_ms'] if first_idx > 0 else 0
    next_start = ordered[last_idx + 1]['start_ms'] if last_idx + 1 < len(ordered) else None
    new_start = first['start_ms'] - min(LEAD_IN_MS, max(0, first['start_ms'] - prev_end))
    tail_room = TAIL_MS if next_start is None else max(0, next_start - last['end_ms'])
    new_end = last['end_ms'] + min(TAIL_MS, tail_room)
    return max(0, new_start), new_end


def _tokens(text: str) -> list[str]:
    return [t for t in re.sub(r"[^a-z0-9' ]+", ' ', (text or '').lower()).split() if t]


def locate_span(words: list[dict], text: str, min_ratio: float = 0.5) -> tuple[int, int] | None:
    """
    Time span of the aligned words that best match a candidate's transcript text
    (token-level fuzzy match). The stock transcriber's sentence boundaries can
    include the tail of the previous sentence; matching the candidate's own words
    makes the clip start on its first word and end on its last.
    """
    if not words or not text:
        return None
    flat = [(_tokens(w['word']) or [''])[0] for w in words]
    target = _tokens(text)
    if len(target) < 3:
        return None
    matcher = difflib.SequenceMatcher(None, flat, target, autojunk=False)
    blocks = [b for b in matcher.get_matching_blocks() if b.size > 0]
    if not blocks:
        return None
    if sum(b.size for b in blocks) / len(target) < min_ratio:
        return None
    anchor = max(blocks, key=lambda b: b.size)
    window = len(target) + 10
    kept = [b for b in blocks if abs(b.a - anchor.a) <= window and (b.size >= 2 or b is anchor)]
    first, last = kept[0], kept[-1]
    return words[first.a]['start_ms'], words[last.a + last.size - 1]['end_ms']


def words_in_range(words: list[dict], start_ms: int, end_ms: int) -> list[dict]:
    """Words inside [start_ms, end_ms], re-based so start_ms becomes 0 (the clip's own timeline)."""
    out = []
    for w in sorted(words, key=lambda w: w['start_ms']):
        if w['end_ms'] <= start_ms or w['start_ms'] >= end_ms:
            continue
        out.append({**w, 'start_ms': max(0, w['start_ms'] - start_ms), 'end_ms': min(end_ms, w['end_ms']) - start_ms})
    return out


def filler_cuts(words: list[dict], total_ms: int, pad_ms: int = 10) -> list[tuple[int, int]]:
    cuts = []
    for w in words:
        clean = w['word'].lower().strip('.,!?;:')
        if clean in FILLERS and float(w.get('probability', 1.0)) > 0.5:
            cuts.append((max(0, w['start_ms'] - pad_ms), min(total_ms, w['end_ms'] + pad_ms)))
    return cuts


# The source-time -> rendered-time mapping moved into the renderer's library
# with the node (`local_nodes/media_render/render_lib.py`); it is pure geometry
# and the generic node may not import this module. Re-exported so every
# existing importer keeps working.
from local_nodes.media_render.render_lib import TimelineMap, map_words_to_output  # noqa: E402,F401
