"""
speaker_framing — framing decisions for talking-head video, from the pose /
face stream of the stock detectors.

Two modes, one node:

  plan  one piece of video: track the people, estimate who is talking from
        head motion gated by the word timing, plan dwell-limited layouts (solo
        follow, two-person stacked, side by side, screen share, full frame,
        fixed crop, original) with smoothed face-safe crop paths, score the
        result and merge the plan into the JSON that arrived on the text lane
        so a renderer downstream can execute it.
  scan  a whole recording: cluster the sparse samples into the people on
        screen (position, size, presence timeline, a thumbnail each) and
        detect shot changes.

Lanes
  questions (optional)  'key: value' context lines — every setting below
  text                  the caller's JSON (one dict: spec or reference) and,
                        per frame, the detector's person list (a JSON array;
                        the two are told apart by shape)
  table                 the frame grabber's table (ordinal, seconds, stamp),
                        which joins the detections to time
  text (out)            plan: the caller's JSON with the framing plan merged
                        in under `framing_plan`; scan: the manifest
  answers (out)         a manifest in both modes

Settings arrive, lowest precedence first, from the node config, from generic
probe fields on the incoming JSON (`media`/`width`/`height`/`duration_ms`/
`has_video`/`source`/`words`), from the question context, and from a `framing`
block on the incoming JSON — the channel a caller uses for values it only
knows at run time (duration, dimensions, where to write):

  mode              plan | scan
  width height      source pixel dimensions the plan is expressed in
  duration_ms       length of the analysed timeline
  has_video         false → a pass-through plan that says so
  source            store path of the media (thumbnails, shot detection)
  source_offset_ms  the source time of timeline 0 (thumbnails)
  words             word timings ([{start_ms,end_ms}] or a store path) — the
                    gate for the talking estimate
  aspect            9:16 | 4:5 | 1:1 | 16:9 — the canvas the windows fit
  canvas_width/height   an explicit canvas instead
  layout            forced layout ('auto' decides per moment)
  subject           track id to follow whenever they are on screen
  focus             {x,y,w,h} fractions for the fixed_crop layout
  sample_ms         (or sample_seconds) interval the frames were sampled at
  detect_width      width the detections were made at (0 = source pixels)
  dwell_ms pan_cap  framing tunables
  scenes scene_threshold   scan: shot-change detection
  write_to          store directory (or .json path) for the plan / people +
                    scenes; absent → nothing is written
  thumbnails_to     store directory for <id>.jpg; absent → no thumbnails
  status_to         store path for the progress file; absent → events only
  plan_key          key the plan is merged under (default framing_plan)
  echo              caller fields stamped into every file and payload
                    (also as `echo.<name>: <value>` context lines)
  label             opaque string for the progress events

Nothing here knows what the media is of, or where the caller keeps it.
"""

from __future__ import annotations
import json
import shutil
import tempfile
import time
from pathlib import Path

from rocketlib import IInstanceBase, Entry, warning, debug
from ai.common.schema import Answer, Question

from local_nodes.podcast_common.store import get_store, read_json, write_file, write_json
from local_nodes.podcast_common.cache import local_source
from local_nodes.podcast_common.config import as_bool
from local_nodes.podcast_common.visual import (
    DWELL_MS,
    MAX_PAN_PER_S,
    SAMPLE_MS,
    build_layout,
    faces_from_persons,
    people_from_samples,
)

from .frames import ASPECTS, canvas_dims, crop_thumbnail, detect_scenes, frame_seconds
from .IGlobal import IGlobal

try:
    from rocketlib.engine import monitorSSE
except Exception:  # noqa: BLE001
    monitorSSE = None

NODE = 'speaker_framing'
SSE_TYPE = 'podcast'    # the progress channel clients already listen on

DEFAULTS: dict = {
    'mode': 'plan', 'layout': 'auto', 'subject': None, 'focus': None, 'aspect': '',
    'width': 0, 'height': 0, 'duration_ms': 0, 'has_video': True,
    'source': '', 'source_offset_ms': 0, 'words': None,
    'sample_ms': SAMPLE_MS, 'detect_width': 640, 'canvas_width': 1080, 'canvas_height': 1920,
    'dwell_ms': DWELL_MS, 'pan_cap': MAX_PAN_PER_S, 'scenes': True, 'scene_threshold': 0.35,
    'write_to': '', 'thumbnails_to': '', 'status_to': '', 'plan_key': 'framing_plan',
    'echo': {}, 'label': '',
}
PROBE_KEYS = ('width', 'height', 'duration_ms', 'has_video', 'source', 'words')


