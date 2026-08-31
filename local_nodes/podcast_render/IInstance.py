"""
podcast_render — renders a prepared clip spec into preview or export files.

The spec (text lane JSON from podcast_prepare_clip) carries the source path,
the snapped boundaries, the keep segments and the aligned words; this node
only does media work: audio clean-up + mastering, the cut/reframe/caption
video graph, sidecars, thumbnail, a report, and the project's clip registry.
"""

from __future__ import annotations
import json
import shutil
import tempfile
import time
from pathlib import Path

from rocketlib import IInstanceBase, Entry, warning
from ai.common.schema import Answer

from local_nodes.podcast_common.store import get_store, write_file, write_json
from local_nodes.podcast_common.project import Project, load_project, read_json_or, save_project, update_status
from local_nodes.podcast_common.cache import local_source
from local_nodes.podcast_common.config import as_bool
from local_nodes.podcast_common.media import (
    LAYOUTS,
    dims,
    measure_loudness,
    probe,
    render_audio,
    render_clip_video,
    render_layout_video,
    slice_audio,
    thumbnail,
)
from local_nodes.podcast_common.clips import TimelineMap, map_words_to_output
from local_nodes.podcast_common.captions import build_ass, build_srt, build_vtt, group_words, seam_placement

from .IGlobal import IGlobal

