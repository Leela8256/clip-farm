"""
podcast_segment — the bridge between the stock transcriber and the stock
LLM / embedding nodes.

Collects audio_transcribe's sentence documents (documents lane) and the
reference media_io forwards (text lane): the intervals of the recording that
were streamed to the transcriber, in stream order, plus the caller's own
context keys (`project:` among them). Every batch of sentences is persisted to
analysis/transcript.partial.json with absolute times, so a run that is cut
short can be resumed piece by piece. On close it writes
analysis/transcript.json and then, per wired listener:

  questions   one rubric question per ~10-minute part (llm_anthropic answers
              with candidate clips + chapters, which podcast_refine merges)
  documents   overlapping, sentence-aligned passages of the transcript for
              the semantic index (embedding_transformer -> a stock vector
              store), keyed by the episode id

When no transcriber is wired (the transcript-index pipe) the node reads the
transcript the analysis already wrote instead of transcribing again.
"""

from __future__ import annotations
import json
import math
import re
import time

from rocketlib import IInstanceBase, Entry, warning, debug
from ai.common.schema import Question, QuestionType

from local_nodes.podcast_common.store import get_store, write_json
from local_nodes.podcast_common.project import PARTIAL_TRANSCRIPT, Project, load_project, read_json_or, save_project, update_status
from local_nodes.podcast_common.reference import media_reference, piece_offsets, pieces_block, ref_project
from local_nodes.podcast_common.clips import chunk_sentences, fmt_timestamp, sentence_lines
from local_nodes.podcast_common.passages import EMBED_MODEL_HINT, STEP_MS, WINDOW_MS, passage_documents, window_passages

from .IGlobal import IGlobal

NODE = 'podcast_segment'

ROLE = (
    'You are a senior short-form producer for a podcast. You read transcripts and pick the moments '
    'that will work as standalone promotional clips, and you explain every pick in plain language.'
)

EXAMPLE_ANSWER = {
    'chunk': 2,
    'candidates': [
        {
            'start': '14:02',
            'end': '14:51',
            'title': 'Pipelines in an afternoon, not a quarter',
            'hook': 'We used to budget three months for this.',
            'reason': 'Concrete before/after with a number in the first sentence; the thought closes cleanly at 14:51.',
            'quote': 'We used to budget three months for this kind of integration.',
            'scores': {'hook': 9, 'clarity': 8, 'standalone': 8},
        }
    ],
    'chapters': [{'start': '12:40', 'title': 'Why integrations used to take a quarter'}],
}


def _meta(doc, key, default=None):
    md = getattr(doc, 'metadata', None)
    if md is None:
        return default
    value = getattr(md, key, None)
    if value is None and hasattr(md, 'model_extra') and md.model_extra:
        value = md.model_extra.get(key)
    return default if value is None else value


_PIECE_RE = re.compile(r'piece(\d{4})')


def _stream_index(doc) -> int | None:
    """Which audio stream of this run a transcriber document came from. The engine
    stamps every relayed stream with a running metadata.source.stream_index
    (0, 1, 2, ... per BEGIN); a piece name in the provenance is the fallback."""
    source = _meta(doc, 'source', None)
    if isinstance(source, dict):
        idx = source.get('stream_index')
        if isinstance(idx, int) and not isinstance(idx, bool):
            return idx
    for key in ('name', 'resource_name', 'parent'):
        m = _PIECE_RE.search(str(_meta(doc, key, '') or ''))
        if m:
            return int(m.group(1))
    return None


def _dump_metadata(doc) -> dict:
    md = getattr(doc, 'metadata', None)
    try:
        return md.model_dump(exclude_none=True) if md is not None else {}
    except Exception:  # noqa: BLE001
        return {'repr': repr(md)[:400]}