def context_of(question) -> dict[str, str]:
    """'key: value' lines from a question's context, keys lower-cased."""
    found: dict[str, str] = {}
    for ctx in getattr(question, 'context', None) or []:
        for line in str(ctx).splitlines():
            if ':' not in line:
                continue
            key, value = line.split(':', 1)
            key = key.strip().lower()
            if key and ' ' not in key:
                found[key] = value.strip()
    return found


def apply_settings(settings: dict, values) -> dict:
    """Overlay one source of settings, typed like the defaults. Unknown keys are ignored."""
    if not isinstance(values, dict):
        return settings
    for raw_key, value in values.items():
        key = str(raw_key).strip().lower()
        if value is None or value == '':
            continue
        if key.startswith('echo.'):
            if key[5:]:
                settings['echo'] = {**settings['echo'], key[5:]: value}
            continue
        if key == 'sample_seconds':
            key, value = 'sample_ms', float(value) * 1000
        if key not in settings:
            continue
        current = DEFAULTS.get(key)
        try:
            if key == 'echo':
                extra = json.loads(value) if isinstance(value, str) else value
                settings['echo'] = {**settings['echo'], **dict(extra)}
            elif key in ('words', 'focus', 'subject'):
                settings[key] = json.loads(value) if isinstance(value, str) and value[:1] in '[{' else value
            elif isinstance(current, bool):
                settings[key] = as_bool(value, current)
            elif isinstance(current, float):
                settings[key] = float(value)
            elif isinstance(current, int):
                settings[key] = int(float(value))
            else:
                settings[key] = str(value)
        except (TypeError, ValueError):
            continue
    return settings


def word_times(words, store=None) -> list[dict]:
    """[{start_ms, end_ms}] from a word list (or a store path), any of the usual key spellings."""
    if isinstance(words, str):
        if not words.strip() or store is None:
            return []
        try:
            words = read_json(store, words.strip())
        except Exception as exc:  # noqa: BLE001
            debug(f'{NODE}: no word timings at {words!r}: {exc}')
            return []
    if isinstance(words, dict):
        words = words.get('words') or []
    out: list[dict] = []
    for w in words or []:
        if not isinstance(w, dict):
            continue
        start = w.get('start_ms', w.get('s', w.get('start')))
        end = w.get('end_ms', w.get('e', w.get('end')))
        if start is None or end is None:
            continue
        try:
            out.append({'start_ms': int(start), 'end_ms': int(end)})
        except (TypeError, ValueError):
            continue
    return out


def scale_faces(faces: list, scale: float) -> list[dict]:
    """Detections made on a downscaled copy, back in source pixels."""
    if scale == 1.0:
        return list(faces or [])
    out = []
    for f in faces or []:
        if not isinstance(f, dict):
            continue
        b = f.get('box') or {}
        item = {**f, 'box': {k: float(b.get(k, 0)) * scale for k in ('x1', 'y1', 'x2', 'y2')}}
        if isinstance(f.get('landmarks'), list):
            item['landmarks'] = [{**kp, 'x': float(kp.get('x', 0)) * scale, 'y': float(kp.get('y', 0)) * scale} for kp in f['landmarks'] if isinstance(kp, dict)]
        if isinstance(f.get('body'), dict):
            item['body'] = {k: float(f['body'].get(k, 0)) * scale for k in ('x1', 'y1', 'x2', 'y2')}
        out.append(item)
    return out


