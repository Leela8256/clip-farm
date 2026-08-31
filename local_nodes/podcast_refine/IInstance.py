"""
podcast_refine — turns the LLM's answers into an explainable, validated
candidate list.

Two modes, decided by what reaches the node:

  episode analysis   answers from llm_anthropic (one per transcript part) +
                     the episode reference on the text lane from
                     podcast_segment. Snaps proposals to sentence boundaries,
                     applies the length and overlap rules, ranks by the
                     hook / clarity / standalone rubric, writes
                     analysis/candidates.json + chapters.json.

  Prompt Director    the chat question itself (questions lane, for the
                     'project:' / 'request:' context) + the LLM's answer to a
                     directed search. Loads the request spec, enforces the
                     hard constraints (speaker, subject, exclusions, duration
                     window, complete thoughts, no overlaps), ranks the
                     survivors on prompt match / hook / standalone / clarity /
                     energy and writes the request file with its compliance
                     report. Nothing is fabricated: unverifiable constraints
                     are reported as warnings.
"""

from __future__ import annotations
import json
import time

from rocketlib import IInstanceBase, Entry, warning
from ai.common.schema import Answer

from local_nodes.podcast_common.store import get_store, write_json
from local_nodes.podcast_common.project import (
    Project,
    load_project,
    parse_context,
    parse_ref,
    read_json_or,
    save_project,
    update_status,
)
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

from .IGlobal import IGlobal

NODE = 'podcast_refine'
AXES = {
    'hook': 'Would the first three seconds stop a scroll?',
    'clarity': 'Is the point easy to follow with no visuals?',
    'standalone': 'Does it work with zero episode context?',
}


