"""
podcast_render — renders a prepared spec into preview or export files.

Two paths share this node:

* the clip path (spec with `clip_id`) — unchanged: audio clean-up + mastering,
  the cut/reframe/caption video graph, sidecars, thumbnail, report, registry.
* the studio path (spec with `studio`) — a whole edited episode: one full-length
  audio pass (cuts, mutes, bleeps, ducked music, two-pass mastering), the picture
  in resumable ~5 minute parts with burned captions and the logo, intro/outro and
  title/end cards concatenated around it, then MP3/WAV/SRT/VTT/chapters/report.
"""

from __future__ import annotations
import json
import shutil
import tempfile
import time
from pathlib import Path

from rocketlib import IInstanceBase, Entry, warning
from ai.common.schema import Answer

from local_nodes.podcast_common.store import download_to, exists, get_store, write_file, write_json
from local_nodes.podcast_common.project import Project, load_project, read_json_or, save_project, update_status
from local_nodes.podcast_common.cache import local_source
from local_nodes.podcast_common.config import as_bool
from local_nodes.podcast_common.media import (
    CAPTION_STYLE_PRESETS,
    EPISODE_PART_MS,
    LAYOUTS,
    aspect_dims,
    assemble_episode_audio,
    capped_dims,
    caption_layout_for,
    chapters_payload,
    colour_dialogue,
    concat_parts,
    dims,
    conform_audio,
    encode_audio_deliverable,
    ffmetadata_chapters,
    measure_loudness,
    mux_episode,
    plan_episode_parts,
    probe,
    range_to_keep,
    render_asset_part,
    render_audio,
    render_card,
    render_clip_video,
    render_episode_audio,
    render_episode_part,
    render_layout_video,
    restyle_ass,
    shift_groups,
    slice_audio,
    spec_hash,
    thumbnail,
    transcode_aspect,
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
        self._studio = None
        self._t0 = time.time()

    def writeText(self, text: str):
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            return
        # the studio spec carries clip_id too (older engines' guards expect it),
        # so the studio check must come first or the clip path claims the episode
        if isinstance(data, dict) and data.get('project') and data.get('studio') and data.get('keep') is not None:
            self._studio = data
        elif isinstance(data, dict) and data.get('clip_id') and data.get('project'):
            self._spec = data

    def closing(self):
        store = get_store()
        if self._studio and not self._spec and store is not None:
            self._close_studio(store)
            return
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

    # ------------------------------------------------------------------ studio
    #
    # The episode path. The spec (analysis/studio/prepared-v<n>.json, forwarded on
    # the text lane) carries the keep list, the mutes/bleeps, the output-timeline
    # captions and chapters, the verified assets and the audio/visual settings.

    def _close_studio(self, store):
        pipe = getattr(self.instance, 'pipeId', None)
        project = Project(self._studio['project'])
        try:
            report = self._render_studio(store, project, pipe)
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: studio: {exc}')
            update_status(store, project, NODE, 'error', pipe, mode='studio',
                          version=self._studio.get('version'), message=str(exc))
            report = {**project.to_ref(), 'kind': 'studio', 'studio': self._studio.get('studio'),
                      'version': self._studio.get('version'), 'error': str(exc)}
        self._emit(report)

    def _render_studio(self, store, project: Project, pipe) -> dict:
        cfg = self.IGlobal.config
        spec = self._studio
        # the spec carries the mode twice for tolerance: `studio` may be a bare
        # true marker (the prepare node's shape) with the mode in `mode`
        mode = 'export' if 'export' in (str(spec.get('studio') or '').lower(), str(spec.get('mode') or '').lower()) else 'preview'
        version = int(spec.get('version') or 1)
        quality = str(spec.get('quality') or ('full' if mode == 'export' else 'rough')).lower()
        rng = spec.get('range') if isinstance(spec.get('range'), (list, tuple)) and len(spec.get('range')) == 2 else None
        visual = spec.get('visual') or {}
        audio_cfg = spec.get('audio') or {}
        assets = spec.get('assets') or {}
        media = spec.get('media') or {}
        has_video = bool(media.get('has_video', True))
        aspect = str(visual.get('aspect_ratio') or '16:9')
        fit = str(visual.get('fit') or 'fit')
        background = visual.get('background') or 'blur'
        warnings_out: list[str] = list(spec.get('warnings') or [])

        full_keep = [(int(s), int(e)) for s, e in (spec.get('keep') or []) if int(e) > int(s)]
        if not full_keep:
            raise ValueError('the prepared spec has no keep segments')
        mutes = [(int(s), int(e)) for s, e in (spec.get('mutes') or []) if int(e) > int(s)]
        bleeps = [(int(s), int(e)) for s, e in (spec.get('bleeps') or []) if int(e) > int(s)]
        map_rows = spec.get('map') or _map_from_keep(full_keep)
        groups, style, speaker_colors, preset = _studio_captions(spec)

        # a range preview renders only the source slices behind an output window
        offset_ms = 0
        keep = full_keep
        if mode == 'preview' and rng:
            offset_ms = max(0, int(rng[0]))
            keep = [(int(s), int(e)) for s, e in range_to_keep(map_rows, offset_ms, int(rng[1])) if e > s]
            if not keep:
                raise ValueError('the requested range falls entirely inside a cut')
        body_ms = sum(e - s for s, e in keep)

        source_fps = float(media.get('fps') or 0) or 30.0
        if mode == 'export':
            out_w, out_h = aspect_dims(aspect, 1080)
            fps, crf, x264 = min(30, int(round(source_fps))) or 30, 20, 'veryfast'
            channels, master = 2, bool(audio_cfg.get('master', True))
            clean = (bool(audio_cfg.get('noise_reduction', True)), bool(audio_cfg.get('high_pass', True)),
                     bool(audio_cfg.get('compression', True)))
        elif rng:
            cap = min(1280, int(media.get('width') or 1280) or 1280)
            out_w, out_h = capped_dims(aspect, max(640, cap))
            fps, crf, x264 = min(30, int(round(source_fps))) or 30, 23, str(cfg['preset'])
            channels, master = 2, bool(audio_cfg.get('master', True))
            clean = (bool(audio_cfg.get('noise_reduction', True)), bool(audio_cfg.get('high_pass', True)),
                     bool(audio_cfg.get('compression', True)))
        else:                                  # the rough whole-episode pass
            out_w, out_h = capped_dims(aspect, 640)
            fps, crf, x264 = 15, 32, 'ultrafast'
            channels, master = 1, False
            clean = (False, bool(audio_cfg.get('high_pass', True)), False)
        captions_on = bool(visual.get('captions', True)) and bool(groups) and bool(cfg['captions'])

        work = Path(tempfile.mkdtemp(prefix='podcast_studio_'))
        files: dict[str, str] = {}
        part_times: list[dict] = []
        try:
            local = local_source(store, spec['source'])
            logo_cfg = assets.get('logo') if isinstance(assets.get('logo'), dict) else None
            logo_path = self._studio_asset(store, logo_cfg, 'logo', warnings_out)
            music_cfg = assets.get('music') if isinstance(assets.get('music'), dict) else None
            music_path = self._studio_asset(store, music_cfg, 'music', warnings_out) if mode != 'preview' or rng else None
            hashed = spec_hash(spec)
            export_dir = f'studio/v{version}'

            # ---- picture: resumable ~5 minute parts, each with its own captions
            video_files: list[Path] = []
            audio_pieces: list[dict] = []
            lead_ms = tail_ms = 0
            if has_video:
                intro = self._studio_asset(store, assets.get('intro'), 'intro', warnings_out) if mode == 'export' else None
                outro = self._studio_asset(store, assets.get('outro'), 'outro', warnings_out) if mode == 'export' else None
                title_card = assets.get('title_card') if (mode == 'export' and isinstance(assets.get('title_card'), dict)) else None
                end_card = assets.get('end_card') if (mode == 'export' and isinstance(assets.get('end_card'), dict)) else None

                if intro:
                    part = render_asset_part(intro, work / 'lead-intro.mp4', out_w, out_h, fps=fps, crf=crf,
                                             preset=x264, fit=fit, background=background)
                    length = int(probe(part)['duration_ms'])
                    video_files.append(part)
                    audio_pieces.append(self._asset_audio(intro, work / 'lead-intro.wav', length, warnings_out))
                    lead_ms += length
                if title_card:
                    seconds = float(title_card.get('seconds') or 3)
                    part = render_card(title_card.get('text') or spec.get('title') or '', title_card.get('subtitle') or '',
                                       seconds, work / 'lead-title.mp4', out_w, out_h, fps=fps, crf=crf, preset=x264)
                    length = int(probe(part)['duration_ms'])
                    video_files.append(part)
                    audio_pieces.append({'silence_ms': length})
                    lead_ms += length

                parts = plan_episode_parts(keep, EPISODE_PART_MS)
                done, manifest = self._studio_manifest(store, project, export_dir, hashed, parts, mode)
                for part in parts:
                    started = time.time()
                    update_status(store, project, NODE, 'rendering', pipe, mode='studio', quality=quality,
                                  version=version, part=part['n'], parts=len(parts))
                    local_part = work / f"part-{part['n']:03d}.mp4"
                    reused = False
                    store_path = project.exports(f"{export_dir}/parts/part-{part['n']:03d}.mp4")
                    if mode == 'export' and part['n'] in done and exists(store, store_path):
                        try:
                            download_to(store, store_path, local_part)
                            reused = True
                        except Exception:  # noqa: BLE001
                            reused = False
                    if not reused:
                        ass = None
                        if captions_on:
                            window = shift_groups(groups, offset_ms + part['out_start_ms'], part['duration_ms'])
                            ass = self._studio_ass(work / f"part-{part['n']:03d}.ass", window, out_w, out_h,
                                                   preset, style, speaker_colors)
                        render_episode_part(local, [(s, e) for s, e in part['keep']], local_part, out_w, out_h,
                                            fps=fps, crf=crf, preset=x264, fit=fit, background=background,
                                            ass_path=ass, logo=logo_cfg, logo_path=logo_path)
                        if mode == 'export':
                            write_file(store, store_path, local_part)
                            manifest = self._studio_mark_done(store, project, export_dir, manifest, part['n'])
                    video_files.append(local_part)
                    part_times.append({'n': part['n'], 'duration_ms': part['duration_ms'],
                                       'seconds': round(time.time() - started, 1), 'reused': reused})

                audio_pieces.append({'path': None})            # placeholder for the mastered body
                if end_card:
                    seconds = float(end_card.get('seconds') or 3)
                    part = render_card(end_card.get('text') or '', end_card.get('subtitle') or '', seconds,
                                       work / 'tail-end.mp4', out_w, out_h, fps=fps, crf=crf, preset=x264)
                    length = int(probe(part)['duration_ms'])
                    video_files.append(part)
                    audio_pieces.append({'silence_ms': length})
                    tail_ms += length
                if outro:
                    part = render_asset_part(outro, work / 'tail-outro.mp4', out_w, out_h, fps=fps, crf=crf,
                                             preset=x264, fit=fit, background=background)
                    length = int(probe(part)['duration_ms'])
                    video_files.append(part)
                    audio_pieces.append(self._asset_audio(outro, work / 'tail-outro.wav', length, warnings_out))
                    tail_ms += length
            else:
                audio_pieces.append({'path': None})

            # ---- sound: one full-length pass so the two-pass loudness is correct
            update_status(store, project, NODE, 'mastering', pipe, mode='studio', quality=quality, version=version,
                          master=master)
            body_wav = render_episode_audio(
                local, keep, work / 'body.wav', mutes=mutes, bleeps=bleeps,
                noise_reduction=clean[0], high_pass=clean[1], compression=clean[2],
                music_path=music_path, music=music_cfg, master=master,
                loudness_lufs=float(audio_cfg.get('loudness_lufs') or -16), channels=channels,
            )
            for piece in audio_pieces:
                if piece.get('path') is None and 'silence_ms' not in piece:
                    piece['path'] = str(body_wav)
            final_wav = assemble_episode_audio(audio_pieces, work / 'episode-audio.wav', channels=channels)

            # ---- join + mux
            if has_video:
                joined = concat_parts(video_files, work / 'video.mp4', work)
                final = mux_episode(joined, final_wav, work / 'episode.mp4')
            else:
                final = encode_audio_deliverable(final_wav, work / 'episode.mp3')

            check = probe(final)
            loudness = measure_loudness(final)
            total_ms = lead_ms + body_ms + tail_ms
            extras = [a for a in (spec.get('extra_aspects') or visual.get('extra_aspects') or []) if str(a) != aspect]

            if mode == 'export':
                out_name = 'episode.mp4' if has_video else 'episode-audio.mp3'
                files['episode'] = write_file(store, project.exports(f'{export_dir}/{out_name}'), final)
                if has_video:
                    for extra in extras:
                        ew, eh = aspect_dims(extra, 1080)
                        alt = transcode_aspect(final, work / f"episode-{str(extra).replace(':', 'x')}.mp4", ew, eh,
                                               fps=fps, crf=crf, preset=x264, fit=fit, background=background)
                        files[f"episode_{str(extra).replace(':', 'x')}"] = write_file(
                            store, project.exports(f"{export_dir}/episode-{str(extra).replace(':', 'x')}.mp4"), alt)
                files['mp3'] = write_file(store, project.exports(f'{export_dir}/episode.mp3'),
                                          encode_audio_deliverable(final_wav, work / 'episode.mp3'))
                files['wav'] = write_file(store, project.exports(f'{export_dir}/episode.wav'),
                                          encode_audio_deliverable(final_wav, work / 'episode.wav'))
                shifted = shift_groups(groups, -lead_ms) if lead_ms else groups
                if shifted:
                    srt = work / 'captions.srt'
                    srt.write_text(build_srt(shifted), encoding='utf-8')
                    files['srt'] = write_file(store, project.exports(f'{export_dir}/captions.srt'), srt)
                    vtt = work / 'captions.vtt'
                    vtt.write_text(build_vtt(shifted), encoding='utf-8')
                    files['vtt'] = write_file(store, project.exports(f'{export_dir}/captions.vtt'), vtt)
                chapters = [{'title': c.get('title'), 'out_ms': int(c.get('out_ms') or 0) + lead_ms}
                            for c in (spec.get('chapters') or [])]
                if chapters:
                    meta = work / 'chapters.txt'
                    meta.write_text(ffmetadata_chapters(chapters, total_ms, spec.get('title')), encoding='utf-8')
                    files['chapters_txt'] = write_file(store, project.exports(f'{export_dir}/chapters.txt'), meta)
                    write_json(store, project.exports(f'{export_dir}/chapters.json'),
                               chapters_payload(chapters, total_ms))
                    files['chapters_json'] = project.exports(f'{export_dir}/chapters.json')
            else:
                name = f"range-v{version}" if rng else f"rough-v{version}"
                suffix = 'mp4' if has_video else 'mp3'
                files['preview'] = write_file(store, project.previews(f'studio/{name}.{suffix}'), final)
                chapters = []
        finally:
            shutil.rmtree(work, ignore_errors=True)

        delta = check['duration_ms'] - total_ms
        seconds = round(time.time() - self._t0, 1)
        report = {
            'schema_version': 1,
            'kind': 'studio',
            'mode': mode,
            'quality': quality,
            'version': version,
            'title': spec.get('title'),
            'range': [int(rng[0]), int(rng[1])] if rng else None,
            'duration_ms': check['duration_ms'],
            'output_duration_ms': total_ms,
            'body_duration_ms': body_ms,
            'lead_ms': lead_ms,
            'tail_ms': tail_ms,
            'files': files,
            'aspect_ratio': aspect,
            'extra_aspects': extras if mode == 'export' else [],
            'width': check['width'],
            'height': check['height'],
            'fps': fps,
            'cuts': max(0, len(full_keep) - 1),
            'muted': len(mutes),
            'bleeped': len(bleeps),
            'captions': bool(captions_on),
            'caption_lines': len(groups) if captions_on else 0,
            'chapters': len(chapters),
            'mastered': bool(master),
            'music': bool(music_path),
            'loudness': loudness,
            'loudness_target_lufs': float(audio_cfg.get('loudness_lufs') or -16) if master else None,
            'parts': part_times,
            'spec_hash': hashed,
            'warnings': warnings_out,
            'validation': {
                'expected_duration_ms': total_ms,
                'duration_ms': check['duration_ms'],
                'delta_ms': delta,
                'duration_ok': abs(delta) <= 500,
                'has_video': check['has_video'],
                'has_audio': check['has_audio'],
                'streams_ok': bool(check['has_audio'] and (check['has_video'] or not has_video)),
            },
            'rendered_at': time.time(),
            'seconds': seconds,
        }
        if not report['validation']['duration_ok']:
            warnings_out.append(f'The finished file is {delta / 1000:.1f}s off the planned length.')
        if mode == 'export':
            write_json(store, project.exports(f'{export_dir}/report.json'), report)
            try:
                data = load_project(store, project)
                studio = data.setdefault('studio', {})
                studio[str(version)] = {'files': files, 'duration_ms': check['duration_ms'],
                                        'rendered_at': report['rendered_at']}
                save_project(store, project, data)
            except Exception as exc:  # noqa: BLE001
                warning(f'{NODE}: studio registry: {exc}')
        else:
            write_json(store, project.previews(f"studio/{'range' if rng else 'rough'}-v{version}.json"), report)

        update_status(store, project, NODE, 'rendered', pipe, mode='studio', quality=quality, version=version,
                      files=sorted(files), seconds=seconds)
        return {**project.to_ref(), **report}

    # ---------------------------------------------------------------- helpers

    def _studio_asset(self, store, asset, kind: str, warnings_out: list[str]):
        """Cache one verified asset locally; a missing file is a warning, not a failure."""
        path = None
        if isinstance(asset, dict):
            path = asset.get('path')
        elif isinstance(asset, str):
            path = asset
        if not path:
            return None
        try:
            return local_source(store, path)
        except Exception as exc:  # noqa: BLE001
            warnings_out.append(f'The {kind} file could not be read and was skipped.')
            warning(f'{NODE}: studio asset {kind}: {exc}')
            return None

    def _asset_audio(self, asset_path, out_wav: Path, length_ms: int, warnings_out: list[str]) -> dict:
        try:
            return {'path': str(conform_audio(asset_path, out_wav, length_ms))}
        except Exception:  # noqa: BLE001
            warnings_out.append('One of the added clips had no sound; it plays silent.')
            return {'silence_ms': length_ms}

    def _studio_ass(self, path: Path, groups: list, out_w: int, out_h: int, preset: str,
                    style: dict, speaker_colors: dict):
        if not groups:
            return None
        text = build_ass(groups, caption_layout_for(out_w, out_h), preset)
        text = restyle_ass(text, style)
        if style.get('per_speaker_colors') and speaker_colors:
            text = colour_dialogue(text, [speaker_colors.get((g[0] or {}).get('speaker')) for g in groups])
        path.write_text(text, encoding='utf-8')
        return path

    def _studio_manifest(self, store, project: Project, export_dir: str, hashed: str, parts: list[dict], mode: str):
        """parts/manifest.json — which parts of THIS spec are already finished."""
        if mode != 'export':
            return set(), None
        path = project.exports(f'{export_dir}/parts/manifest.json')
        existing = read_json_or(store, path, None)
        done: set[int] = set()
        if isinstance(existing, dict) and existing.get('spec_hash') == hashed:
            done = {int(p['n']) for p in existing.get('parts') or [] if p.get('done')}
        manifest = {'schema_version': 1, 'spec_hash': hashed, 'updated': time.time(),
                    'parts': [{'n': p['n'], 'keep_slice': p['keep'], 'out_start_ms': p['out_start_ms'],
                               'out_end_ms': p['out_end_ms'], 'done': p['n'] in done} for p in parts]}
        write_json(store, path, manifest)
        return done, manifest

    def _studio_mark_done(self, store, project: Project, export_dir: str, manifest, n: int):
        if not isinstance(manifest, dict):
            return manifest
        for entry in manifest.get('parts') or []:
            if int(entry['n']) == int(n):
                entry['done'] = True
        manifest['updated'] = time.time()
        write_json(store, project.exports(f'{export_dir}/parts/manifest.json'), manifest)
        return manifest

    def _emit(self, payload: dict):
        answer = Answer(expectJson=True)
        answer.setAnswer(payload)
        if self.instance.hasListener('answers'):
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(payload))


