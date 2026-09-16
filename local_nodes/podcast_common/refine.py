"""
Refinement as a pure library — the logic that used to live in the
podcast_refine node, store-free so the browser's TypeScript twin, the CLI and
tests can all produce byte-identical candidate/request documents.

Two entry points mirroring the node's two modes:

  refine_analysis(payloads, ...)  -> (candidates_doc, chapters_doc, summary)
  refine_direct(payloads, ...)    -> (request_update, summary)

Callers own all store IO and status reporting.
"""

from __future__ import annotations
import time

from local_nodes.podcast_common.clips import (
    SCORE_WEIGHTS,
    assign_ids,
    merge_chapters,
    parse_candidate_answer,
    parse_chapters,
    quote_for,
    snap_to_sentences,
    validate_candidates,
)
from local_nodes.podcast_common.spec import describe_spec, duration_window, normalize_spec
from local_nodes.podcast_common.constraints import (
    DIRECTOR_AXES,
    DIRECTOR_WEIGHTS,
    parse_director_answer,
    request_compliance,
    select_candidates,
)

AXES = {
    'hook': 'Would the first three seconds stop a scroll?',
    'clarity': 'Is the point easy to follow with no visuals?',
    'standalone': 'Does it work with zero episode context?',
}


def refine_analysis(payloads: list, *, sentences: list[dict], duration_ms: int, episode_id: str,
                    goal: str = '', want: int = 10, min_ms: int = 20_000, max_ms: int = 90_000,
                    now: float | None = None) -> tuple[dict, dict, dict]:
    """The episode-analysis refinement: raw LLM payloads -> the exact documents the node wrote."""
    now = time.time() if now is None else now
    proposed: list[dict] = []
    chapters: list[dict] = []
    empty_parts = 0
    for payload in payloads:
        found = parse_candidate_answer(payload)
        found_chapters = parse_chapters(payload)
        if not found and not found_chapters:
            empty_parts += 1
        proposed.extend(found)
        chapters.extend(found_chapters)

    for cand in proposed:
        cand['proposed'] = {'start_ms': cand['start_ms'], 'end_ms': cand['end_ms']}
        cand['start_ms'], cand['end_ms'] = snap_to_sentences(cand['start_ms'], cand['end_ms'], sentences)

    kept = validate_candidates(proposed, duration_ms, min_ms, max_ms, want, sentences)
    for cand in kept:
        cand['quote'] = cand.get('quote') or quote_for(sentences, cand['start_ms'], cand['end_ms'])
        cand['text'] = quote_for(sentences, cand['start_ms'], cand['end_ms'], max_chars=6000)
        cand['sentence_ids'] = [s['id'] for s in sentences if s['start_ms'] < cand['end_ms'] and s['end_ms'] > cand['start_ms']]
    assign_ids(kept)
    chapters = merge_chapters(chapters, duration_ms)

    candidates_doc = {'schema_version': 1, 'episode_id': episode_id, 'goal': goal, 'generated': now,
                      'proposed': len(proposed), 'parts': len(payloads), 'empty_parts': empty_parts,
                      'limits': {'min_ms': min_ms, 'max_ms': max_ms, 'count': want},
                      'scoring': {'weights': SCORE_WEIGHTS, 'axes': AXES},
                      'candidates': kept}
    chapters_doc = {'schema_version': 1, 'chapters': chapters}
    summary = {'candidates': kept, 'chapters': chapters, 'proposed': len(proposed),
               'parts': len(payloads), 'empty_parts': empty_parts}
    return candidates_doc, chapters_doc, summary


def refine_direct(payloads: list, *, request: dict, request_id: str, sentences: list[dict],
                  duration_ms: int, defaults: dict | None = None, now: float | None = None) -> tuple[dict, dict]:
    """The Prompt Director refinement: raw LLM payloads + the request -> the exact request update."""
    now = time.time() if now is None else now
    defaults = defaults or {'target_seconds': 45, 'min_seconds': 15, 'count': 3}
    spec = normalize_spec(request.get('spec') or {}, defaults)
    window = duration_window(spec, {'min_seconds': defaults.get('min_seconds', 15)})

    proposed: list[dict] = []
    errors: list[str] = []
    notes: list[str] = []
    for payload in payloads:
        found = parse_director_answer(payload)
        if not found and isinstance(payload, str) and payload.lstrip().startswith('**LLM error**'):
            errors.append(payload.strip()[:300])
        if isinstance(payload, dict) and str(payload.get('notes') or '').strip():
            notes.append(str(payload['notes']).strip()[:1000])
        proposed.extend(found)
    if errors and not proposed:
        raise RuntimeError('; '.join(errors))

    kept, rejected = select_candidates(proposed, spec, window, sentences, duration_ms)
    for i, cand in enumerate(kept, start=1):
        cand['id'] = f'{request_id}c{i:02d}'
        cand['rank'] = i
        cand['request_id'] = request_id
        cand['sentence_ids'] = [s['id'] for s in sentences if s['start_ms'] < cand['end_ms'] and s['end_ms'] > cand['start_ms']]
    compliance = request_compliance(kept, rejected, spec, window)
    if notes:
        compliance['notes'] = notes

    update = {
        'schema_version': 1,
        'request_id': request_id,
        'status': 'done',
        'spec': spec,
        'summary': describe_spec(spec),
        'window': window,
        'scoring': {'weights': DIRECTOR_WEIGHTS, 'axes': DIRECTOR_AXES},
        'candidates': kept,
        'rejected': [{k: c.get(k) for k in ('title', 'start_ms', 'end_ms', 'score', 'speaker', 'rejected_for')} for c in rejected],
        'compliance': compliance,
        'llm_answers': payloads,
        'answered_at': now,
    }
    summary = {'spec': spec, 'summary': update['summary'], 'candidates': kept,
               'rejected': update['rejected'], 'compliance': compliance, 'notes': notes,
               'proposed': len(proposed)}
    return update, summary
