"""
Project directory layout in the account file store (from the implementation
brief) plus status/progress helpers shared by every podcast_* node.

projects/<episode>/
  source/<file>           original upload
  analysis/media.json, transcript.json, windows.json, candidates.json, chapters.json
  analysis/clips/<id>.json  prepared clip spec (boundaries, words, cuts)
  previews/<id>.mp4       fast 9:16 preview + <id>.json report
  exports/<id>/...        final renders, SRT/VTT, thumbnail, report.json
  edits/clip-edits.json   non-destructive edits written by the UI
  project.json            settings + provenance — reopening it rebuilds the workspace
  status.json             latest stage, written by every node as it works
"""

from __future__ import annotations
import json
import time
from typing import Any

from rocketlib import debug

from .store import read_json, write_json

try:
    from rocketlib.engine import monitorSSE
except Exception:  # noqa: BLE001
    monitorSSE = None

SCHEMA_VERSION = 1
PARTIAL_TRANSCRIPT = 'transcript.partial.json'


class Project:
    def __init__(self, root: str):
        self.root = root.strip('/')
        self.episode_id = self.root.rsplit('/', 1)[-1]

    @property
    def project_json(self) -> str:
        return f'{self.root}/project.json'

    @property
    def status_json(self) -> str:
        return f'{self.root}/status.json'

    def analysis(self, name: str) -> str:
        return f'{self.root}/analysis/{name}'

    def clip_spec(self, clip_id: str) -> str:
        return f'{self.root}/analysis/clips/{clip_id}.json'

    def previews(self, name: str) -> str:
        return f'{self.root}/previews/{name}'

    def exports(self, name: str) -> str:
        return f'{self.root}/exports/{name}'

    def edits(self, name: str) -> str:
        return f'{self.root}/edits/{name}'

    def to_ref(self, **extra) -> dict:
        return {'project': self.root, 'episode_id': self.episode_id, **extra}


def parse_ref(text: str) -> dict | None:
    """A JSON episode reference travelling on a text lane ({"project": ...})."""
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get('project') else None


def parse_context(question) -> dict[str, str]:
    """'key: value' lines from a chat question's context, keys lower-cased."""
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


def question_text(question) -> str:
    items = getattr(question, 'questions', None) or []
    return (getattr(items[0], 'text', '') or '').strip() if items else ''


def load_project(store, project: Project) -> dict:
    return read_json(store, project.project_json)


def save_project(store, project: Project, data: dict) -> None:
    data['schema_version'] = SCHEMA_VERSION
    data['updated'] = time.time()
    write_json(store, project.project_json, data)


def read_json_or(store, path: str, default: Any) -> Any:
    try:
        return read_json(store, path)
    except Exception:  # noqa: BLE001
        return default


def update_status(store, project: Project | None, node: str, stage: str, pipe_id: int | None = None, **data: Any) -> None:
    """Write status.json (so a reloaded UI can catch up) and push an SSE event."""
    payload = {'node': node, 'stage': stage, 'time': time.time(), **data}
    if project is not None:
        payload['episode_id'] = project.episode_id
        try:
            write_json(store, project.status_json, payload)
        except Exception as exc:  # noqa: BLE001
            debug(f'{node}: could not write status.json: {exc}')
    if monitorSSE is not None and pipe_id is not None:
        try:
            monitorSSE(pipe_id, 'podcast', payload)
        except Exception:  # noqa: BLE001
            pass
    debug(f'{node}: {stage} {json.dumps(data, default=str)[:160]}')
