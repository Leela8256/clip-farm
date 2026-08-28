"""
podcast_refine — merges the LLM's per-part answers into the episode's
candidate list. Snaps proposals to sentence boundaries, applies the length
and overlap rules, ranks by the weighted rubric score and persists
analysis/candidates.json, analysis/chapters.json and the project status.
"""

from __future__ import annotations
import json
import time

from rocketlib import IInstanceBase, Entry, warning
from ai.common.schema import Answer

from local_nodes.podcast_common.store import get_store, write_json
from local_nodes.podcast_common.project import Project, parse_ref, load_project, save_project, read_json_or, update_status
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
        self._payloads: list = []
        self._t0 = time.time()

    def writeText(self, text: str):
        ref = parse_ref(text)
        if ref:
            self._ref = ref

    def writeAnswers(self, answers):
        items = answers if isinstance(answers, (list, tuple)) else [answers]
        for item in items:
            self._payloads.append(_payload(item))

    def closing(self):
        store = get_store()
        pipe = getattr(self.instance, 'pipeId', None)
        if not self._ref or store is None:
            warning(f'{NODE}: no episode reference / store')
            self._emit({'error': 'podcast_refine received no episode reference'})
            return
        project = Project(self._ref['project'])
        try:
            manifest = self._refine(store, project, pipe)
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: {exc}')
            update_status(store, project, NODE, 'error', pipe, message=str(exc))
            manifest = {**project.to_ref(), 'error': str(exc)}
        self._emit(manifest)

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

    def _emit(self, payload: dict):
        answer = Answer(expectJson=True)
        answer.setAnswer(payload)
        if self.instance.hasListener('answers'):
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(payload))
