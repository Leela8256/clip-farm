"""
media_render — turns one edit-decision spec into finished media.

The spec (see `plan.py` for the whole schema) arrives as JSON on the text lane
and names everything the render needs: the source in the account store, the
keep list, what to mute, bleep, overlay, concatenate and caption, and the
outputs to write. The node knows nothing about the application that sent it:
every path it touches comes from the spec (`source`, `write_to`, `report_to`,
`status_to`), and the report it writes carries only what was measured on the
finished files (plus the caller's own `meta`, echoed back untouched).

Two pipelines share the node — `plan.choose_pipeline` picks one:

* `clip` — a short piece: one audio pass (cut, cleaned, mastered) and one
  encode per output, with the crop paths of a framing plan when there is one.
* `programme` — a long timeline: the picture in resumable ~5 minute parts with
  burned captions and the overlay, cards and intro/outro material concatenated
  around it, one full-length body audio pass (cuts, mutes, bleeps, ducked
  music) and the two-pass mastering run LAST over the complete assembled
  programme, then the audio deliverables, sidecars, chapters and the report.

Invariants that are not negotiable, wherever the pipeline goes: audio and
picture are cut from the SAME keep list, joins are trim+concat (never a
chained xfade), every piece ends in setsar=1 before a concat, mutes and bleeps
are applied on the source timeline, captions are mapped through the keep list,
and the loudness measurement in the report is taken on the deliverable itself.
"""

from __future__ import annotations
import json
import shutil
import tempfile
import time
from pathlib import Path

from rocketlib import IInstanceBase, Entry, debug, warning
from ai.common.schema import Answer

try:
    from rocketlib.engine import monitorSSE
except Exception:  # noqa: BLE001
    monitorSSE = None

from local_nodes.podcast_common.cache import local_source
from local_nodes.podcast_common.captions import build_ass, build_srt, build_vtt, seam_placement
from local_nodes.podcast_common.store import download_to, exists, get_store, read_json, write_file, write_json

from . import plan as plan_lib
from .render_lib import (
    TimelineMap,
    assemble_episode_audio,
    chapters_payload,
    concat_parts,
    conform_audio,
    encode_audio_deliverable,
    ffmetadata_chapters,
    master_wav,
    measure_loudness,
    mux_episode,
    plan_episode_parts,
    probe,
    quality_block,
    render_asset_part,
    render_audio,
    render_card,
    render_clip_video,
    render_episode_audio,
    render_episode_part,
    render_layout_video,
    shift_groups,
    slice_audio,
    thumbnail,
    transcode_aspect,
)
from .report import build_render_report, cache_hit

from .IGlobal import IGlobal

