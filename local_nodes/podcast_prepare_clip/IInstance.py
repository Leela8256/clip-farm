"""
podcast_prepare_clip — one chat question = one clip to prepare.

Context lines: 'project: projects/<episode>' plus either 'clip: <candidate id>'
(an analysis candidate c03, a Prompt Director candidate r02c01, or a hand-made
clip x53-96) or explicit 'start: <ms>' / 'end: <ms>' (explicit times override
the candidate and any saved edit). Optional:
  'title:', 'captions: off|classic|yellow-bold|white-outline|minimal',
  'layouts: vertical,wide', 'fillers: smart|cut|mute|keep|off',
  'silences: tighten|keep' (or legacy 'tighten: off'), 'duration: <seconds>',
  'mode: natural|strict|maximum', 'version: <n>' (saved edit version),
  'restore: f01,s02' (cut ids to keep).

Resolution order for every option: the question > the saved edit (active
version) > the Prompt Director request the clip came from > node config.

A question carrying 'studio: init | preview | export' instead of a clip works
on the WHOLE episode (the editing studio): 'init' aligns the episode word by
word and writes analysis/studio/{timeline,waveform,suggestions}.json;
'preview'/'export' read the browser's edits/episode-edits.json and assemble
analysis/studio/prepared-v<version>.json — the episode render spec — with an
optional 'range: <a>-<b>' (output-timeline ms) and 'quality: rough | full'.

Output (text lane): the clip plan (or, in studio mode, the episode spec) that
podcast_render consumes, persisted at analysis/clips/<id>/plan.json next to
compliance.json.
"""

from __future__ import annotations
import json
import shutil
import tempfile
import time
from pathlib import Path

from rocketlib import IInstanceBase, Entry, AVI_ACTION, debug
from ai.common.schema import Answer, Question

from local_nodes.podcast_common.store import exists, get_store, write_json
from local_nodes.podcast_common.project import (
    Project,
    find_candidate,
    load_project,
    parse_context,
    question_text,
    read_json_or,
    request_id_of,
    update_status,
)
from local_nodes.podcast_common.cache import local_source
from local_nodes.podcast_common.config import as_bool
from local_nodes.podcast_common.media import DETECT_FPS, DETECT_WIDTH, detect_silences, measure_levels, slice_audio, slice_video_for_detection
from local_nodes.podcast_common.align import align_words
from local_nodes.podcast_common.clips import FILLERS, locate_span, parse_timestamp, snap_to_word_boundaries, words_in_range
from local_nodes.podcast_common.editing import (
    FILLER_POLICIES,
    SILENCE_POLICIES,
    cut_ranges,
    fit_duration,
    is_sentence_end,
    mute_ranges,
    plan_cuts,
    rendered_ms,
)
from local_nodes.podcast_common.spec import CAPTION_PRESETS, RENDERABLE_ASPECTS, duration_window, normalize_spec
from local_nodes.podcast_common.constraints import find_profanity
from local_nodes.podcast_common import studio as studio_lib

from .IGlobal import IGlobal

NODE = 'podcast_prepare_clip'
MIN_CLIP_MS = 3000
TOLERANCE_BY_MODE = {'natural': 3000, 'strict': 1000, 'maximum': 0}
LAYOUT_MODES = ('auto', 'solo_follow', 'stacked_two', 'side_by_side', 'screen_share', 'full_frame', 'fixed_crop', 'original')
LAYOUT_ALIASES = {'solo': 'solo_follow', 'follow': 'solo_follow', 'stacked': 'stacked_two', 'stack': 'stacked_two',
                  'side': 'side_by_side', 'screen': 'screen_share', 'full': 'full_frame', 'blur': 'full_frame',
                  'fixed': 'fixed_crop', 'crop': 'fixed_crop', 'none': 'original'}


def _policy(value, allowed: tuple, on: str, off: str) -> str | None:
    """A policy word, or on/off words mapped to the policy they mean; None when absent/unknown."""
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in allowed:
        return text
    flag = as_bool(text, None)
    if flag is True:
        return on
    if flag is False:
        return off
    return None