def build_question(chunk: list[dict], index: int, total: int, goal: str, per_chunk: int, min_s: int, max_s: int) -> Question:
    q = Question(type=QuestionType.QUESTION, role=ROLE)
    q.addInstruction(
        'Selection',
        f'Pick self-contained moments of {min_s}-{max_s} seconds: a strong hook in the first sentence, a '
        'complete thought at the end, understandable without the rest of the episode. Skip greetings, '
        'housekeeping, sponsor reads and inside jokes that need context. Candidates must not overlap.',
    )
    q.addInstruction(
        'Direction',
        "Follow the producer's direction for topic, tone, audience and platform. Only use what is actually "
        'said — never invent or paraphrase quotes.',
    )
    q.addInstruction(
        'Timestamps',
        "Every transcript line starts with [start - end]. Copy a line's start time as the clip start and a "
        "line's end time as the clip end, exactly as written (mm:ss or h:mm:ss).",
    )
    q.addInstruction(
        'Scoring',
        'Score each candidate 1-10 on three axes: hook (would the first three seconds stop a scroll?), '
        'clarity (is the point easy to follow with no visuals?), standalone (does it work with zero episode '
        "context?). Write 'reason' as one or two plain sentences a producer can act on.",
    )
    q.addInstruction(
        'Chapters',
        'Also list the topical chapters that begin inside this part: the start time of the line where the '
        'topic changes and a short title.',
    )
    q.addInstruction(
        'Format',
        'Respond with JSON only: {"chunk": n, "candidates": [...], "chapters": [...]}. Each candidate has '
        'start, end, title (max 10 words), hook (one caption line, max 12 words), reason, quote (the first '
        'sentence, verbatim) and scores {hook, clarity, standalone}. If nothing here is worth clipping, '
        'return an empty candidates list.',
    )
    if goal:
        q.addGoal(f'Producer direction: {goal}')
    q.addExample('Pick clips from one part of a transcript', EXAMPLE_ANSWER)
    first, last = chunk[0]['start_ms'], chunk[-1]['end_ms']
    q.addContext(
        f'Part {index + 1} of {total} of the episode, covering {fmt_timestamp(first)} to {fmt_timestamp(last)}.\n\n'
        f'Transcript:\n{sentence_lines(chunk)}'
    )
    q.addQuestion(f'Propose up to {per_chunk} candidate clips from part {index + 1} of {total}, best first.')
    q.expectJson = True
    return q


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        pass

    def open(self, obj: Entry):
        self._ref = None
        self._sentences: list[dict] = []      # this run's sentences (absolute times once the ref is known)
        self._prior: list[dict] = []          # sentences recovered from an earlier, interrupted run
        self._prior_done: set[int] = set()
        self._calls = 0
        self._sample_metadata = None
        self._t0 = time.time()

    # ------------------------------------------------------------------ inputs

    def writeText(self, text: str):
        ref = media_reference(text)
        if not ref or not ref_project(ref):
            return
        self._ref = ref
        if ref.get('skipped'):
            self._load_prior()
        for s in self._sentences:
            self._place(s)

    def writeDocuments(self, documents):
        # the transcriber emits one writeDocuments per audio piece it was fed, in order
        call_index = self._calls
        self._calls += 1
        for doc in documents or []:
            if self._sample_metadata is None:
                self._sample_metadata = _dump_metadata(doc)
            text = (getattr(doc, 'page_content', '') or '').strip()
            if not text:
                continue
            idx = _stream_index(doc)
            sentence = {'text': text,
                        'in_piece_ms': int(float(_meta(doc, 'time_stamp', 0.0)) * 1000),
                        'stream': idx if idx is not None else call_index,
                        'chunk': _meta(doc, 'chunkId', len(self._sentences))}
            self._place(sentence)
            self._sentences.append(sentence)
        self._persist_partial()

    # ---------------------------------------------------------------- helpers

    def _place(self, s: dict) -> None:
        """Absolute time = exact offset of the streamed piece (from media_io) + in-piece time."""
        offsets, indices, piece_ms = piece_offsets(self._ref)
        k = int(s['stream'])
        s['piece'] = indices[k] if k < len(indices) else k
        offset = offsets[k] if k < len(offsets) else s['piece'] * piece_ms
        s['start_ms'] = offset + s['in_piece_ms']

    def _load_prior(self) -> None:
        store = get_store()
        if store is None or not self._ref:
            return
        project = Project(ref_project(self._ref))
        partial = read_json_or(store, project.analysis(PARTIAL_TRANSCRIPT), None)
        if (not isinstance(partial, dict) or partial.get('source') != self._ref.get('source')
                or int(partial.get('piece_seconds') or 0) != int(self._ref.get('piece_seconds') or 0)):
            return
        self._prior_done = {int(i) for i in partial.get('pieces_done') or []}
        self._prior = [s for s in partial.get('sentences') or [] if int(s.get('piece', -1)) in self._prior_done]
        debug(f'{NODE}: resuming with {len(self._prior)} sentences from {len(self._prior_done)} transcribed pieces')

    def _persist_partial(self) -> None:
        """Best effort: keep the transcript so far in the store so an interrupted run can resume."""
        store = get_store()
        if store is None or not self._ref:
            return
        try:
            project = Project(ref_project(self._ref))
            pieces = pieces_block(self._ref)
            done = sorted(self._prior_done | {int(s['piece']) for s in self._sentences})
            sentences = sorted(self._prior + self._sentences, key=lambda s: s['start_ms'])
            write_json(store, project.analysis(PARTIAL_TRANSCRIPT),
                       {'schema_version': 1, 'source': self._ref.get('source'), 'piece_seconds': pieces.get('seconds'),
                        'pieces_total': pieces.get('total'), 'pieces_done': done, 'complete': False,
                        'updated': time.time(), 'sentences': sentences})
        except Exception as exc:  # noqa: BLE001
            debug(f'{NODE}: could not persist the partial transcript: {exc}')

    # ------------------------------------------------------------------ close

    def closing(self):
        store = get_store()
        pipe = getattr(self.instance, 'pipeId', None)
        if not self._ref or not ref_project(self._ref) or store is None:
            warning(f'{NODE}: no media reference / store — nothing to segment')
            return
        project = Project(ref_project(self._ref))
        try:
            self._process(store, project, pipe)
        except Exception as exc:  # noqa: BLE001
            update_status(store, project, NODE, 'error', pipe, message=str(exc))
            raise

    def _process(self, store, project: Project, pipe):
        cfg = self.IGlobal.config
        # the app record lives here, not in the reference: media_io is generic and
        # knows nothing about a project, so the settings come from project.json and
        # the recording's numbers are recorded there on the way through.
        data = load_project(store, project)
        settings = data.get('settings') or {}
        media = self._ref.get('media') or data.get('media') or {}
        pieces = pieces_block(self._ref)
        duration_ms = int(media.get('duration_ms') or 0)

        for s in self._sentences:
            self._place(s)
        sentences = sorted(self._prior + self._sentences, key=lambda s: (s['start_ms'], s.get('chunk', 0)))
        transcribed_now = bool(self._sentences) or bool(self._prior)
        if transcribed_now:
            # the stock transcriber only reports starts: a sentence ends where the next begins
            for i, s in enumerate(sentences):
                nxt = sentences[i + 1]['start_ms'] if i + 1 < len(sentences) else (duration_ms or s['start_ms'] + 5000)
                s['end_ms'] = max(nxt, s['start_ms'] + 500)
                s['id'] = i
            done = sorted(self._prior_done | {int(s['piece']) for s in self._sentences})
            write_json(store, project.analysis('transcript.json'),
                       {'schema_version': 1, 'source': self._ref.get('source'), 'granularity': 'sentence',
                        'duration_ms': duration_ms, 'pieces': pieces, 'pieces_done': done, 'sentences': sentences})
            write_json(store, project.analysis(PARTIAL_TRANSCRIPT),
                       {'schema_version': 1, 'source': self._ref.get('source'), 'piece_seconds': pieces.get('seconds'),
                        'pieces_total': pieces.get('total'), 'pieces_done': list(range(int(pieces.get('total') or 0))) or done,
                        'complete': True, 'updated': time.time(), 'sentences': sentences})
        else:
            # no transcriber in this pipe (transcript-index): reuse the analysis transcript
            transcript = read_json_or(store, project.analysis('transcript.json'), {}) or {}
            sentences = transcript.get('sentences') or []
            duration_ms = duration_ms or int(transcript.get('duration_ms') or 0)
            if not sentences:
                raise ValueError(f'{NODE}: no transcript for {project.root} — run the episode analysis first')
            debug(f'{NODE}: reusing the stored transcript ({len(sentences)} sentences)')

        min_s = int(settings.get('min_seconds') or cfg['min_seconds'])
        max_s = int(settings.get('max_seconds') or cfg['max_seconds'])
        want = int(settings.get('clip_count') or 10)
        # the producer's direction: what project.json recorded, else the question
        # media_io was asked (echoed in the reference)
        goal = str(settings.get('goal') or self._ref.get('question') or '').strip()
        chunks = chunk_sentences(sentences, int(cfg['chunk_minutes']) * 60_000, int(cfg['overlap_seconds']) * 1000)
        # ask for enough proposals overall that refine can be picky
        per_part = min(8, max(int(cfg['per_chunk']), math.ceil(want * 1.5 / max(1, len(chunks)))))
        if transcribed_now:
            write_json(store, project.analysis('windows.json'),
                       {'schema_version': 1, 'chunk_minutes': cfg['chunk_minutes'], 'overlap_seconds': cfg['overlap_seconds'],
                        'per_part': per_part, 'document_calls': self._calls, 'resumed_sentences': len(self._prior),
                        'sample_metadata': self._sample_metadata,
                        'parts': [{'index': i, 'start_ms': c[0]['start_ms'], 'end_ms': c[-1]['end_ms'], 'sentences': len(c)}
                                  for i, c in enumerate(chunks)]})
            self._record_media(store, project, data, media, settings, goal)
            update_status(store, project, NODE, 'transcribed', pipe, sentences=len(sentences), parts=len(chunks),
                          duration_ms=duration_ms, resumed=len(self._prior), seconds=round(time.time() - self._t0, 1))

        if self.instance.hasListener('documents'):
            self._index(store, project, pipe, sentences)

        if self.instance.hasListener('questions'):
            for i, chunk in enumerate(chunks):
                update_status(store, project, NODE, 'scoring', pipe, part=i + 1, parts=len(chunks),
                              start_ms=chunk[0]['start_ms'], end_ms=chunk[-1]['end_ms'])
                self.instance.writeQuestions(build_question(chunk, i, len(chunks), goal, per_part, min_s, max_s))
        elif not self.instance.hasListener('documents'):
            warning(f'{NODE}: neither an LLM (questions) nor an index (documents) is wired to this node')

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps({**self._ref, **project.to_ref(),
                                                'transcript': {'sentences': len(sentences), 'parts': len(chunks)}}))

    @staticmethod
    def _record_media(store, project: Project, data: dict, media: dict, settings: dict, goal: str) -> None:
        """
        project.json keeps the recording's numbers (every later node reads them
        there) and the fact that an analysis is under way — media_io is generic
        and writes neither.
        """
        try:
            if media:
                data['media'] = {k: media.get(k) for k in ('duration_ms', 'width', 'height', 'fps', 'has_video')}
            if goal and not (settings or {}).get('goal'):
                data.setdefault('settings', {})['goal'] = goal
            analysis = dict(data.get('analysis') or {})
            if analysis.get('status') != 'analyzing':
                analysis.update({'status': 'analyzing', 'started_at': analysis.get('started_at') or time.time()})
                data['analysis'] = analysis
            save_project(store, project, data)
        except Exception as exc:  # noqa: BLE001
            debug(f'{NODE}: could not record the media in project.json: {exc}')

    def _index(self, store, project: Project, pipe, sentences: list[dict]) -> None:
        """Passages for the semantic index; the stock embedding + store nodes downstream do the rest."""
        cfg = self.IGlobal.config
        window_ms = int(cfg.get('passage_seconds') or WINDOW_MS // 1000) * 1000
        step_ms = int(cfg.get('passage_step_seconds') or STEP_MS // 1000) * 1000
        passages = window_passages(sentences, window_ms, step_ms)
        update_status(store, project, NODE, 'indexing', pipe, passages=len(passages), window_seconds=window_ms // 1000)
        docs = passage_documents(passages, project.episode_id, project.root, NODE)
        if docs:
            self.instance.writeDocuments(docs)
        write_json(store, project.analysis('index.json'),
                   {'schema_version': 1, 'episode_id': project.episode_id, 'passages': len(passages),
                    'window_ms': window_ms, 'step_ms': step_ms, 'embedding_model': EMBED_MODEL_HINT,
                    'requested_at': time.time(),
                    'items': [{k: p[k] for k in ('index', 'start_ms', 'end_ms', 'sentence_ids')} for p in passages]})
        try:
            data = load_project(store, project)
            data['index'] = {'status': 'indexed', 'passages': len(passages), 'indexed_at': time.time()}
            save_project(store, project, data)
        except Exception as exc:  # noqa: BLE001
            debug(f'{NODE}: could not record the index in project.json: {exc}')
        update_status(store, project, NODE, 'indexed', pipe, passages=len(passages))
