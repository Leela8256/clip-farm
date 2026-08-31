"""
podcast_visual — the episode's visual scan (runs once, after the analysis).

Inputs
  text    the episode reference from podcast_ingest (JSON with `project`) and,
          per sampled frame, the face list from the stock face_detection node
  table   frame_grabber's frame table (ordinal, seconds, stamp)

Writes analysis/visual/people.json (who appears where and when — screen
positions clustered over the sparse samples, with a thumbnail each) and
analysis/visual/scenes.json (shot changes from ffmpeg's scene score), records
the scan in project.json and returns a manifest on the answers lane.
"""

from __future__ import annotations
import json
import shutil
import tempfile
import time
from pathlib import Path

from rocketlib import IInstanceBase, Entry, warning, debug
from ai.common.schema import Answer

from local_nodes.podcast_common.store import get_store, write_file, write_json
from local_nodes.podcast_common.project import Project, load_project, parse_ref, save_project, update_status
from local_nodes.podcast_common.cache import local_source
from local_nodes.podcast_common.media import crop_thumbnail, detect_scenes
from local_nodes.podcast_common.visual import faces_from_persons, people_from_samples

from .IGlobal import IGlobal

NODE = 'podcast_visual'


def _parse_table(markdown: str) -> list[float]:
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
        self._ref: dict | None = None
        self._faces: list[list] = []
        self._times: list[float] = []
        self._t0 = time.time()

    def writeText(self, text: str):
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            return
        if isinstance(data, dict) and data.get('project'):
            self._ref = data
        elif isinstance(data, list):
            self._faces.append(data)

    def writeTable(self, table: str):
        self._times.extend(_parse_table(table))

    def closing(self):
        store = get_store()
        pipe = getattr(self.instance, 'pipeId', None)
        if not self._ref or store is None:
            warning(f'{NODE}: no episode reference / store')
            self._emit({'error': 'podcast_visual received no episode reference'})
            return
        project = Project(self._ref['project'])
        try:
            manifest = self._scan(store, project, pipe)
        except Exception as exc:  # noqa: BLE001
            warning(f'{NODE}: {exc}')
            update_status(store, project, NODE, 'error', pipe, message=str(exc))
            manifest = {**project.to_ref(), 'error': str(exc)}
        self._emit(manifest)

    def _scan(self, store, project: Project, pipe) -> dict:
        cfg = self.IGlobal.config
        data = load_project(store, project)
        media = data.get('media') or {}
        width, height = int(media.get('width') or 0), int(media.get('height') or 0)
        duration_ms = int(media.get('duration_ms') or 0)
        sample_ms = int(float(cfg['sample_seconds']) * 1000)
        if len(self._times) == len(self._faces):
            times = [int(round(t * 1000)) for t in self._times]
        else:
            if self._times:
                debug(f'{NODE}: {len(self._times)} frame times for {len(self._faces)} face lists — using the sample interval')
            times = [i * sample_ms for i in range(len(self._faces))]
        frames = [{'t_ms': t, 'faces': faces_from_persons(faces)} for t, faces in zip(times, self._faces)]
        update_status(store, project, NODE, 'people', pipe, frames=len(frames))
        people = people_from_samples(frames, width, height, sample_ms) if width and height else []

        local = local_source(store, data['source'])
        work = Path(tempfile.mkdtemp(prefix='podcast_visual_'))
        try:
            for person in people:
                try:
                    jpg = crop_thumbnail(local, work / f"{person['id']}.jpg", person['best_ms'], tuple(person['best_box']))
                    person['thumbnail'] = write_file(store, project.analysis(f"visual/{person['id']}.jpg"), jpg)
                except Exception as exc:  # noqa: BLE001
                    debug(f"{NODE}: no thumbnail for {person['id']}: {exc}")
            update_status(store, project, NODE, 'scenes', pipe, people=len(people))
            cuts = detect_scenes(local, float(cfg['scene_threshold'])) if bool(cfg['scenes']) else []
        finally:
            shutil.rmtree(work, ignore_errors=True)
        edges = [0] + [c for c in cuts if 0 < c < duration_ms] + [duration_ms or (times[-1] + sample_ms if times else 0)]
        scenes = [{'index': i, 'start_ms': a, 'end_ms': b} for i, (a, b) in enumerate(zip(edges, edges[1:])) if b > a]

        seconds = round(time.time() - self._t0, 1)
        write_json(store, project.analysis('visual/people.json'),
                   {'schema_version': 1, 'episode_id': project.episode_id, 'sample_ms': sample_ms, 'frames': len(frames),
                    'faces_detected_pct': round(100 * sum(1 for f in frames if f['faces']) / len(frames)) if frames else 0,
                    'width': width, 'height': height, 'people': people,
                    'method': 'stock frame_grabber + face_detection; people are clustered screen positions, not identities',
                    'scanned_at': time.time()})
        write_json(store, project.analysis('visual/scenes.json'),
                   {'schema_version': 1, 'episode_id': project.episode_id, 'cuts_ms': cuts, 'scenes': scenes,
                    'method': f"ffmpeg scene score > {cfg['scene_threshold']}", 'scanned_at': time.time()})
        data['visual'] = {'status': 'scanned', 'people': len(people), 'scenes': len(scenes), 'frames': len(frames), 'scanned_at': time.time()}
        save_project(store, project, data)
        update_status(store, project, NODE, 'scanned', pipe, people=len(people), scenes=len(scenes), frames=len(frames), seconds=seconds)
        return {**project.to_ref(), 'people': people, 'scenes': len(scenes), 'frames': len(frames), 'seconds': seconds}

    def _emit(self, payload: dict):
        answer = Answer(expectJson=True)
        answer.setAnswer(payload)
        if self.instance.hasListener('answers'):
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(payload))