NODE = 'podcast_render'


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        pass

    def open(self, obj: Entry):
        self._spec = None
        self._t0 = time.time()

    def writeText(self, text: str):
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            return
        if isinstance(data, dict) and data.get('clip_id') and data.get('project'):
            self._spec = data

    def closing(self):
        store = get_store()
        if not self._spec or store is None:
            warning(f'{NODE}: no clip spec received')
            self._emit({'error': 'podcast_render received no clip spec'})
            return
        pipe = getattr(self.instance, 'pipeId', None)
        project = Project(self._spec['project'])
        try:
            manifest = self._render(store, project, pipe)
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: {exc}')
            update_status(store, project, NODE, 'error', pipe, clip=self._spec.get('clip_id'), message=str(exc))
            manifest = {**project.to_ref(), 'clip_id': self._spec.get('clip_id'), 'error': str(exc)}
        self._emit(manifest)

    def _render(self, store, project: Project, pipe) -> dict:
        cfg = self.IGlobal.config
        spec = self._spec
        mode = 'export' if str(cfg['mode']).lower() == 'export' else 'preview'
        clip_id = str(spec['clip_id'])
        options = spec.get('options') or {}
        wanted = str(options.get('layouts') or cfg['layouts'])
        layouts = [l.strip() for l in wanted.split(',') if l.strip() in LAYOUTS] or ['vertical']
        preset = str(options.get('caption_preset') or 'classic')
        captions_on = as_bool(options.get('captions'), True) and preset != 'off' and bool(cfg['captions'])
        has_video = bool((spec.get('media') or {}).get('has_video', True))
        start, end = int(spec['start_ms']), int(spec['end_ms'])
        keep = [(int(s), int(e)) for s, e in (spec.get('keep') or [[0, end - start]])]
        mutes = [(int(s), int(e)) for s, e in (spec.get('mutes') or [])]
        # phase 2: the layout plan (podcast_layout) drives the vertical render when it reframes anything
        plan_layout = spec.get('layout') if isinstance(spec.get('layout'), dict) else None
        reframes = bool(plan_layout and any(s.get('layout') not in ('full_frame', 'original') for s in plan_layout.get('segments') or []))

        def out(name: str) -> str:
            return project.previews(name) if mode == 'preview' else project.exports(f'{clip_id}/{name}')

        update_status(store, project, NODE, 'rendering', pipe, clip=clip_id, mode=mode, layouts=layouts,
                      reframe=[s['layout'] for s in (plan_layout or {}).get('segments', [])] if reframes else None)
        local = local_source(store, spec['source'])
        work = Path(tempfile.mkdtemp(prefix='podcast_render_'))
        files: dict[str, str] = {}
        try:
            source_wav = slice_audio(local, start, end, work / 'source.wav')
            mastered = render_audio(source_wav, keep, work / 'mastered.wav', mutes_ms=mutes)
            timeline = TimelineMap(keep)
            groups = group_words(map_words_to_output(spec.get('words') or [], timeline))
            # caption placement follows the layout on the rendered timeline (stacked → the seam)
            placement = None
            if reframes:
                out_segments = []
                for s in plan_layout['segments']:
                    a = timeline.to_output(int(s['start_ms']))
                    b = timeline.to_output(int(s['end_ms']) - 1)
                    if a is None or b is None:
                        continue
                    out_segments.append({'start_ms': a, 'end_ms': b + 1, 'layout': s['layout']})
                placement = seam_placement(out_segments)

            first_media = None
            if has_video:
                for layout in layouts:
                    ass_path = None
                    if captions_on and groups:
                        ass_path = work / f'captions_{layout}.ass'
                        ass_path.write_text(build_ass(groups, layout, preset, placement=placement if layout == 'vertical' else None), encoding='utf-8')
                    update_status(store, project, NODE, 'encoding', pipe, clip=clip_id, mode=mode, layout=layout)
                    if layout == 'vertical' and reframes:
                        canvas_w, canvas_h = dims('vertical', int(cfg['size']))
                        plan_layout['canvas'] = {'width': canvas_w, 'height': canvas_h}
                        mp4 = render_layout_video(local, start, end, keep, plan_layout, mastered, work / f'{clip_id}_{layout}.mp4',
                                                  work, ass_path=ass_path, fps=int(cfg['fps']), crf=int(cfg['crf']),
                                                  preset=str(cfg['preset']))
                    else:
                        mp4 = render_clip_video(local, start, end, keep, mastered, work / f'{clip_id}_{layout}.mp4',
                                                layout=layout, size=int(cfg['size']), ass_path=ass_path,
                                                fps=int(cfg['fps']), crf=int(cfg['crf']), preset=str(cfg['preset']))
                    name = f'{clip_id}.mp4' if (mode == 'preview' and layout == layouts[0]) else f'{clip_id}_{layout}.mp4'
                    files[layout] = write_file(store, out(name), mp4)
                    first_media = first_media or mp4
            else:
                mp3 = slice_audio(mastered, 0, timeline.total_ms, work / f'{clip_id}.mp3')
                files['audio'] = write_file(store, out(f'{clip_id}.mp3'), mp3)
                first_media = mp3

            if bool(cfg['sidecars']) and groups:
                srt = work / f'{clip_id}.srt'
                srt.write_text(build_srt(groups), encoding='utf-8')
                files['srt'] = write_file(store, out(f'{clip_id}.srt'), srt)
                vtt = work / f'{clip_id}.vtt'
                vtt.write_text(build_vtt(groups), encoding='utf-8')
                files['vtt'] = write_file(store, out(f'{clip_id}.vtt'), vtt)
            if has_video and first_media is not None:
                thumb = thumbnail(first_media, work / f'{clip_id}.jpg', at_ms=min(1000, max(0, timeline.total_ms // 3)))
                files['thumbnail'] = write_file(store, out(f'{clip_id}.jpg'), thumb)

            check = probe(first_media)
            loudness = measure_loudness(first_media)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        seconds = round(time.time() - self._t0, 1)
        layout_summary = None
        if plan_layout:
            metrics = plan_layout.get('metrics') or {}
            layout_summary = {
                'mode': plan_layout.get('mode'),
                'subject_override': plan_layout.get('subject_override'),
                'applied': reframes,
                'segments': [{k: s.get(k) for k in ('start_ms', 'end_ms', 'layout', 'subjects', 'reason')} for s in plan_layout.get('segments') or []],
                'people': [{k: t.get(k) for k in ('id', 'coverage', 'first_ms', 'last_ms', 'mean_center', 'mean_face_h')} for t in plan_layout.get('tracks') or []],
                'thumbnails': plan_layout.get('thumbnails') or {},
                'speaking': plan_layout.get('speaking') or [],
                'metrics': metrics,
                'method': plan_layout.get('method'),
                'error': plan_layout.get('error'),
            }
        # the compliance record gets the measured duration of the finished file (+ the visual verdicts)
        compliance = read_json_or(store, project.clip_compliance(clip_id), None)
        if isinstance(compliance, dict):
            if layout_summary:
                m = layout_summary['metrics']
                compliance['visual'] = {
                    'applied': reframes,
                    'people': m.get('people'),
                    'speaker_visible_pct': m.get('speaker_visible_pct'),
                    'face_cut_violations': m.get('face_cut_violations'),
                    'face_checks': m.get('face_checks'),
                    'smooth': m.get('smooth'),
                    'layout_changes': m.get('layout_changes'),
                    'layouts': sorted({s['layout'] for s in layout_summary['segments']}),
                }
                if m.get('face_checks') and m.get('face_cut_violations'):
                    compliance.setdefault('warnings', []).append(
                        f"{m['face_cut_violations']} of {m['face_checks']} sampled frames had a face touching the crop edge.")
            compliance['duration_final'] = round(check['duration_ms'] / 1000, 1)
            target = compliance.get('duration_requested')
            fit = spec.get('fit') or {}
            if target and fit.get('mode') in ('strict', 'maximum'):
                tol = int(fit.get('tolerance_ms') or 0)
                delta = check['duration_ms'] - int(round(float(target) * 1000))
                compliance['duration_met'] = (abs(delta) <= tol) if fit['mode'] == 'strict' else (delta <= tol)
            compliance['rendered_at'] = time.time()
            write_json(store, project.clip_compliance(clip_id), compliance)
        report = {
            'schema_version': 2,
            'clip_id': clip_id,
            'mode': mode,
            'title': spec.get('title'),
            'start_ms': start,
            'end_ms': end,
            'duration_ms': check['duration_ms'],
            'source_duration_ms': end - start,
            'files': files,
            'layouts': layouts,
            'captions': bool(captions_on and groups),
            'caption_preset': preset if captions_on else 'off',
            'caption_lines': len(groups),
            'cuts': len(keep) - 1,
            'muted': len(mutes),
            'has_audio': check['has_audio'],
            'has_video': check['has_video'],
            'width': check['width'],
            'height': check['height'],
            'loudness': loudness,
            'compliance': compliance if isinstance(compliance, dict) else None,
            'layout': layout_summary,
            'version': spec.get('version'),
            'rendered_at': time.time(),
            'seconds': seconds,
        }
        write_json(store, out(f'{clip_id}.json') if mode == 'preview' else out('report.json'), report)

        data = load_project(store, project)
        clips = data.setdefault('clips', {})
        entry = clips.setdefault(clip_id, {})
        entry.update({'title': spec.get('title'), 'start_ms': start, 'end_ms': end, 'candidate': spec.get('candidate'),
                      'request_id': spec.get('request_id'), 'version': spec.get('version')})
        entry[mode] = {'files': files, 'duration_ms': check['duration_ms'], 'rendered_at': report['rendered_at']}
        save_project(store, project, data)

        update_status(store, project, NODE, 'rendered', pipe, clip=clip_id, mode=mode, files=sorted(files), seconds=seconds)
        return {**project.to_ref(), **report}

    def _emit(self, payload: dict):
        answer = Answer(expectJson=True)
        answer.setAnswer(payload)
        if self.instance.hasListener('answers'):
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(payload))
