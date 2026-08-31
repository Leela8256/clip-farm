"""
Question builders for the Prompt Director pipelines — the Python twin of
frontend/lib/director.ts, sharing the prompt text in
frontend/lib/prompts/director.json. Used by tools/podcast_run.py so the
pipelines can be exercised without the browser.
"""

from __future__ import annotations
import json
import re
from pathlib import Path

from rocketride import Question

REPO = Path(__file__).resolve().parents[1]
PROMPTS = json.loads((REPO / 'frontend' / 'lib' / 'prompts' / 'director.json').read_text(encoding='utf-8'))
RETRIEVAL_LIMIT = 16
CONTEXT_CHARS = 24_000


def _apply(q: Question, block: dict) -> None:
    q.role = block['role']
    for title, text in block['instructions']:
        q.addInstruction(title, text)


def parse_question(prompt: str) -> Question:
    q = Question(expectJson=True)
    _apply(q, PROMPTS['parse'])
    for ex in PROMPTS['parse']['examples']:
        q.addExample(ex['given'], ex['result'])
    q.addQuestion(prompt.strip())
    return q


def describe_request(spec: dict, window: dict) -> str:
    dur = spec.get('duration') or {}
    ask = min(8, max(int(spec.get('count') or 1) * 2, 3))
    parts = [f"Deliver up to {ask} candidates so the best {spec.get('count', 1)} can be kept.",
             f"Length: about {dur.get('target_seconds')}s ({dur.get('mode')} mode; anything from "
             f"{window['min_ms'] / 1000:g} to {window['max_ms'] / 1000:g}s is acceptable)."]
    if spec.get('speakers'):
        parts.append('Speaker who must be talking: ' + ', '.join(spec['speakers']) + '.')
    if spec.get('subjects'):
        parts.append('Subject the clip must cover: ' + '; '.join(spec['subjects']) + '.')
    if spec.get('exclude_subjects'):
        parts.append('Subjects to stay away from: ' + '; '.join(spec['exclude_subjects']) + '.')
    if spec.get('exclude_content'):
        parts.append('Content to exclude: ' + ', '.join(spec['exclude_content']) + '.')
    if spec.get('tone'):
        parts.append(f"Tone: {spec['tone']}.")
    if spec.get('hook'):
        parts.append(f"The clip should open with {spec['hook']}.")
    if spec.get('ending'):
        parts.append(f"It should end with {spec['ending']}.")
    if spec.get('platform'):
        parts.append(f"Platform: {spec['platform']}.")
    return ' '.join(parts)


def direct_question(prompt: str, spec: dict, window: dict, project_root: str, request_id: str, episode_id: str,
                    search_query: str, transcript_lines: str | None = None) -> Question:
    """
    The discovery question. With an index: the stock embedding + store nodes
    fill question.documents with the best passages (filter scoped to this
    episode). Without one: the transcript rides along in the context.
    """
    q = Question(expectJson=True)
    _apply(q, PROMPTS['direct'])
    q.addInstruction('Request', describe_request(spec, window))
    q.addExample('Pick clips for a request from transcript passages', PROMPTS['direct']['example'])
    q.addGoal(f"Producer's request: {prompt.strip()}")
    q.addContext(f'project: {project_root}\nrequest: {request_id}')
    if transcript_lines:
        for i in range(0, len(transcript_lines), CONTEXT_CHARS):
            q.addContext('Transcript' + (' (continued)' if i else '') + ':\n' + transcript_lines[i:i + CONTEXT_CHARS])
    q.filter.objectIds = [episode_id]
    q.filter.limit = RETRIEVAL_LIMIT
    q.addQuestion(search_query.strip() or prompt.strip())
    return q


def _cut_line(c: dict) -> str:
    what = f"“{c['word']}”" if c.get('word') else 'pause'
    return f"{c['id']}: {c['kind']} {what} at {c['start_ms'] / 1000:.1f}s — {c['action']}{'' if c.get('enabled') else ' (restored)'}"