def _map_from_keep(keep: list[tuple[int, int]]) -> list[list[int]]:
    """The spec's map, rebuilt from the keep list when an older spec omits it."""
    rows, out = [], 0
    for start, end in keep:
        rows.append([start, end, out])
        out += end - start
    return rows


def _norm_words(items) -> list[dict]:
    """Words in either the spec's short form ({w,s,e}) or the caption form."""
    words = []
    for w in items or []:
        if not isinstance(w, dict):
            continue
        word = w.get('word', w.get('w'))
        start, end = w.get('start_ms', w.get('s')), w.get('end_ms', w.get('e'))
        if word is None or start is None or end is None:
            continue
        words.append({'word': str(word), 'start_ms': int(start), 'end_ms': int(end), 'speaker': w.get('speaker')})
    return words


def _studio_captions(spec: dict):
    """(groups on the output timeline, style, speaker colours, burn-in preset)."""
    caps = spec.get('captions') if isinstance(spec.get('captions'), dict) else {}
    raw = caps.get('groups') or []
    groups: list[list[dict]] = []
    if raw and isinstance(raw[0], dict) and isinstance(raw[0].get('words'), list):
        # the prepare node's shape: one dict per caption line with the timed
        # words nested inside and the speaker on the line
        for group in raw:
            words = _norm_words(group.get('words'))
            for w in words:
                w.setdefault('speaker', None)
                if w['speaker'] is None:
                    w['speaker'] = group.get('speaker')
            if words:
                groups.append(words)
    elif raw and isinstance(raw[0], dict):
        groups = group_words(_norm_words(raw))
    else:
        for group in raw:
            words = _norm_words(group)
            if words:
                groups.append(words)
    style = caps.get('style') or (spec.get('visual') or {}).get('caption_style') or {}
    colours = caps.get('speaker_colors') or {}
    preset = CAPTION_STYLE_PRESETS.get(str(style.get('preset') or 'classic').lower(), 'classic')
    return groups, style, colours, preset