def store_dir(path: str) -> str:
    """The directory a caller's write_to names (a .json path names its parent)."""
    path = (path or '').rstrip('/')
    return path.rsplit('/', 1)[0] if path.lower().endswith('.json') and '/' in path else path


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        self._ctx: dict[str, str] = {}      # the question outlives the object it came with
        self._done = True
        self._reset()

    def _reset(self):
        self._spec: dict | None = None
        self._detections: list[list] = []
        self._times: list[float] = []
        self._t0 = time.time()
        self._done = False

    def open(self, obj: Entry):
        if self._done:                      # a new run; another lane of this one keeps its state
            self._reset()

    def writeQuestions(self, question: Question):
        self._ctx.update(context_of(question))

    def writeText(self, text: str):
        """A detector's person list per frame, or the caller's JSON — told apart by shape."""
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            return
        if isinstance(data, list):
            self._detections.append(data)
        elif isinstance(data, dict):
            if isinstance(data.get('persons'), list):
                self._detections.append(data['persons'])
            elif any(k in data for k in ('keypoints', 'landmarks', 'box')):
                self._detections.append([data])
            else:
                self._spec = data

    def writeTable(self, table: str):
        self._times.extend(frame_seconds(table))

    # ------------------------------------------------------------------ run

    def closing(self):
        cfg = self.settings()
        store = get_store()
        pipe = getattr(self.instance, 'pipeId', None)
        self._done = True
        if cfg['mode'] == 'scan':
            self._run_scan(store, cfg, pipe)
        else:
            self._run_plan(store, cfg, pipe)

    def settings(self) -> dict:
        """The node config, the incoming JSON and the question context, resolved."""
        cfg = dict(DEFAULTS)
        cfg['echo'] = {}
        apply_settings(cfg, self.IGlobal.config)
        spec = self._spec or {}
        # a probe block describes the whole recording; the JSON's own fields are
        # about the piece being framed, so they win
        apply_settings(cfg, spec.get('media') if isinstance(spec.get('media'), dict) else {})
        apply_settings(cfg, {k: spec[k] for k in PROBE_KEYS if k in spec})
        if cfg['words'] is None and isinstance(spec.get('subtitles'), dict):
            apply_settings(cfg, {'words': spec['subtitles'].get('words')})
        apply_settings(cfg, self._ctx)
        apply_settings(cfg, spec.get('framing') if isinstance(spec.get('framing'), dict) else {})
        return cfg

    # ----------------------------------------------------------------- plan

    def _run_plan(self, store, cfg: dict, pipe) -> None:
        spec = dict(self._spec) if isinstance(self._spec, dict) else None
        if spec is None and not cfg['write_to'] and not self.instance.hasListener('answers'):
            warning(f'{NODE}: no JSON arrived on the text lane — nothing to plan for')
            return
        try:
            plan = self._plan(store, cfg, pipe)
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: {exc}')
            self._status(store, cfg, 'error', pipe, message=str(exc))
            canvas_w, canvas_h = self._canvas(cfg)
            plan = {'schema_version': 1, 'mode': cfg['layout'],
                    'segments': [{'start_ms': 0, 'end_ms': int(cfg['duration_ms']), 'layout': 'full_frame',
                                  'subjects': [], 'reason': f'layout failed: {exc}'}],
                    'paths': [], 'tracks': [], 'speaking': [], 'metrics': {'people': 0}, 'error': str(exc),
                    'source': {'width': int(cfg['width']), 'height': int(cfg['height'])},
                    'canvas': {'width': canvas_w, 'height': canvas_h}}
        if spec is not None and self.instance.hasListener('text'):
            spec[str(cfg['plan_key'] or 'framing_plan')] = plan
            self.instance.writeText(json.dumps(spec))
        if self.instance.hasListener('answers'):
            metrics = plan.get('metrics') or {}
            self._answer({**cfg['echo'], 'mode': 'plan', 'people': metrics.get('people', 0),
                          'segments': len(plan.get('segments') or []), 'metrics': metrics,
                          'plan': self._plan_path(cfg) or None, 'error': plan.get('error')})

    def _plan(self, store, cfg: dict, pipe) -> dict:
        width, height = int(cfg['width']), int(cfg['height'])
        sample_ms = int(cfg['sample_ms'] or SAMPLE_MS)
        times = self._frame_times(sample_ms)
        total_ms = int(cfg['duration_ms']) or ((times[-1] + sample_ms) if times else 0)
        self._status(store, cfg, 'tracking', pipe, frames=len(self._detections), people=None)

        if not cfg['has_video'] or not width or not height:
            return self._passthrough(cfg, total_ms, 'audio-only recording')
        if not self._detections:
            return self._passthrough(cfg, total_ms, 'no frames reached the face detector')

        # detections may have been made on a downscaled copy: back to source pixels
        scale = width / float(cfg['detect_width']) if int(cfg['detect_width']) > 0 else 1.0
        frames = [{'t_ms': t, 'faces': scale_faces(faces_from_persons(persons), scale)}
                  for t, persons in zip(times, self._detections)]
        canvas_w, canvas_h = self._canvas(cfg)
        focus = cfg['focus'] if isinstance(cfg['focus'], dict) else None
        subject = str(cfg['subject']) if cfg['subject'] else None

        plan = build_layout(frames, word_times(cfg['words'], store), total_ms, width=width, height=height,
                            out_w=canvas_w, out_h=canvas_h, mode=str(cfg['layout'] or 'auto'), subject=subject,
                            focus=focus, sample_ms=sample_ms, dwell_ms=int(cfg['dwell_ms']),
                            pan_cap=float(cfg['pan_cap']))
        if cfg['echo']:
            plan.update(cfg['echo'])
        plan['thumbnails'] = self._thumbnails(store, cfg, plan.get('tracks') or [])
        plan['seconds'] = round(time.time() - self._t0, 1)
        path = self._plan_path(cfg)
        if store is not None and path:
            write_json(store, path, plan)
        m = plan['metrics']
        self._status(store, cfg, 'planned', pipe, people=m.get('people'), segments=len(plan['segments']),
                     layouts=sorted({s['layout'] for s in plan['segments']}),
                     speaker_visible_pct=m.get('speaker_visible_pct'), seconds=plan['seconds'])
        return plan

    def _passthrough(self, cfg: dict, total_ms: int, reason: str) -> dict:
        canvas_w, canvas_h = self._canvas(cfg)
        plan = {'schema_version': 1, 'mode': str(cfg['layout'] or 'auto'),
                'source': {'width': int(cfg['width']), 'height': int(cfg['height'])},
                'canvas': {'width': canvas_w, 'height': canvas_h},
                'tracks': [], 'speaking': [], 'paths': [], 'thumbnails': {},
                'segments': [{'start_ms': 0, 'end_ms': int(total_ms), 'layout': 'full_frame', 'subjects': [], 'reason': reason}],
                'metrics': {'people': 0, 'frames_sampled': len(self._detections), 'faces_detected_pct': 0, 'layout_changes': 0},
                'method': 'no detection'}
        return {**plan, **cfg['echo']} if cfg['echo'] else plan

    def _plan_path(self, cfg: dict) -> str:
        write_to = str(cfg['write_to'] or '').rstrip('/')
        if not write_to:
            return ''
        return write_to if write_to.lower().endswith('.json') else f'{write_to}/layout.json'

    def _thumbnails(self, store, cfg: dict, tracks: list[dict]) -> dict:
        """One face crop per tracked person, from the source at their best frame."""
        out: dict[str, str] = {}
        if not tracks or store is None or not cfg['thumbnails_to'] or not cfg['source']:
            return out
        into = store_dir(str(cfg['thumbnails_to']))
        work = Path(tempfile.mkdtemp(prefix='speaker_framing_'))
        try:
            local = local_source(store, str(cfg['source']))
            offset_ms = int(cfg['source_offset_ms'])
            for track in tracks:
                best = next((p for p in track['frames'] if p[0] == track['best_ms']), track['frames'][0])
                box = (int(best[1]), int(best[2]), max(8, int(best[3])), max(8, int(best[4])))
                jpg = crop_thumbnail(local, work / f"{track['id']}.jpg", offset_ms + int(best[0]), box)
                out[track['id']] = write_file(store, f"{into}/{track['id']}.jpg", jpg)
        except Exception as exc:  # noqa: BLE001
            debug(f'{NODE}: thumbnails skipped: {exc}')
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return out

    def _canvas(self, cfg: dict) -> tuple[int, int]:
        """
        The shape the crops are planned for. The configured canvas is the
        default (1080x1920); a caller asking for a feed format (4:5, 1:1) or a
        wide output plans its windows at that aspect instead, so a panel is
        never stretched to fit the frame it is scaled into.
        """
        canvas_w, canvas_h = int(cfg['canvas_width']), int(cfg['canvas_height'])
        aspect = str(cfg['aspect'] or '').strip()
        if aspect in ASPECTS:
            return canvas_dims(aspect, max(canvas_w, canvas_h))
        return canvas_w, canvas_h

    # ----------------------------------------------------------------- scan

    def _run_scan(self, store, cfg: dict, pipe) -> None:
        try:
            if store is None:
                raise RuntimeError(f'{NODE}: no account file store available for this task')
            manifest = self._scan(store, cfg, pipe)
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: {exc}')
            self._status(store, cfg, 'error', pipe, message=str(exc))
            manifest = {**cfg['echo'], 'error': str(exc)}
        self._answer(manifest)
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(manifest))

    def _scan(self, store, cfg: dict, pipe) -> dict:
        width, height = int(cfg['width']), int(cfg['height'])
        duration_ms = int(cfg['duration_ms'])
        sample_ms = int(cfg['sample_ms'] or SAMPLE_MS)
        times = self._frame_times(sample_ms)
        scale = width / float(cfg['detect_width']) if int(cfg['detect_width']) > 0 else 1.0
        frames = [{'t_ms': t, 'faces': scale_faces(faces_from_persons(persons), scale)}
                  for t, persons in zip(times, self._detections)]
        self._status(store, cfg, 'people', pipe, frames=len(frames))
        people = people_from_samples(frames, width, height, sample_ms) if width and height else []

        cuts: list[int] = []
        source = str(cfg['source'] or '')
        work = Path(tempfile.mkdtemp(prefix='speaker_framing_'))
        try:
            local = None
            if source and (cfg['thumbnails_to'] or bool(cfg['scenes'])):
                try:
                    local = local_source(store, source)
                except Exception as exc:  # noqa: BLE001 — the people are still worth reporting
                    warning(f'{NODE}: no local copy of {source!r} ({exc}): no thumbnails, no shot detection')
            if local is not None and cfg['thumbnails_to']:
                into = store_dir(str(cfg['thumbnails_to']))
                for person in people:
                    try:
                        jpg = crop_thumbnail(local, work / f"{person['id']}.jpg", person['best_ms'], tuple(person['best_box']))
                        person['thumbnail'] = write_file(store, f"{into}/{person['id']}.jpg", jpg)
                    except Exception as exc:  # noqa: BLE001
                        debug(f"{NODE}: no thumbnail for {person['id']}: {exc}")
            self._status(store, cfg, 'scenes', pipe, people=len(people))
            if local is not None and bool(cfg['scenes']):
                cuts = detect_scenes(local, float(cfg['scene_threshold']))
        finally:
            shutil.rmtree(work, ignore_errors=True)
        edges = [0] + [c for c in cuts if 0 < c < duration_ms] + [duration_ms or (times[-1] + sample_ms if times else 0)]
        scenes = [{'index': i, 'start_ms': a, 'end_ms': b} for i, (a, b) in enumerate(zip(edges, edges[1:])) if b > a]

        seconds = round(time.time() - self._t0, 1)
        into = store_dir(str(cfg['write_to'] or ''))
        if into:
            write_json(store, f'{into}/people.json',
                       {'schema_version': 1, **cfg['echo'], 'sample_ms': sample_ms, 'frames': len(frames),
                        'faces_detected_pct': round(100 * sum(1 for f in frames if f['faces']) / len(frames)) if frames else 0,
                        'width': width, 'height': height, 'people': people,
                        'method': 'stock frame_grabber + face_detection; people are clustered screen positions, not identities',
                        'scanned_at': time.time()})
            write_json(store, f'{into}/scenes.json',
                       {'schema_version': 1, **cfg['echo'], 'cuts_ms': cuts, 'scenes': scenes,
                        'method': f"ffmpeg scene score > {cfg['scene_threshold']}", 'scanned_at': time.time()})
        self._status(store, cfg, 'scanned', pipe, people=len(people), scenes=len(scenes), frames=len(frames), seconds=seconds)
        return {**cfg['echo'], 'people': people, 'scenes': len(scenes), 'frames': len(frames), 'seconds': seconds}

    # ----------------------------------------------------------------- bits

    def _frame_times(self, sample_ms: int) -> list[int]:
        """The grabber's table when it lines up with the detections, else the sample interval."""
        if len(self._times) == len(self._detections):
            return [int(round(t * 1000)) for t in self._times]
        if self._times:
            debug(f'{NODE}: {len(self._times)} frame times for {len(self._detections)} detections — using the sample interval')
        return [i * sample_ms for i in range(len(self._detections))]

    def _answer(self, payload: dict) -> None:
        if not self.instance.hasListener('answers'):
            return
        answer = Answer(expectJson=True)
        answer.setAnswer(payload)
        self.instance.writeAnswers(answer)

    def _status(self, store, cfg: dict, stage: str, pipe, **data) -> None:
        """Progress: the caller's status file (when named) and the live event."""
        payload = {'node': NODE, 'stage': stage, 'time': time.time(), **cfg['echo']}
        if cfg['label']:
            payload['label'] = cfg['label']
        payload.update(data)
        if store is not None and cfg['status_to']:
            try:
                write_json(store, str(cfg['status_to']), payload)
            except Exception as exc:  # noqa: BLE001
                debug(f'{NODE}: could not write {cfg["status_to"]}: {exc}')
        if monitorSSE is not None and pipe is not None:
            try:
                monitorSSE(pipe, SSE_TYPE, payload)
            except Exception:  # noqa: BLE001
                pass
        debug(f'{NODE}: {stage} {json.dumps(data, default=str)[:160]}')