NODE = 'media_render'
SSE_EVENT = 'podcast'          # the progress channel this platform's clients listen on


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
        # a render spec is a dict naming a source and where its files go; the
        # last one on the lane wins, so a node downstream of the planner (a
        # framing plan merged into the spec, say) hands over the final word.
        # Anything missing from it is reported as an error, never guessed.
        if isinstance(data, dict) and data.get('source') and (data.get('outputs') or data.get('write_to')):
            self._spec = data

    def closing(self):
        store = get_store()
        if not self._spec or store is None:
            warning(f'{NODE}: no render spec received')
            self._emit({'error': f'{NODE} received no render spec'})
            return
        pipe = getattr(self.instance, 'pipeId', None)
        meta = self._spec.get('meta') if isinstance(self._spec.get('meta'), dict) else {}
        try:
            report = self._render(store, pipe)
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: {exc}')
            self._status(store, 'error', pipe, message=str(exc))
            report = {**meta, 'error': str(exc)}
        self._emit(report)

    # ------------------------------------------------------------------ render

    def _render(self, store, pipe) -> dict:
        cfg = self.IGlobal.config
        spec = self._spec
        mode = 'export' if str(spec.get('mode') or 'preview').lower() == 'export' else 'preview'
        media = spec.get('media') if isinstance(spec.get('media'), dict) else {}
        has_video = bool(media.get('has_video', True))

        keep = plan_lib.resolve_keep(spec)
        audio = plan_lib.normalize_audio(spec)
        outputs = plan_lib.normalize_outputs(spec, cfg, has_video)
        captions = plan_lib.caption_plan(spec, keep['full_keep'])
        framing = plan_lib.framing_plan(spec)
        pipeline = plan_lib.choose_pipeline(spec)
        cache_key = plan_lib.cache_key_for(spec)
        write_to = str(spec.get('write_to') or '').strip('/')
        if not write_to:
            raise ValueError('the spec has no write_to')

        # a finished render of exactly this spec is worth more than making it again
        cached = self._cached(store, spec, outputs, cache_key, mode)
        if cached is not None:
            self._status(store, 'rendered', pipe, mode=mode, cached=True,
                         files=sorted(cached.get('files') or {}))
            return {**(spec.get('meta') or {}), **cached, 'cached': True}

        context = {'cfg': cfg, 'spec': spec, 'mode': mode, 'media': media, 'has_video': has_video,
                   'keep': keep, 'audio': audio, 'outputs': outputs, 'captions': captions,
                   'framing': framing, 'reframes': plan_lib.reframes(framing), 'cache_key': cache_key,
                   'write_to': write_to, 'pipe': pipe,
                   # a clip gets a poster frame unless told otherwise; a programme does not
                   'thumbnail': spec['thumbnail'] if 'thumbnail' in spec else (pipeline == 'clip')}
        if pipeline == 'programme':
            return self._render_programme(store, context)
        return self._render_clip(store, context)

    # -------------------------------------------------------------- clip path
    #
    # One short piece: slice the source's audio, cut / clean / master it in a
    # single pass, then encode every output from the same keep list.

    def _render_clip(self, store, ctx: dict) -> dict:
        spec, keep_plan = ctx['spec'], ctx['keep']
        outputs, captions, framing = ctx['outputs'], ctx['captions'], ctx['framing']
        reframes = bool(ctx['reframes'])
        audio, mode, pipe = ctx['audio'], ctx['mode'], ctx['pipe']
        keep = keep_plan['keep']
        source_range = keep_plan['source_range'] or [0, max(e for _, e in keep)]
        start, end = int(source_range[0]), int(source_range[1])
        mutes = plan_lib.as_ranges(spec.get('mutes'))
        warnings_out: list[str] = list(spec.get('warnings') or [])

        self._status(store, 'rendering', pipe, mode=mode, outputs=[o['key'] for o in outputs],
                     reframe=[s.get('layout') for s in (framing or {}).get('segments') or []] if reframes else None)
        local = local_source(store, spec['source'])
        overlay = plan_lib.overlay_for(spec)
        overlay_path = self._local_asset(store, overlay, 'overlay', warnings_out) if overlay else None

        work = Path(tempfile.mkdtemp(prefix='media_render_'))
        files: dict[str, str] = {}
        try:
            source_wav = slice_audio(local, start, end, work / 'source.wav')
            mastered = render_audio(source_wav, keep, work / 'mastered.wav', mutes_ms=mutes,
                                    loudness_lufs=audio['loudness_lufs'], true_peak=audio['true_peak'])
            timeline = TimelineMap(keep)
            groups = captions['groups']

            # caption placement follows the framing plan on the RENDERED
            # timeline (a stacked segment puts the line on the seam)
            placement = None
            if reframes:
                out_segments = []
                for segment in framing.get('segments') or []:
                    a = timeline.to_output(int(segment['start_ms']))
                    b = timeline.to_output(int(segment['end_ms']) - 1)
                    if a is None or b is None:
                        continue
                    out_segments.append({'start_ms': a, 'end_ms': b + 1, 'layout': segment['layout']})
                placement = seam_placement(out_segments)

            first_media = None
            applied = False
            for output in outputs:
                if not output['video']:
                    # an audio deliverable is the mastered programme itself
                    piece = slice_audio(mastered, 0, timeline.total_ms, work / output['file'])
                    files[output['key']] = write_file(store, f"{ctx['write_to']}/{output['file']}", piece)
                    first_media = first_media or piece
                    continue
                ass_path = None
                if output['captions'] and captions['enabled']:
                    ass_path = work / f"captions_{output['key']}.ass"
                    ass_path.write_text(
                        build_ass(groups, output['caption_layout'], style=captions['style'],
                                  placement=placement if output['framing'] else None), encoding='utf-8')
                self._status(store, 'encoding', pipe, mode=mode, layout=output['key'])
                if reframes and output['framing']:
                    shaped = dict(framing)
                    shaped['canvas'] = {'width': output['width'], 'height': output['height']}
                    mp4 = render_layout_video(local, start, end, keep, shaped, mastered, work / output['file'],
                                              work, ass_path=ass_path, fps=output['fps'], crf=output['crf'],
                                              preset=output['preset'], logo=overlay, logo_path=overlay_path)
                    applied = True
                else:
                    layout = output['layout'] or ('vertical' if output['height'] >= output['width'] else 'wide')
                    mp4 = render_clip_video(local, start, end, keep, mastered, work / output['file'],
                                            layout=layout, ass_path=ass_path, fps=output['fps'],
                                            crf=output['crf'], preset=output['preset'], logo=overlay,
                                            logo_path=overlay_path, width=output['width'], height=output['height'])
                files[output['key']] = write_file(store, f"{ctx['write_to']}/{output['file']}", mp4)
                first_media = first_media or mp4

            self._write_sidecars(store, ctx, groups, files, work, 0)
            if ctx['has_video'] and first_media is not None and ctx['thumbnail']:
                files['thumbnail'] = self._write_thumbnail(store, ctx, first_media, work,
                                                           min(1000, max(0, timeline.total_ms // 3)))

            check = probe(first_media)
            loudness = measure_loudness(first_media)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        primary = next((o for o in outputs if o['video']), outputs[0])
        report = self._report(ctx, check=check, loudness=loudness,
                              measurements={primary['key']: loudness} if loudness else {},
                              files=files, primary=primary, total_ms=timeline.total_ms,
                              body_ms=timeline.total_ms, mastered=True, framing_applied=applied,
                              mutes=len(mutes), bleeps=0, chapters=[], music=False, parts=[],
                              warnings=warnings_out)
        self._finish(store, ctx, report, files)
        return report

    # --------------------------------------------------------- programme path
    #
    # A whole edited timeline. The picture is rendered in resumable parts, the
    # sound in one full-length pass, and the mastering happens LAST — over the
    # assembled programme, so a loud intro or a silent card cannot pull the
    # finished file off its loudness target.

    def _render_programme(self, store, ctx: dict) -> dict:
        spec, cfg, keep_plan = ctx['spec'], ctx['cfg'], ctx['keep']
        outputs, captions, audio = ctx['outputs'], ctx['captions'], ctx['audio']
        mode, pipe, write_to = ctx['mode'], ctx['pipe'], ctx['write_to']
        keep, full_keep, offset_ms = keep_plan['keep'], keep_plan['full_keep'], keep_plan['offset_ms']
        mutes = plan_lib.as_ranges(spec.get('mutes'))
        bleeps = plan_lib.as_ranges(spec.get('bleeps'))
        body_ms = keep_plan['body_ms']
        warnings_out: list[str] = list(spec.get('warnings') or [])
        groups = captions['groups']

        primary = next((o for o in outputs if o['video'] and not o['from']), None)
        if primary is None:
            primary = next((o for o in outputs if not o['from']), outputs[0])
        derived = [o for o in outputs if o is not primary]
        out_w, out_h = primary['width'], primary['height']
        fps, crf, x264 = primary['fps'], primary['crf'], primary['preset']
        channels = audio['channels']
        has_video = bool(primary['video'])
        captions_on = bool(primary['captions'] and captions['enabled'])

        work = Path(tempfile.mkdtemp(prefix='media_render_programme_'))
        files: dict[str, str] = {}
        local_files: dict[str, Path] = {}
        part_times: list[dict] = []
        try:
            local = local_source(store, spec['source'])
            overlay = plan_lib.overlay_for(spec)
            overlay_path = self._local_asset(store, overlay, 'overlay', warnings_out) if overlay else None
            music_cfg = spec.get('music') if isinstance(spec.get('music'), dict) else None
            music_path = self._local_asset(store, music_cfg, 'music', warnings_out) if music_cfg else None

            # ---- picture: resumable parts, each with its own captions
            video_files: list[Path] = []
            audio_pieces: list[dict] = []
            lead_ms = tail_ms = 0
            if has_video:
                for item in plan_lib.concat_for(spec, 'start'):
                    asset = self._local_asset(store, item, 'clip', warnings_out)
                    if asset is None:
                        continue
                    part = render_asset_part(asset, work / f'lead-{len(video_files)}.mp4', out_w, out_h, fps=fps,
                                             crf=crf, preset=x264, fit=primary['fit'],
                                             background=primary['background'])
                    length = int(probe(part)['duration_ms'])
                    video_files.append(part)
                    audio_pieces.append(self._asset_audio(asset, work / f'lead-{len(video_files)}.wav',
                                                          length, warnings_out))
                    lead_ms += length
                for card in plan_lib.cards_for(spec, 'start'):
                    part = render_card(card.get('text') or spec.get('title') or '', card.get('subtitle') or '',
                                       float(card.get('seconds') or 3), work / f'lead-card-{len(video_files)}.mp4',
                                       out_w, out_h, fps=fps, crf=crf, preset=x264)
                    length = int(probe(part)['duration_ms'])
                    video_files.append(part)
                    audio_pieces.append({'silence_ms': length})
                    lead_ms += length

                parts = plan_episode_parts(keep, plan_lib.part_ms_for(spec, cfg))
                done, manifest = self._parts_manifest(store, ctx, parts)
                for part in parts:
                    started = time.time()
                    self._status(store, 'rendering', pipe, mode=mode, part=part['n'], parts=len(parts))
                    local_part = work / f"part-{part['n']:03d}.mp4"
                    store_path = f"{write_to}/parts/part-{part['n']:03d}.mp4"
                    reused = False
                    if manifest is not None and part['n'] in done and exists(store, store_path):
                        try:
                            download_to(store, store_path, local_part)
                            reused = True
                        except Exception:  # noqa: BLE001
                            reused = False
                    if not reused:
                        ass = None
                        if captions_on:
                            window = shift_groups(groups, offset_ms + part['out_start_ms'], part['duration_ms'])
                            ass = self._captions_file(work / f"part-{part['n']:03d}.ass", window, ctx,
                                                      out_w, out_h)
                        render_episode_part(local, [(s, e) for s, e in part['keep']], local_part, out_w, out_h,
                                            fps=fps, crf=crf, preset=x264, fit=primary['fit'],
                                            background=primary['background'], ass_path=ass, logo=overlay,
                                            logo_path=overlay_path)
                        if manifest is not None:
                            write_file(store, store_path, local_part)
                            manifest = self._mark_part_done(store, ctx, manifest, part['n'])
                    video_files.append(local_part)
                    part_times.append({'n': part['n'], 'duration_ms': part['duration_ms'],
                                       'seconds': round(time.time() - started, 1), 'reused': reused})

                audio_pieces.append({'path': None})            # placeholder for the body
                for card in plan_lib.cards_for(spec, 'end'):
                    part = render_card(card.get('text') or '', card.get('subtitle') or '',
                                       float(card.get('seconds') or 3), work / f'tail-card-{len(video_files)}.mp4',
                                       out_w, out_h, fps=fps, crf=crf, preset=x264)
                    length = int(probe(part)['duration_ms'])
                    video_files.append(part)
                    audio_pieces.append({'silence_ms': length})
                    tail_ms += length
                for item in plan_lib.concat_for(spec, 'end'):
                    asset = self._local_asset(store, item, 'clip', warnings_out)
                    if asset is None:
                        continue
                    part = render_asset_part(asset, work / f'tail-{len(video_files)}.mp4', out_w, out_h, fps=fps,
                                             crf=crf, preset=x264, fit=primary['fit'],
                                             background=primary['background'])
                    length = int(probe(part)['duration_ms'])
                    video_files.append(part)
                    audio_pieces.append(self._asset_audio(asset, work / f'tail-{len(video_files)}.wav',
                                                          length, warnings_out))
                    tail_ms += length
            else:
                audio_pieces.append({'path': None})

            # ---- sound: the edited body first — deliberately UNMASTERED here
            self._status(store, 'mastering', pipe, mode=mode, master=audio['master'])
            body_wav = render_episode_audio(
                local, keep, work / 'body.wav', mutes=mutes, bleeps=bleeps,
                noise_reduction=audio['denoise'], high_pass=audio['highpass'], compression=audio['compress'],
                music_path=music_path, music=music_cfg, master=False,
                loudness_lufs=audio['loudness_lufs'], true_peak=audio['true_peak'], channels=channels,
            )
            for piece in audio_pieces:
                if piece.get('path') is None and 'silence_ms' not in piece:
                    piece['path'] = str(body_wav)
            program_wav = assemble_episode_audio(audio_pieces, work / 'programme-audio.wav', channels=channels)

            # ---- mastering LAST, over the complete assembled programme
            final_wav = program_wav
            if audio['master']:
                final_wav = master_wav(program_wav, work / 'programme-master.wav',
                                       loudness_lufs=audio['loudness_lufs'], true_peak=audio['true_peak'],
                                       channels=channels)

            # ---- join + mux
            if has_video:
                joined = concat_parts(video_files, work / 'video.mp4', work)
                final = mux_episode(joined, final_wav, work / primary['file'])
            else:
                final = encode_audio_deliverable(final_wav, work / primary['file'])

            # every measurement below is taken on a FINISHED deliverable
            check = probe(final)
            loudness = measure_loudness(final)
            measurements: dict = {}
            if loudness:
                measurements[primary['key']] = loudness
            total_ms = lead_ms + body_ms + tail_ms

            files[primary['key']] = write_file(store, f"{write_to}/{primary['file']}", final)
            local_files[primary['key']] = final
            for output in derived:
                source_key = output['from']
                if output['video']:
                    origin = local_files.get(source_key) or final
                    alt = transcode_aspect(origin, work / output['file'], output['width'], output['height'],
                                           fps=output['fps'], crf=output['crf'], preset=output['preset'],
                                           fit=output['fit'], background=output['background'])
                else:
                    alt = encode_audio_deliverable(final_wav, work / output['file'])
                    measured = measure_loudness(alt)
                    if measured:
                        measurements[output['key']] = measured
                files[output['key']] = write_file(store, f"{write_to}/{output['file']}", alt)
                local_files[output['key']] = alt
            measurements = {k: v for k, v in measurements.items() if v}

            self._write_sidecars(store, ctx, groups, files, work, lead_ms)
            if ctx['thumbnail']:
                files['thumbnail'] = self._write_thumbnail(store, ctx, final, work, 1000)
            chapters = [{'title': c.get('title'), 'out_ms': int(c.get('out_ms') or 0) + lead_ms}
                        for c in (spec.get('chapters') or []) if isinstance(c, dict)]
            if chapters and mode == 'export':
                meta_file = work / 'chapters.txt'
                meta_file.write_text(ffmetadata_chapters(chapters, total_ms, spec.get('title')), encoding='utf-8')
                files['chapters_txt'] = write_file(store, f'{write_to}/chapters.txt', meta_file)
                write_json(store, f'{write_to}/chapters.json', chapters_payload(chapters, total_ms))
                files['chapters_json'] = f'{write_to}/chapters.json'
        finally:
            shutil.rmtree(work, ignore_errors=True)

        report = self._report(ctx, check=check, loudness=loudness, measurements=measurements, files=files,
                              primary=primary, total_ms=total_ms, body_ms=body_ms, lead_ms=lead_ms,
                              tail_ms=tail_ms, mastered=bool(audio['master']), framing_applied=False,
                              mutes=len(mutes), bleeps=len(bleeps), chapters=chapters,
                              music=bool(music_path), parts=part_times, warnings=warnings_out,
                              cuts=max(0, len(full_keep) - 1),
                              extras=[o['aspect'] for o in derived if o['video'] and o.get('aspect')])
        self._finish(store, ctx, report, files)
        return report

    # ---------------------------------------------------------------- helpers

    def _report(self, ctx: dict, *, check: dict, loudness, measurements: dict, files: dict, primary: dict,
                total_ms: int, body_ms: int, mastered: bool, framing_applied: bool, mutes: int, bleeps: int,
                chapters: list, music: bool, parts: list, warnings: list[str], lead_ms: int = 0,
                tail_ms: int = 0, cuts: int | None = None, extras: list | None = None) -> dict:
        spec, keep_plan, captions = ctx['spec'], ctx['keep'], ctx['captions']
        media = ctx['media']
        detail = quality_block(primary['tier'], check, crf=primary['crf'], preset=primary['preset'],
                               channels=primary['audio_channels'], source_width=media.get('width'),
                               source_height=media.get('height'), fps=primary['fps'],
                               width=primary['width'], height=primary['height'])
        captions_on = bool(primary['captions'] and captions['enabled'])
        report = build_render_report(
            kind=str((spec.get('meta') or {}).get('kind') or 'render'), mode=ctx['mode'],
            quality=str(spec.get('quality') or (spec.get('meta') or {}).get('quality') or primary['tier']),
            detail=detail, check=check,
            version=spec.get('version') or (spec.get('meta') or {}).get('version'),
            title=spec.get('title') or (spec.get('meta') or {}).get('title'), measured=loudness,
            measurements=measurements, target_lufs=ctx['audio']['loudness_lufs'], mastered=mastered,
            window=keep_plan['window'], preview_output_start_ms=keep_plan['offset_ms'], total_ms=total_ms,
            body_ms=body_ms, lead_ms=lead_ms, tail_ms=tail_ms, files=files,
            outputs=[o['key'] for o in ctx['outputs']], extras=extras,
            source_range=keep_plan['source_range'], fps=primary['fps'],
            cuts=max(0, len(keep_plan['full_keep']) - 1) if cuts is None else cuts,
            mutes=mutes, bleeps=bleeps, captions_on=captions_on,
            caption_lines=len(captions['groups']) if captions_on else 0,
            caption_style=captions['style'],
            caption_preset=(captions['style'].get('preset') if captions_on else 'off'),
            chapters=chapters, music=music, expect_video=bool(ctx['has_video']), parts=parts,
            cache_key=ctx['cache_key'], framing=plan_lib.framing_summary(ctx['framing'], framing_applied),
            warnings=warnings, seconds=round(time.time() - self._t0, 1))
        report['cached'] = False
        return {**(spec.get('meta') or {}), **report}

    def _finish(self, store, ctx: dict, report: dict, files: dict) -> None:
        report_to = ctx['spec'].get('report_to')
        if report_to:
            write_json(store, str(report_to), report)
        self._status(store, 'rendered', ctx['pipe'], mode=ctx['mode'], files=sorted(files),
                     seconds=report.get('seconds'))

    def _write_sidecars(self, store, ctx: dict, groups: list, files: dict, work: Path, lead_ms: int) -> None:
        """SRT / VTT next to the picture, on the finished file's own timeline."""
        captions = ctx['captions']
        wanted = bool(ctx['cfg']['sidecars']) if captions['sidecars'] is None else bool(captions['sidecars'])
        if not wanted or not groups:
            return
        name = captions['name'] or ctx['outputs'][0]['name']
        shifted = shift_groups(groups, -lead_ms) if lead_ms else groups
        if not shifted:
            return
        srt = work / f'{name}.srt'
        srt.write_text(build_srt(shifted), encoding='utf-8')
        files['srt'] = write_file(store, f"{ctx['write_to']}/{name}.srt", srt)
        vtt = work / f'{name}.vtt'
        vtt.write_text(build_vtt(shifted), encoding='utf-8')
        files['vtt'] = write_file(store, f"{ctx['write_to']}/{name}.vtt", vtt)

    def _write_thumbnail(self, store, ctx: dict, media_path: Path, work: Path, default_at_ms: int) -> str:
        want = ctx['spec'].get('thumbnail')
        want = want if isinstance(want, dict) else {}
        given = str(want.get('file') or '')
        name = given.rsplit('.', 1)[0] if given else str(want.get('name') or ctx['outputs'][0]['name'])
        at_ms = int(want.get('at_ms') if want.get('at_ms') is not None else default_at_ms)
        jpg = thumbnail(media_path, work / f'{name}.jpg', at_ms=at_ms)
        return write_file(store, f"{ctx['write_to']}/{name}.jpg", jpg)

    def _captions_file(self, path: Path, groups: list, ctx: dict, out_w: int, out_h: int):
        """One part's burned-in captions, in the spec's own style."""
        if not groups:
            return None
        captions = ctx['captions']
        style = captions['style']
        text = build_ass(groups, plan_lib.caption_layout_for(out_w, out_h), style=style,
                         speaker_colors=captions['speaker_colors'] if style.get('speaker_colors') else None)
        path.write_text(text, encoding='utf-8')
        return path

    def _local_asset(self, store, asset, kind: str, warnings_out: list[str]):
        """Cache one referenced file locally; a missing file is a warning, not a failure."""
        path = None
        if isinstance(asset, dict):
            path = asset.get('source') or asset.get('path') or asset.get('image')
        elif isinstance(asset, str):
            path = asset
        if not path:
            return None
        try:
            return local_source(store, str(path))
        except Exception as exc:  # noqa: BLE001
            warnings_out.append(f'The {kind} file could not be read and was skipped.')
            warning(f'{NODE}: asset {kind}: {exc}')
            return None

    def _asset_audio(self, asset_path, out_wav: Path, length_ms: int, warnings_out: list[str]) -> dict:
        try:
            return {'path': str(conform_audio(asset_path, out_wav, length_ms))}
        except Exception:  # noqa: BLE001
            warnings_out.append('One of the added clips had no sound; it plays silent.')
            return {'silence_ms': length_ms}

    def _cached(self, store, spec: dict, outputs: list[dict], cache_key: str, mode: str):
        """
        The report of an identical render that is already on disk: the same
        cache key, the same tier, the same window — and the files it describes
        still there. Only a caller that asked for caching (an explicit
        `cache_key`, or `cache: true`) gets one.
        """
        if mode == 'export' or not spec.get('report_to'):
            return None
        if not (spec.get('cache_key') or spec.get('cache')):
            return None
        primary = next((o for o in outputs if o['video']), outputs[0])
        window = spec.get('window') if isinstance(spec.get('window'), (list, tuple)) else None
        try:
            if not exists(store, f"{str(spec.get('write_to')).strip('/')}/{primary['file']}"):
                return None
            report = self._read_json(store, str(spec['report_to']))
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: cache: {exc}')
            return None
        return report if cache_hit(report, cache_key, primary['tier'], window) else None

    def _parts_manifest(self, store, ctx: dict, parts: list[dict]):
        """parts/manifest.json — which parts of THIS spec are already finished."""
        spec, mode = ctx['spec'], ctx['mode']
        chunking = spec.get('chunking') if isinstance(spec.get('chunking'), dict) else {}
        if mode != 'export' or not chunking.get('resume', True):
            return set(), None
        path = f"{ctx['write_to']}/parts/manifest.json"
        existing = self._read_json(store, path)
        done: set[int] = set()
        if isinstance(existing, dict) and (existing.get('cache_key') or existing.get('spec_hash')) == ctx['cache_key']:
            done = {int(p['n']) for p in existing.get('parts') or [] if p.get('done')}
        manifest = {'schema_version': 1, 'cache_key': ctx['cache_key'], 'spec_hash': ctx['cache_key'],
                    'updated': time.time(),
                    'parts': [{'n': p['n'], 'keep_slice': p['keep'], 'out_start_ms': p['out_start_ms'],
                               'out_end_ms': p['out_end_ms'], 'done': p['n'] in done} for p in parts]}
        write_json(store, path, manifest)
        return done, manifest

    def _mark_part_done(self, store, ctx: dict, manifest, n: int):
        if not isinstance(manifest, dict):
            return manifest
        for entry in manifest.get('parts') or []:
            if int(entry['n']) == int(n):
                entry['done'] = True
        manifest['updated'] = time.time()
        write_json(store, f"{ctx['write_to']}/parts/manifest.json", manifest)
        return manifest

    @staticmethod
    def _read_json(store, path: str):
        try:
            return read_json(store, path)
        except Exception:  # noqa: BLE001
            return None

    def _status(self, store, stage: str, pipe, **data) -> None:
        """
        Progress: the caller's `status_to` file (so a reloaded client can catch
        up) plus the SSE event every client already listens for. No status_to,
        no file — the event still goes out.
        """
        spec = self._spec or {}
        extra = spec.get('status_meta') if isinstance(spec.get('status_meta'), dict) else {}
        payload = {'node': NODE, 'stage': stage, 'time': time.time(), **extra, **data}
        path = spec.get('status_to')
        if path:
            try:
                write_json(store, str(path), payload)
            except Exception as exc:  # noqa: BLE001
                debug(f'{NODE}: could not write {path}: {exc}')
        if monitorSSE is not None and pipe is not None:
            try:
                monitorSSE(pipe, SSE_EVENT, payload)
            except Exception:  # noqa: BLE001
                pass
        debug(f'{NODE}: {stage} {json.dumps(data, default=str)[:160]}')

    def _emit(self, payload: dict):
        answer = Answer(expectJson=True)
        answer.setAnswer(payload)
        if self.instance.hasListener('answers'):
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(payload))
