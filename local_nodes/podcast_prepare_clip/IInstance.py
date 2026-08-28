"""
podcast_prepare_clip — one chat question = one clip to prepare.

Context lines: 'project: projects/<episode>' plus either 'clip: <candidate id>'
or explicit 'start: <ms>' / 'end: <ms>' (both accepted together: explicit times
override the candidate and any saved edit). Optional: 'title:', 'captions: off',
'layouts: vertical,wide', 'tighten: off', 'fillers: off'.

Output (text lane): the clip spec JSON that podcast_render consumes, also
persisted at analysis/clips/<id>.json so the UI can show the word timeline.
"""

from __future__ import annotations
import json
import shutil
import tempfile
import time
from pathlib import Path

from rocketlib import IInstanceBase, Entry
from ai.common.schema import Question

from local_nodes.podcast_common.store import get_store, write_json
from local_nodes.podcast_common.project import Project, load_project, parse_context, question_text, read_json_or, update_status
from local_nodes.podcast_common.cache import local_source
from local_nodes.podcast_common.config import as_bool
from local_nodes.podcast_common.media import detect_silences, keep_segments, slice_audio
from local_nodes.podcast_common.align import align_words
from local_nodes.podcast_common.clips import filler_cuts, locate_span, parse_timestamp, snap_to_word_boundaries, words_in_range

from .IGlobal import IGlobal