def revise_question(instruction: str, project_root: str, clip_id: str, plan: dict, sentences: list[dict],
                    candidates: list[dict], pad_ms: int = 60_000) -> Question:
    from local_nodes.podcast_common.clips import fmt_timestamp  # host-side import of the shared helper

    q = Question(expectJson=True)
    _apply(q, PROMPTS['revise'])
    for ex in PROMPTS['revise']['examples']:
        q.addExample(ex['given'], ex['result'])
    start, end = int(plan['start_ms']), int(plan['end_ms'])
    lines = []
    for s in sentences:
        if s['end_ms'] < start - pad_ms or s['start_ms'] > end + pad_ms:
            continue
        inside = s['start_ms'] < end and s['end_ms'] > start
        lines.append(f"{'>' if inside else ' '} [{fmt_timestamp(s['start_ms'])} - {fmt_timestamp(s['end_ms'])}] {s['text']}")
    options = plan.get('options') or {}
    q.addContext(f'project: {project_root}\nclip: {clip_id}')
    q.addContext(
        f"Clip {clip_id} — “{plan.get('title')}” from {fmt_timestamp(start)} to {fmt_timestamp(end)} "
        f"({(end - start) / 1000:.1f}s, rendered {plan.get('rendered_duration_ms', end - start) / 1000:.1f}s). "
        f"Options: {json.dumps({k: options.get(k) for k in ('filler_policy', 'silence_policy', 'caption_preset', 'duration_seconds', 'duration_mode')})}.\n"
        'Planned cuts:\n' + ('\n'.join(_cut_line(c) for c in plan.get('cuts') or []) or 'none')
    )
    q.addContext('Transcript around the clip (lines marked > are inside it):\n' + '\n'.join(lines))
    if candidates:
        q.addContext('Other candidates in this episode:\n' + '\n'.join(
            f"{c['id']}: [{fmt_timestamp(c['start_ms'])} - {fmt_timestamp(c['end_ms'])}] {c.get('title')}" for c in candidates))
    q.addQuestion(instruction.strip())
    return q


_TS = re.compile(r'^\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\s*$')


def parse_ts(value) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    m = _TS.match(str(value))
    if not m:
        return None
    h = int(m.group(1) or 0)
    frac = (m.group(4) or '').ljust(3, '0')
    return ((h * 60 + int(m.group(2))) * 60 + int(m.group(3))) * 1000 + (int(frac) if frac else 0)


def apply_revision(revision: dict, clip_edit: dict, plan: dict) -> dict | None:
    """
    Turn the model's revision into a new edit version (never touching the
    candidate). Returns the version record or None when the action needs the
    caller (new_request / compilation / none).
    """
    action = str(revision.get('action') or 'none')
    versions = [v for v in (clip_edit.get('versions') or []) if isinstance(v, dict)]
    n = max([int(v.get('n') or 0) for v in versions] + [0]) + 1
    base = {'n': n, 'note': str(revision.get('note') or action)[:120], 'source': 'revision'}
    if action == 'retime':
        start = parse_ts(revision.get('start'))
        end = parse_ts(revision.get('end'))
        if start is None and end is None:
            return None
        version = {**base, 'start_ms': start if start is not None else int(plan['start_ms']),
                   'end_ms': end if end is not None else int(plan['end_ms'])}
    elif action == 'retitle':
        if not revision.get('title'):
            return None
        version = {**base, 'title': str(revision['title'])[:120]}
    elif action == 'options':
        opts = revision.get('options') if isinstance(revision.get('options'), dict) else {}
        version = dict(base)
        for key in ('filler_policy', 'silence_policy', 'caption_preset', 'duration_seconds', 'duration_mode'):
            if opts.get(key) not in (None, ''):
                version[key] = opts[key]
        if opts.get('restore'):
            version['disabled_cuts'] = sorted(set(clip_edit.get('disabled_cuts') or []) | {str(c) for c in opts['restore']})
        if len(version) == len(base):
            return None
    else:
        return None
    return version
