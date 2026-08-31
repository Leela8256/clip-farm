"""
podcast_layout — the Smart Visual Director for one clip.

Inputs
  text     the clip plan from podcast_prepare_clip (JSON with clip_id/project)
           and, per frame, the face list from the stock face_detection node
           (a JSON array — the two are told apart by shape)
  table    frame_grabber's frame table (ordinal, seconds, stamp) written when
           the object closes; joins the face lists to clip time

Output (text lane): the same plan with a `layout` block — tracks, who is
talking when, layout segments with dwell time, smoothed crop paths and quality
metrics — persisted at analysis/clips/<id>/layout.json together with a face
thumbnail per person so the UI can offer "follow this person".

No faces, no video, or a detector that never ran: the plan goes through with a
full-frame layout and says so.
"""

from __future__ import annotations
import json
import shutil
import tempfile
import time
from pathlib import Path

from rocketlib import IInstanceBase, Entry, warning, debug

from local_nodes.podcast_common.store import get_store, write_file, write_json
from local_nodes.podcast_common.project import Project, read_json_or, update_status
from local_nodes.podcast_common.cache import local_source
from local_nodes.podcast_common.media import DETECT_WIDTH, crop_thumbnail
from local_nodes.podcast_common.visual import SAMPLE_MS, build_layout, faces_from_persons

from .IGlobal import IGlobal

NODE = 'podcast_layout'


def _parse_table(markdown: str) -> list[float]:
    """Seconds column of frame_grabber's markdown table, in row order."""
    seconds: list[float] = []
    for line in (markdown or '').splitlines():
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) < 2 or not cells[0].isdigit():
            continue
        try:
            seconds.append(float(cells[1]))
        except ValueError:
            continue
    return seconds


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        pass

    def open(self, obj: Entry):
        self._plan: dict | None = None
        self._faces: list[list] = []
        self._times: list[float] = []
        self._t0 = time.time()

    def writeText(self, text: str):
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            return
        if isinstance(data, dict) and data.get('clip_id') and data.get('project'):
            self._plan = data
        elif isinstance(data, list):
            self._faces.append(data)

    def writeTable(self, table: str):
        self._times.extend(_parse_table(table))

    def closing(self):
        if not self._plan:
            warning(f'{NODE}: no clip plan received — nothing to lay out')
            return
        plan = self._plan
        store = get_store()
        pipe = getattr(self.instance, 'pipeId', None)
        project = Project(plan['project'])
        try:
            plan['layout'] = self._layout(store, project, plan, pipe)
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: {exc}')
            update_status(store, project, NODE, 'error', pipe, clip=plan.get('clip_id'), message=str(exc))
            plan['layout'] = {'schema_version': 1, 'mode': 'auto', 'segments': [{'start_ms': 0, 'end_ms': int(plan['duration_ms']),
                              'layout': 'full_frame', 'subjects': [], 'reason': f'layout failed: {exc}'}], 'paths': [],
                              'tracks': [], 'speaking': [], 'metrics': {'people': 0}, 'error': str(exc),
                              'source': {'width': (plan.get('media') or {}).get('width', 0), 'height': (plan.get('media') or {}).get('height', 0)},
                              'canvas': {'width': 1080, 'height': 1920}}
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(plan))

    def _layout(self, store, project: Project, plan: dict, pipe) -> dict:
        cfg = self.IGlobal.config
        clip_id = str(plan['clip_id'])
        media = plan.get('media') or {}
        width, height = int(media.get('width') or 0), int(media.get('height') or 0)
        total_ms = int(plan['duration_ms'])
        options = plan.get('options') or {}
        mode = str(options.get('layout_mode') or cfg['mode'] or 'auto')
        subject = options.get('subject') or None
        focus = options.get('focus') if isinstance(options.get('focus'), dict) else None
        update_status(store, project, NODE, 'tracking', pipe, clip=clip_id, frames=len(self._faces), people=None)

        if not media.get('has_video', True) or not width or not height:
            return self._passthrough(plan, 'audio-only recording')
        if not self._faces:
            return self._passthrough(plan, 'no frames reached the face detector')

        # frame times: the grabber's table when it lines up, else the sample interval
        sample_ms = int(cfg['sample_ms'] or SAMPLE_MS)
        if len(self._times) == len(self._faces):
            times = [int(round(t * 1000)) for t in self._times]
        else:
            if self._times:
                debug(f'{NODE}: {len(self._times)} frame times for {len(self._faces)} face lists — using the sample interval')
            times = [i * sample_ms for i in range(len(self._faces))]
        # detections were made on a downscaled copy: back to source pixels
        scale = width / float(cfg['detect_width'] or DETECT_WIDTH)
        frames = [{'t_ms': t, 'faces': _scale_faces(faces_from_persons(faces), scale)} for t, faces in zip(times, self._faces)]

        layout = build_layout(frames, plan.get('words') or [], total_ms, width=width, height=height,
                              out_w=int(cfg['canvas_width']), out_h=int(cfg['canvas_height']),
                              mode=mode, subject=subject, focus=focus, sample_ms=sample_ms)
        layout['clip_id'] = clip_id
        layout['thumbnails'] = self._thumbnails(store, project, plan, layout)
        layout['seconds'] = round(time.time() - self._t0, 1)
        write_json(store, project.clip_dir(clip_id) + '/layout.json', layout)
        m = layout['metrics']
        update_status(store, project, NODE, 'planned', pipe, clip=clip_id, people=m.get('people'), segments=len(layout['segments']),
                      layouts=sorted({s['layout'] for s in layout['segments']}), speaker_visible_pct=m.get('speaker_visible_pct'),
                      seconds=layout['seconds'])
        return layout

    def _thumbnails(self, store, project: Project, plan: dict, layout: dict) -> dict:
        """One face crop per tracked person, from the source at their best frame."""
        out: dict[str, str] = {}
        tracks = layout.get('tracks') or []
        if not tracks:
            return out
        work = Path(tempfile.mkdtemp(prefix='podcast_layout_'))
        try:
            local = local_source(store, plan['source'])
            clip_start = int(plan['start_ms'])
            for track in tracks:
                best = next((p for p in track['frames'] if p[0] == track['best_ms']), track['frames'][0])
                box = (int(best[1]), int(best[2]), max(8, int(best[3])), max(8, int(best[4])))
                jpg = crop_thumbnail(local, work / f"{track['id']}.jpg", clip_start + int(best[0]), box)
                out[track['id']] = write_file(store, project.clip_dir(str(plan['clip_id'])) + f"/{track['id']}.jpg", jpg)
        except Exception as exc:  # noqa: BLE001
            debug(f'{NODE}: thumbnails skipped: {exc}')
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return out

    def _passthrough(self, plan: dict, reason: str) -> dict:
        media = plan.get('media') or {}
        cfg = self.IGlobal.config
        return {'schema_version': 1, 'mode': 'auto', 'clip_id': plan['clip_id'],
                'source': {'width': int(media.get('width') or 0), 'height': int(media.get('height') or 0)},
                'canvas': {'width': int(cfg['canvas_width']), 'height': int(cfg['canvas_height'])},
                'tracks': [], 'speaking': [], 'paths': [], 'thumbnails': {},
                'segments': [{'start_ms': 0, 'end_ms': int(plan['duration_ms']), 'layout': 'full_frame', 'subjects': [], 'reason': reason}],
                'metrics': {'people': 0, 'frames_sampled': len(self._faces), 'faces_detected_pct': 0, 'layout_changes': 0},
                'method': 'no detection'}


def _scale_faces(faces: list, scale: float) -> list[dict]:
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