def _caption_choice(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return 'classic' if value else 'off'
    text = str(value).strip().lower()
    if text in CAPTION_PRESETS:
        return text
    flag = as_bool(text, None)
    if flag is True:
        return 'classic'
    if flag is False:
        return 'off'
    return None


def _active_edit(edit: dict, version: str | None) -> tuple[dict, int | None]:
    """The edit with the chosen (or active) version overlaid; versions never touch the base record."""
    versions = [v for v in (edit.get('versions') or []) if isinstance(v, dict)]
    wanted = version if version not in (None, '') else edit.get('active_version')
    chosen = None
    if wanted not in (None, ''):
        try:
            n = int(wanted)
        except (TypeError, ValueError):
            n = None
        chosen = next((v for v in versions if v.get('n') == n), None)
    if chosen is None:
        return dict(edit), None
    merged = {**edit, **{k: v for k, v in chosen.items() if k not in ('n', 'created', 'note', 'source')}}
    return merged, int(chosen['n'])


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
        step = str(ctx.get('studio') or '').strip().lower()
        try:
            if step:                                    # whole-episode editing studio
                spec, manifest = self._studio(store, project, ctx, step, pipe)
            else:                                       # one clip (unchanged)
                spec, manifest = self._prepare(store, project, ctx, question_text(question), pipe), None
        except Exception as exc:  # noqa: BLE001
            update_status(store, project, NODE, 'error', pipe, clip=ctx.get('clip'), studio=step or None,
                          message=str(exc))
            raise
        if spec is not None and self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(spec))
        if manifest is not None and self.instance.hasListener('answers'):
            answer = Answer(expectJson=True)
            answer.setAnswer(manifest)
            self.instance.writeAnswers(answer)

    # ---------------------------------------------------------------- studio

    def _studio(self, store, project: Project, ctx: dict, step: str, pipe) -> tuple[dict | None, dict]:
        """The whole-episode branch: (spec for the renderer | None, manifest for the answers lane)."""
        if step == 'init':
            return None, self._studio_init(store, project, ctx, pipe)
        if step in ('preview', 'export'):
            spec = self._studio_spec(store, project, ctx, step, pipe)
            return spec, {**project.to_ref(), 'studio': step, 'version': spec['version'],
                          'output_duration_ms': spec['output_duration_ms'], 'quality': spec['quality'],
                          'range': spec['range'], 'chapters': len(spec['chapters']),
                          'spec': project.analysis(f"studio/prepared-v{spec['version']}.json"),
                          'warnings': spec['warnings']}
        raise ValueError(f"{NODE}: unknown studio step {step!r} — use 'studio: init | preview | export'")

    def _studio_init(self, store, project: Project, ctx: dict, pipe) -> dict:
        """Align the episode end to end, then write its timeline, waveform and suggestions."""
        t0 = time.time()
        cfg = self.IGlobal.config
        data = load_project(store, project)
        source = data.get('source')
        if not source:
            raise ValueError(f'{NODE}: project.json has no source')
        media = data.get('media') or {}
        transcript = read_json_or(store, project.analysis('transcript.json'), {}) or {}
        sentences = [s for s in (transcript.get('sentences') or []) if isinstance(s, dict)]
        duration_ms = int(media.get('duration_ms') or transcript.get('duration_ms') or 0)
        if duration_ms <= 0:
            raise ValueError(f'{NODE}: the recording length is unknown — run the episode analysis first')
        model = str(cfg.get('studio_model') or cfg['model'])

        update_status(store, project, NODE, 'preparing', pipe, studio='init', duration_ms=duration_ms, model=model)
        local = local_source(store, source)
        work = Path(tempfile.mkdtemp(prefix='podcast_studio_'))
        words: list[dict] = []
        language = None
        try:
            wav = studio_lib.analysis_wav(local, work / 'episode.wav')
            piece_ms = max(10_000, int(float(cfg['studio_piece_seconds']) * 1000))
            pieces = max(1, -(-duration_ms // piece_ms))
            for i in range(pieces):
                a = i * piece_ms
                b = min(duration_ms, a + piece_ms)
                if b - a < 200:
                    continue
                update_status(store, project, NODE, 'studio_aligning', pipe, piece=i + 1, pieces=pieces,
                              words=len(words), seconds=round(b / 1000, 1))
                piece_wav = slice_audio(wav, a, b, work / f'piece-{i:04d}.wav')
                hint = ' '.join((s.get('text') or '') for s in sentences
                                if s.get('start_ms', 0) < b and s.get('end_ms', 0) > a)[:200]
                aligned = align_words(piece_wav, model, str(cfg['language'] or '') or None, hint=hint or None)
                language = language or aligned.get('language')
                for w in aligned['words']:
                    start = w['start_ms'] + a
                    if start >= b + 1000:              # aligner overshoot at the tail of a piece
                        continue
                    words.append({**w, 'start_ms': start, 'end_ms': min(duration_ms, w['end_ms'] + a)})
                piece_wav.unlink(missing_ok=True)
            update_status(store, project, NODE, 'studio_suggesting', pipe, words=len(words))
            silences = detect_silences(wav, min_silence_ms=studio_lib.SILENCE_MIN_MS, keep_pause_ms=0)
            peaks = studio_lib.peaks_from_wav(wav)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        words = [w for w in sorted(words, key=lambda w: w['start_ms']) if w['end_ms'] > w['start_ms']]
        # the level scan misses pauses under room tone, the aligner misses pauses inside a
        # sentence: take both, then carve every spoken word back out of the result
        silences = studio_lib.speech_free_silences(
            list(silences) + studio_lib.silences_from_words(words, duration_ms), words)
        quiet = studio_lib.quiet_ranges(peaks, silences=silences)
        low_confidence = studio_lib.low_confidence_ranges(words)
        timeline = studio_lib.timeline_doc(episode_id=project.episode_id, duration_ms=duration_ms, model=model,
                                           words=words, silences=silences, quiet=quiet,
                                           low_confidence=low_confidence, sentence_count=len(sentences),
                                           language=language)
        suggestions = studio_lib.build_suggestions(words, silences=silences, quiet=quiet,
                                                   low_confidence=low_confidence, sentences=sentences,
                                                   duration_ms=duration_ms)
        waveform = studio_lib.waveform_doc(peaks, duration_ms)
        write_json(store, project.analysis('studio/timeline.json'), timeline)
        write_json(store, project.analysis('studio/waveform.json'), waveform)
        write_json(store, project.analysis('studio/suggestions.json'), suggestions)

        seconds = round(time.time() - t0, 1)
        update_status(store, project, NODE, 'studio_ready', pipe, words=len(words),
                      suggestions=len(suggestions['suggestions']), duration_ms=duration_ms, seconds=seconds)
        return {**project.to_ref(), 'studio': 'init', 'words': len(words),
                'suggestions': len(suggestions['suggestions']), 'duration_ms': duration_ms,
                'levels': {level: len(ids) for level, ids in suggestions['modes'].items()},
                'silences': len(timeline['silences']), 'peaks': len(peaks), 'seconds': seconds,
                'files': {'timeline': project.analysis('studio/timeline.json'),
                          'waveform': project.analysis('studio/waveform.json'),
                          'suggestions': project.analysis('studio/suggestions.json')}}

    def _studio_spec(self, store, project: Project, ctx: dict, step: str, pipe) -> dict:
        """Turn the saved episode edits into the render spec for a preview or an export."""
        data = load_project(store, project)
        source = data.get('source')
        if not source:
            raise ValueError(f'{NODE}: project.json has no source')
        edits = read_json_or(store, project.edits('episode-edits.json'), {}) or {}
        timeline = read_json_or(store, project.analysis('studio/timeline.json'), {}) or {}
        words = studio_lib.expand_words(timeline.get('words') or [])
        version = ctx.get('version') if str(ctx.get('version') or '').strip() else edits.get('version')
        quality = str(ctx.get('quality') or ('rough' if step == 'preview' else 'full')).strip().lower()
        update_status(store, project, NODE, 'preparing', pipe, studio=step, quality=quality,
                      edits=len(edits.get('operations') or []))
        spec = studio_lib.build_prepared(
            project=project.root, episode_id=project.episode_id, source=source, media=data.get('media') or {},
            edits=edits, words=words, version=version, range_text=ctx.get('range'), quality=quality,
            asset_exists=lambda path: exists(store, path), mode=step)
        if not words:
            spec['warnings'].append('The recording has not been prepared for editing yet — captions were left out.')
        write_json(store, project.analysis(f"studio/prepared-v{spec['version']}.json"), spec)
        update_status(store, project, NODE, 'studio_prepared', pipe, studio=step, version=spec['version'],
                      output_ms=spec['output_duration_ms'], cuts=len(spec['cuts']), mutes=len(spec['mutes']),
                      bleeps=len(spec['bleeps']), warnings=len(spec['warnings']))
        return spec

    # ------------------------------------------------------------------ plan

    def _prepare(self, store, project: Project, ctx: dict, direction: str, pipe) -> dict:
        t0 = time.time()
        cfg = self.IGlobal.config
        data = load_project(store, project)
        source = data.get('source')
        if not source:
            raise ValueError(f'{NODE}: project.json has no source')
        media = data.get('media') or {}
        duration_ms = int(media.get('duration_ms') or 0)

        clip_id = (ctx.get('clip') or '').strip()
        cand, request = find_candidate(store, project, clip_id) if clip_id else ({}, None)
        req_spec = normalize_spec(request.get('spec')) if isinstance(request, dict) and request.get('spec') else None
        edits_all = (read_json_or(store, project.edits('clip-edits.json'), {}) or {}).get('clips') or {}
        edit, version = _active_edit(edits_all.get(clip_id) or {}, ctx.get('version')) if clip_id else ({}, None)

        start = parse_timestamp(ctx.get('start'))
        end = parse_timestamp(ctx.get('end'))
        explicit = start is not None or end is not None or 'start_ms' in edit or 'end_ms' in edit
        if start is None:
            start = edit.get('start_ms', cand.get('start_ms'))
        if end is None:
            end = edit.get('end_ms', cand.get('end_ms'))
        if start is None or end is None:
            raise ValueError(f"{NODE}: unknown clip {clip_id!r} — give a candidate id or 'start:'/'end:' times")
        start, end = max(0, int(start)), int(end)
        if duration_ms:
            end = min(end, duration_ms)
        if end - start < MIN_CLIP_MS:
            raise ValueError(f'{NODE}: clip is shorter than {MIN_CLIP_MS // 1000} seconds')
        if not clip_id:
            clip_id = f'x{start // 1000}-{end // 1000}'

        # ---- options: question > edit > request spec > node config ----------
        title = ctx.get('title') or edit.get('title') or cand.get('title') or f'Clip {clip_id}'
        captions = (_caption_choice(ctx.get('captions')) or _caption_choice(edit.get('caption_preset'))
                    or _caption_choice(edit.get('captions')) or (req_spec or {}).get('caption_preset') or str(cfg['caption_preset']))
        fillers = (_policy(ctx.get('fillers'), FILLER_POLICIES, 'smart', 'keep')
                   or _policy(edit.get('filler_policy'), FILLER_POLICIES, 'smart', 'keep')
                   or _policy(edit.get('remove_fillers'), FILLER_POLICIES, 'smart', 'keep')
                   or (req_spec or {}).get('filler_policy') or str(cfg['filler_policy']))
        silences = (_policy(ctx.get('silences'), SILENCE_POLICIES, 'tighten', 'keep')
                    or _policy(ctx.get('tighten'), SILENCE_POLICIES, 'tighten', 'keep')
                    or _policy(edit.get('silence_policy'), SILENCE_POLICIES, 'tighten', 'keep')
                    or _policy(edit.get('tighten_pauses'), SILENCE_POLICIES, 'tighten', 'keep')
                    or (req_spec or {}).get('silence_policy') or str(cfg['silence_policy']))
        layouts = ctx.get('layouts') or edit.get('layouts') or ''
        if not layouts and req_spec:
            layouts = RENDERABLE_ASPECTS.get(req_spec.get('aspect_ratio') or '', '')
        target_s = parse_timestamp(ctx.get('duration')) if ctx.get('duration') else None
        if target_s is not None:
            target_s = target_s / 1000 if target_s > 1000 else target_s  # 'duration: 42' is seconds
        elif edit.get('duration_seconds'):
            target_s = float(edit['duration_seconds'])
        elif req_spec:
            target_s = float(req_spec['duration']['target_seconds'])
        mode = str(ctx.get('mode') or edit.get('duration_mode') or ((req_spec or {}).get('duration') or {}).get('mode') or 'natural').lower()
        if mode not in TOLERANCE_BY_MODE:
            mode = 'natural'
        tolerance_ms = duration_window(req_spec)['tolerance_ms'] if req_spec else TOLERANCE_BY_MODE[mode]
        disabled = {c.strip() for c in str(ctx.get('restore') or '').split(',') if c.strip()}
        disabled |= {str(c) for c in (edit.get('disabled_cuts') or [])}
        # visual director overrides (phase 2): layout mode, the person to follow, a manual region
        layout_raw = str(ctx.get('layout') or edit.get('layout_mode') or 'auto').strip().lower()
        layout_mode = LAYOUT_ALIASES.get(layout_raw, layout_raw)
        if layout_mode not in LAYOUT_MODES:
            layout_mode = 'auto'
        subject = str(ctx.get('subject') or edit.get('subject') or '').strip() or None
        focus = edit.get('focus') if isinstance(edit.get('focus'), dict) else None

        update_status(store, project, NODE, 'preparing', pipe, clip=clip_id, start_ms=start, end_ms=end, mode=mode,
                      target_seconds=target_s)
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
                    span = locate_span(words, cand['quote'])
                    if span and abs(span[0] - start) <= 5000:
                        start = span[0]
            s_snap, e_snap = snap_to_word_boundaries(start, end, words) if words else (start, end)
            s_snap, e_snap = max(i0, s_snap), min(i1, e_snap)
            if e_snap - s_snap < MIN_CLIP_MS:
                s_snap, e_snap = start, end
            total = e_snap - s_snap
            clip_words = words_in_range(words, s_snap, e_snap)

            # ---- cuts with safety --------------------------------------------
            clip_wav = None
            pauses: list[tuple[int, int]] = []
            if silences == 'tighten':
                clip_wav = slice_audio(local, s_snap, e_snap, work / 'clip.wav')
                pauses = detect_silences(clip_wav)
            levels: dict[int, float] = {}
            if bool(cfg['level_check']):
                ranges = list(pauses)
                if fillers != 'keep':
                    ranges += [(w['start_ms'], w['end_ms']) for w in clip_words if w['word'].lower().strip('.,!?;:') in FILLERS]
                if ranges:
                    clip_wav = clip_wav or slice_audio(local, s_snap, e_snap, work / 'clip.wav')
                    levels = measure_levels(clip_wav, ranges)
            cuts = plan_cuts(clip_words, pauses, total, filler_policy=fillers, silence_policy=silences,
                             disabled=disabled, levels=levels)

            # ---- duration fit ------------------------------------------------
            following = [w['start_ms'] for w in words if w['start_ms'] >= e_snap]
            room_after = max(0, min(i1, following[0] if following else i1) - e_snap)
            target_ms = int(round(target_s * 1000)) if target_s else total
            fit = fit_duration(clip_words, cuts, total, target_ms=target_ms, mode=mode if target_s else 'natural',
                               tolerance_ms=tolerance_ms, room_after_ms=room_after, min_clip_ms=MIN_CLIP_MS)
            cuts = fit['cuts']
            e_final = s_snap + int(fit['end_ms'])
            total = e_final - s_snap
            clip_words = words_in_range(words, s_snap, e_final)
            keep = [(int(s), int(e)) for s, e in fit['keep']]
            mutes = [(s, min(e, total)) for s, e in mute_ranges(cuts) if s < total]

            # phase 2: a small copy of the clip for the stock frame grabber + face detector
            detect_slice = None
            if self.instance.hasListener('video') and media.get('has_video', True) and layout_mode != 'original':
                update_status(store, project, NODE, 'slicing', pipe, clip=clip_id, width=DETECT_WIDTH, fps=DETECT_FPS)
                detect_slice = slice_video_for_detection(local, s_snap, e_final, work / 'detect.mp4')
                self._stream_video(detect_slice, clip_id, total, media)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        transcript = ' '.join(w['word'] for w in clip_words)
        rendered = rendered_ms(keep)
        compliance = self._compliance(clip_id, cand, req_spec, fit, cuts, clip_words, transcript, mode if target_s else 'natural',
                                      target_s, rendered)
        plan = {
            'schema_version': 2,
            **project.to_ref(),
            'source': source,
            'clip_id': clip_id,
            'candidate': cand.get('id'),
            'request_id': request_id_of(clip_id) if cand else None,
            'version': version,
            'title': title,
            'hook': cand.get('hook') or '',
            'reason': cand.get('reason') or '',
            'scores': cand.get('scores') or {},
            'direction': direction,
            'requested': {'start_ms': start, 'end_ms': end},
            'start_ms': s_snap,
            'end_ms': e_final,
            'duration_ms': total,
            'rendered_duration_ms': rendered,
            'words': clip_words,
            'transcript': transcript,
            'language': aligned.get('language'),
            'keep': [list(k) for k in keep],
            'cuts': cuts,
            'mutes': [list(m) for m in mutes],
            'fit': {k: fit[k] for k in ('mode', 'target_ms', 'tolerance_ms', 'before_ms', 'after_ms', 'met', 'actions', 'warnings')},
            'options': {
                'captions': captions != 'off',
                'caption_preset': captions,
                'filler_policy': fillers,
                'silence_policy': silences,
                'tighten_pauses': silences == 'tighten',
                'remove_fillers': fillers != 'keep',
                'layouts': layouts,
                'duration_seconds': target_s,
                'duration_mode': mode if target_s else 'natural',
                'disabled_cuts': sorted(disabled),
                'layout_mode': layout_mode,
                'subject': subject,
                'focus': focus,
            },
            'media': media,
            'prepared_at': time.time(),
            'seconds': round(time.time() - t0, 1),
        }
        write_json(store, project.clip_plan(clip_id), plan)
        write_json(store, project.clip_compliance(clip_id), compliance)
        update_status(store, project, NODE, 'prepared', pipe, clip=clip_id, words=len(clip_words),
                      cuts=compliance['cuts']['applied'], muted=compliance['cuts']['muted'], duration_ms=total,
                      rendered_ms=rendered, fit_met=fit['met'], seconds=plan['seconds'])
        return plan

    def _stream_video(self, path: Path, clip_id: str, total_ms: int, media: dict) -> None:
        """The detection copy of the clip as one stream on the video lane (frame times = clip times)."""
        try:
            from ai.common.avi.descriptor import video_begin_payload

            width = int(media.get('width') or 0)
            height = int(media.get('height') or 0)
            det_h = int(round(DETECT_WIDTH * height / width)) // 2 * 2 if width and height else None
            payload = video_begin_payload(None, size=path.stat().st_size, duration=total_ms / 1000, fps=DETECT_FPS,
                                          width=DETECT_WIDTH, height=det_h, name=f'{clip_id}.detect.mp4', origin='extracted')
        except Exception as exc:  # noqa: BLE001
            debug(f'{NODE}: no video descriptor: {exc}')
            payload = b''
        self.instance.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', payload)
        try:
            with open(path, 'rb') as f:
                while True:
                    chunk = f.read(1024 * 1024)
                    if not chunk:
                        break
                    self.instance.writeVideo(AVI_ACTION.WRITE, 'video/mp4', chunk)
        finally:
            self.instance.writeVideo(AVI_ACTION.END, 'video/mp4', b'')

    @staticmethod
    def _compliance(clip_id: str, cand: dict, req_spec: dict | None, fit: dict, cuts: list[dict], clip_words: list[dict],
                    transcript: str, mode: str, target_s: float | None, rendered_ms_: int) -> dict:
        base = dict(cand.get('compliance') or {})
        profane = find_profanity(transcript)
        warnings = list(base.get('warnings') or []) + list(fit.get('warnings') or [])
        if profane and req_spec and 'profanity' in (req_spec.get('exclude_content') or []):
            warnings.append('Profanity is spoken inside the final boundaries: ' + ', '.join(profane[:3]))
        scores = cand.get('scores') or {}
        prompt_match = scores.get('prompt_match')
        complete = base.get('complete_ending')
        if complete is None and clip_words:
            complete = is_sentence_end(clip_words[-1]['word'])
        enabled = [c for c in cuts if c.get('enabled')]
        return {
            'schema_version': 1,
            'clip_id': clip_id,
            'request_id': request_id_of(clip_id) if cand else None,
            'prompt_match': round(float(prompt_match) / 10, 2) if isinstance(prompt_match, (int, float)) else None,
            'duration_requested': target_s,
            'duration_final': round(rendered_ms_ / 1000, 1),
            'duration_mode': mode,
            'duration_met': bool(fit.get('met')) if target_s else None,
            'speaker_match': base.get('speaker_match'),
            'required_topic_found': base.get('required_topic_found'),
            'excluded_subject_found': base.get('excluded_subject_found'),
            'profanity_found': bool(profane),
            'profane_words': profane,
            'complete_ending': bool(complete) if complete is not None else None,
            'cuts': {
                'planned': len(cuts),
                'applied': sum(1 for c in enabled if c['action'] == 'cut'),
                'muted': sum(1 for c in enabled if c['action'] == 'mute'),
                'kept': sum(1 for c in cuts if c['action'] == 'keep'),
                'restored': sum(1 for c in cuts if not c.get('enabled')),
                'unsafe': sum(1 for c in cuts if not c.get('safe')),
            },
            'fit': {k: fit.get(k) for k in ('before_ms', 'after_ms', 'actions', 'met')},
            'warnings': warnings,
            'checked_at': time.time(),
        }