NODE = 'podcast_prepare_clip'
MIN_CLIP_MS = 3000


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        pass

    def open(self, obj: Entry):
        self._entry = obj

    def writeQuestions(self, question: Question):
        store = get_store()
        if store is None:
            raise RuntimeError(f'{NODE}: no account file store available for this task')
        pipe = getattr(self.instance, 'pipeId', None)
        ctx = parse_context(question)
        if not ctx.get('project'):
            raise ValueError(f"{NODE}: add 'project: projects/<episode>' to the question context")
        project = Project(ctx['project'])
        try:
            spec = self._prepare(store, project, ctx, question_text(question), pipe)
        except Exception as exc:  # noqa: BLE001
            update_status(store, project, NODE, 'error', pipe, clip=ctx.get('clip'), message=str(exc))
            raise
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(spec))

    def _prepare(self, store, project: Project, ctx: dict, direction: str, pipe) -> dict:
        t0 = time.time()
        cfg = self.IGlobal.config
        data = load_project(store, project)
        source = data.get('source')
        if not source:
            raise ValueError(f'{NODE}: project.json has no source')
        media = data.get('media') or {}
        duration_ms = int(media.get('duration_ms') or 0)

        candidates = (read_json_or(store, project.analysis('candidates.json'), {}) or {}).get('candidates') or []
        clip_id = (ctx.get('clip') or '').strip()
        cand = next((c for c in candidates if c.get('id') == clip_id), None) or {}
        edits = {}
        if clip_id:
            edits = ((read_json_or(store, project.edits('clip-edits.json'), {}) or {}).get('clips') or {}).get(clip_id) or {}

        start = parse_timestamp(ctx.get('start'))
        end = parse_timestamp(ctx.get('end'))
        explicit = start is not None or end is not None or 'start_ms' in edits or 'end_ms' in edits
        if start is None:
            start = edits.get('start_ms', cand.get('start_ms'))
        if end is None:
            end = edits.get('end_ms', cand.get('end_ms'))
        if start is None or end is None:
            raise ValueError(f"{NODE}: unknown clip {clip_id!r} — give a candidate id or 'start:'/'end:' times")
        start, end = max(0, int(start)), int(end)
        if duration_ms:
            end = min(end, duration_ms)
        if end - start < MIN_CLIP_MS:
            raise ValueError(f'{NODE}: clip is shorter than {MIN_CLIP_MS // 1000} seconds')
        if not clip_id:
            clip_id = f'x{start // 1000}-{end // 1000}'

        title = ctx.get('title') or edits.get('title') or cand.get('title') or f'Clip {clip_id}'
        captions = as_bool(ctx.get('captions'), as_bool(edits.get('captions'), True))
        tighten = as_bool(ctx.get('tighten'), as_bool(edits.get('tighten_pauses'), cfg['tighten_pauses']))
        fillers = as_bool(ctx.get('fillers'), as_bool(edits.get('remove_fillers'), cfg['remove_fillers']))
        layouts = ctx.get('layouts') or edits.get('layouts') or ''

        update_status(store, project, NODE, 'preparing', pipe, clip=clip_id, start_ms=start, end_ms=end)
        local = local_source(store, source)
        work = Path(tempfile.mkdtemp(prefix='podcast_prepare_'))
        try:
            pad = int(float(cfg['pad_seconds']) * 1000)
            i0 = max(0, start - pad)
            i1 = min(duration_ms, end + pad) if duration_ms else end + pad
            wav = slice_audio(local, i0, i1, work / 'interval.wav')
            update_status(store, project, NODE, 'aligning', pipe, clip=clip_id, seconds=round((i1 - i0) / 1000, 1),
                          model=cfg['model'])
            aligned = align_words(wav, str(cfg['model']), str(cfg['language'] or '') or None, hint=cand.get('quote'))
            words = [{**w, 'start_ms': w['start_ms'] + i0, 'end_ms': w['end_ms'] + i0} for w in aligned['words']]

            # a candidate's own words beat the coarse sentence boundaries; explicit user
            # times (request or saved edit) are honoured as given, only word-snapped
            if not explicit and words:
                wanted = end - start
                if cand.get('text'):
                    span = locate_span(words, cand['text'])
                    if span and 0.5 * wanted <= span[1] - span[0] <= 1.5 * wanted:
                        start, end = span
                elif cand.get('quote'):
                    # only the opening sentence is known: fix the start, keep the end
                    span = locate_span(words, cand['quote'])
                    if span and abs(span[0] - start) <= 5000:
                        start = span[0]
            s_snap, e_snap = snap_to_word_boundaries(start, end, words) if words else (start, end)
            s_snap, e_snap = max(i0, s_snap), min(i1, e_snap)
            if e_snap - s_snap < MIN_CLIP_MS:
                s_snap, e_snap = start, end
            total = e_snap - s_snap
            clip_words = words_in_range(words, s_snap, e_snap)

            cuts: list[tuple[int, int]] = []
            if tighten:
                clip_wav = slice_audio(local, s_snap, e_snap, work / 'clip.wav')
                cuts.extend(detect_silences(clip_wav))
            if fillers:
                cuts.extend(filler_cuts(clip_words, total))
            keep = keep_segments(cuts, total)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        spec = {
            'schema_version': 1,
            **project.to_ref(),
            'source': source,
            'clip_id': clip_id,
            'candidate': cand.get('id'),
            'title': title,
            'hook': cand.get('hook') or '',
            'reason': cand.get('reason') or '',
            'scores': cand.get('scores') or {},
            'direction': direction,
            'requested': {'start_ms': start, 'end_ms': end},
            'start_ms': s_snap,
            'end_ms': e_snap,
            'duration_ms': total,
            'rendered_duration_ms': sum(e - s for s, e in keep),
            'words': clip_words,
            'transcript': ' '.join(w['word'] for w in clip_words),
            'language': aligned.get('language'),
            'keep': [list(k) for k in keep],
            'cuts': len(cuts),
            'options': {'captions': captions, 'tighten_pauses': tighten, 'remove_fillers': fillers, 'layouts': layouts},
            'media': media,
            'prepared_at': time.time(),
            'seconds': round(time.time() - t0, 1),
        }
        write_json(store, project.clip_spec(clip_id), spec)
        update_status(store, project, NODE, 'prepared', pipe, clip=clip_id, words=len(clip_words), cuts=len(cuts),
                      duration_ms=total, seconds=spec['seconds'])
        return spec