def _payload(answer):
    """The parsed JSON (or raw text) of one Answer object coming off the LLM lane."""
    if hasattr(answer, 'getJson'):
        try:
            data = answer.getJson()
            if data is not None:
                return data
        except Exception:  # noqa: BLE001
            pass
    if hasattr(answer, 'getText'):
        try:
            return answer.getText()
        except Exception:  # noqa: BLE001
            pass
    return getattr(answer, 'answer', answer)


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        pass

    def open(self, obj: Entry):
        self._ref = None
        self._ctx: dict = {}
        self._payloads: list = []
        self._t0 = time.time()

    def writeText(self, text: str):
        ref = parse_ref(text)
        if ref:
            self._ref = ref

    def writeQuestions(self, question):
        # the chat question (Prompt Director): only its context lines matter here
        self._ctx = parse_context(question)

    def writeAnswers(self, answers):
        items = answers if isinstance(answers, (list, tuple)) else [answers]
        for item in items:
            self._payloads.append(_payload(item))

    def closing(self):
        store = get_store()
        pipe = getattr(self.instance, 'pipeId', None)
        root = (self._ref or {}).get('project') or self._ctx.get('project')
        if not root or store is None:
            warning(f'{NODE}: no episode reference / store')
            self._emit({'error': 'podcast_refine received no episode reference'})
            return
        project = Project(root)
        request_id = (self._ctx.get('request') or '').strip()
        try:
            manifest = self._direct(store, project, request_id, pipe) if request_id else self._refine(store, project, pipe)
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: {exc}')
            update_status(store, project, NODE, 'error', pipe, message=str(exc), request=request_id or None)
            manifest = {**project.to_ref(), 'request_id': request_id or None, 'error': str(exc)}
        self._emit(manifest)

    # ------------------------------------------------------------ analysis

    def _refine(self, store, project: Project, pipe) -> dict:
        cfg = self.IGlobal.config
        data = load_project(store, project)
        transcript = read_json_or(store, project.analysis('transcript.json'), {}) or {}
        sentences = transcript.get('sentences') or []
        duration_ms = int((data.get('media') or {}).get('duration_ms') or transcript.get('duration_ms') or 0)
        settings = data.get('settings') or {}
        want = int(settings.get('clip_count') or cfg['candidates'])
        min_ms = int(settings.get('min_seconds') or cfg['min_seconds']) * 1000
        max_ms = int(settings.get('max_seconds') or cfg['max_seconds']) * 1000
        goal = str(settings.get('goal') or '')

        # keep the raw model answers next to the derived candidates (explainability + debugging)
        write_json(store, project.analysis('llm-answers.json'),
                   {'schema_version': 1, 'generated': time.time(), 'answers': self._payloads})
        proposed: list[dict] = []
        chapters: list[dict] = []
        empty_parts = 0
        for payload in self._payloads:
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

        write_json(store, project.analysis('candidates.json'),
                   {'schema_version': 1, 'episode_id': project.episode_id, 'goal': goal, 'generated': time.time(),
                    'proposed': len(proposed), 'parts': len(self._payloads), 'empty_parts': empty_parts,
                    'limits': {'min_ms': min_ms, 'max_ms': max_ms, 'count': want},
                    'scoring': {'weights': SCORE_WEIGHTS, 'axes': AXES},
                    'candidates': kept})
        write_json(store, project.analysis('chapters.json'), {'schema_version': 1, 'chapters': chapters})

        seconds = round(time.time() - self._t0, 1)
        data['analysis'] = {'status': 'analyzed', 'candidates': len(kept), 'proposed': len(proposed),
                            'chapters': len(chapters), 'sentences': len(sentences), 'parts': len(self._payloads),
                            'analyzed_at': time.time()}
        save_project(store, project, data)
        update_status(store, project, NODE, 'analyzed', pipe, candidates=len(kept), proposed=len(proposed),
                      chapters=len(chapters), seconds=seconds)
        return {**project.to_ref(), 'goal': goal, 'candidates': kept, 'chapters': chapters,
                'proposed': len(proposed), 'parts': len(self._payloads), 'empty_parts': empty_parts, 'seconds': seconds}

    # ------------------------------------------------------ Prompt Director

    def _direct(self, store, project: Project, request_id: str, pipe) -> dict:
        cfg = self.IGlobal.config
        request = read_json_or(store, project.request(request_id), None)
        if not isinstance(request, dict):
            raise ValueError(f'{NODE}: request {request_id!r} not found under {project.requests_dir}')
        spec = normalize_spec(request.get('spec') or {}, {'target_seconds': cfg['target_seconds'], 'min_seconds': cfg['min_seconds'], 'count': cfg['candidates']})
        window = duration_window(spec, {'min_seconds': cfg['min_seconds']})
        data = load_project(store, project)
        transcript = read_json_or(store, project.analysis('transcript.json'), {}) or {}
        sentences = transcript.get('sentences') or []
        duration_ms = int((data.get('media') or {}).get('duration_ms') or transcript.get('duration_ms') or 0)
        if not sentences:
            raise ValueError(f'{NODE}: no transcript for {project.root} — run the episode analysis first')

        proposed: list[dict] = []
        errors: list[str] = []
        notes: list[str] = []
        for payload in self._payloads:
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
        seconds = round(time.time() - self._t0, 1)

        request.update({
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
            'llm_answers': self._payloads,
            'answered_at': time.time(),
            'seconds': seconds,
        })
        write_json(store, project.request(request_id), request)

        requests = data.setdefault('requests', {})
        requests[request_id] = {'prompt': request.get('prompt'), 'summary': request['summary'], 'delivered': len(kept),
                                'requested': compliance['requested'], 'answered_at': request['answered_at']}
        save_project(store, project, data)
        update_status(store, project, NODE, 'directed', pipe, request=request_id, candidates=len(kept),
                      proposed=len(proposed), rejected=len(rejected), seconds=seconds)
        return {**project.to_ref(), 'request_id': request_id, 'spec': spec, 'summary': request['summary'],
                'candidates': kept, 'rejected': request['rejected'], 'compliance': compliance, 'notes': notes,
                'proposed': len(proposed), 'seconds': seconds}

    def _emit(self, payload: dict):
        answer = Answer(expectJson=True)
        answer.setAnswer(payload)
        if self.instance.hasListener('answers'):
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(payload))
