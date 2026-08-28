"""
podcast_ingest — validates the episode, records media.json, and hands the
recording to the rest of the pipeline:

  text lane   the episode reference (JSON) incl. the exact start offset of
              every audio piece streamed in this run
  audio lane  the recording's audio as fixed-length 16 kHz mono WAV pieces,
              one stream per piece. The stock transcriber stamps sentences
              relative to the stream it is fed, so with pieces shorter than
              its 60 s buffer every timestamp maps back to the episode
              exactly: piece offset + in-piece time.
  video lane  the original recording as one stream (only when a listener is
              wired, e.g. frame_grabber for smart reframing)

Resumable: podcast_segment persists analysis/transcript.partial.json as pieces
come back. When a run is cut short (the engine stops a pipeline whose client
disconnects), the next run of the same project only streams the pieces that
are still missing; a project whose transcript is complete re-runs the LLM
scoring alone. Add 'fresh: yes' to the question context to transcribe again.
"""

from __future__ import annotations
import json
import shutil
import tempfile
import time
from pathlib import Path

from rocketlib import IInstanceBase, Entry, AVI_ACTION, warning, debug
from ai.common.schema import Question

from local_nodes.podcast_common.store import get_store, stream_chunks, write_json, exists
from local_nodes.podcast_common.project import (
    PARTIAL_TRANSCRIPT,
    Project,
    load_project,
    parse_context,
    question_text,
    read_json_or,
    save_project,
    update_status,
)
from local_nodes.podcast_common.config import as_bool
from local_nodes.podcast_common.media import probe, run_ffmpeg
from local_nodes.podcast_common.cache import local_source

from .IGlobal import IGlobal

NODE = 'podcast_ingest'
MIME_BY_EXT = {'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
               '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac'}


def piece_name(index: int) -> str:
    return f'piece{index:04d}.wav'


def _descriptor_payload(node, index: int, offset_ms: int, duration_ms: int) -> bytes:
    """Optional producer enrichment of the stream descriptor (the engine builds the
    authoritative one; its stream_index is what podcast_segment relies on)."""
    try:
        from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload

        doc = build_stream_descriptor(node, 'audio', resource_name=piece_name(index), origin='extracted',
                                      source_mime='audio/wav', duration=duration_ms / 1000, piece=index, offset_ms=offset_ms)
        return descriptor_to_payload(doc)
    except Exception as exc:  # noqa: BLE001
        debug(f'{NODE}: no stream descriptor for piece {index}: {exc}')
        return b''


def split_audio(local: Path, work: Path, piece_seconds: int) -> list[dict]:
    """16 kHz mono WAV pieces of the recording with their exact start offsets."""
    run_ffmpeg(['-y', '-i', str(local), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
                '-f', 'segment', '-segment_time', str(piece_seconds), '-reset_timestamps', '1',
                str(work / 'piece%04d.wav')])
    pieces, offset = [], 0
    for index, path in enumerate(sorted(work.glob('piece*.wav'))):
        duration = int(probe(path)['duration_ms'])
        pieces.append({'index': index, 'path': path, 'offset_ms': offset, 'duration_ms': duration})
        offset += duration
    return pieces


def pieces_already_done(store, project: Project, source: str, piece_seconds: int, fresh: bool) -> set[int]:
    """Piece numbers a previous run already transcribed for this source (same piece length)."""
    if fresh:
        return set()
    partial = read_json_or(store, project.analysis(PARTIAL_TRANSCRIPT), None)
    if not isinstance(partial, dict) or partial.get('source') != source:
        return set()
    if int(partial.get('piece_seconds') or 0) != int(piece_seconds):
        return set()
    return {int(i) for i in partial.get('pieces_done') or []}


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        pass

    def open(self, obj: Entry):
        self._entry = obj

    def _pipe(self) -> int | None:
        return getattr(self.instance, 'pipeId', None)

    def writeQuestions(self, question: Question):
        store = get_store()
        if store is None:
            raise RuntimeError(f'{NODE}: no account file store available for this task')

        ctx = parse_context(question)
        project_root = ctx.get('project')
        video_ref = ctx.get('video') or ctx.get('file')
        direction = question_text(question)

        # A bare "video:" reference is promoted into a project folder so every
        # downstream node has one place to read and write.
        if not project_root and video_ref:
            episode_id = f'ep_{int(time.time())}'
            project_root = f'projects/{episode_id}'
            save_project(store, Project(project_root), {'episode_id': episode_id, 'source': video_ref,
                                                         'settings': {'goal': direction}, 'created': time.time()})
        if not project_root:
            raise ValueError(f"{NODE}: add 'project: projects/<episode>' (or 'video: <store path>') to the question context")

        project = Project(project_root)
        try:
            self._ingest(store, project, ctx, direction)
        except Exception as exc:  # noqa: BLE001 — leave a readable status behind, then fail the pipe
            update_status(store, project, NODE, 'error', self._pipe(), message=str(exc))
            raise

    def _ingest(self, store, project: Project, ctx: dict, direction: str) -> None:
        data = load_project(store, project)
        source = data.get('source')
        if not source or not exists(store, source):
            raise FileNotFoundError(f'{NODE}: source recording not found: {source!r}')
        if direction and not (data.get('settings') or {}).get('goal'):
            data.setdefault('settings', {})['goal'] = direction

        cfg = self.IGlobal.config
        piece_seconds = int(cfg['piece_seconds'])
        update_status(store, project, NODE, 'probing', self._pipe(), source=source)
        local = local_source(store, source)
        media = probe(local)
        if not media['has_audio']:
            raise ValueError(f'{NODE}: the recording has no audio track')
        media['source'] = source
        media['probed'] = time.time()
        write_json(store, project.analysis('media.json'), media)
        data['media'] = {k: media[k] for k in ('duration_ms', 'width', 'height', 'fps', 'has_video')}
        data['analysis'] = {**(data.get('analysis') or {}), 'status': 'analyzing', 'started_at': time.time()}
        save_project(store, project, data)

        work = Path(tempfile.mkdtemp(prefix='podcast_ingest_'))
        try:
            pieces: list[dict] = []
            todo: list[dict] = []
            done: set[int] = set()
            if self.instance.hasListener('audio'):
                done = pieces_already_done(store, project, source, piece_seconds, as_bool(ctx.get('fresh')))
                update_status(store, project, NODE, 'splitting', self._pipe(), piece_seconds=piece_seconds, resumed=len(done))
                pieces = split_audio(local, work, piece_seconds)
                todo = [p for p in pieces if p['index'] not in done]

            ref = project.to_ref(
                source=source, settings=data.get('settings') or {}, media=data['media'],
                pieces={'seconds': piece_seconds, 'total': len(pieces), 'count': len(todo), 'resumed': len(done),
                        'indices': [p['index'] for p in todo], 'offsets_ms': [p['offset_ms'] for p in todo],
                        'durations_ms': [p['duration_ms'] for p in todo]},
            )
            if self.instance.hasListener('text'):
                self.instance.writeText(json.dumps(ref))

            if pieces:
                update_status(store, project, NODE, 'transcribing', self._pipe(), piece=len(done), pieces=len(pieces),
                              resumed=len(done), duration_ms=media['duration_ms'])
                for n, piece in enumerate(todo, start=1):
                    self.instance.writeAudio(AVI_ACTION.BEGIN, 'audio/wav',
                                             _descriptor_payload(self, piece['index'], piece['offset_ms'], piece['duration_ms']))
                    try:
                        with open(piece['path'], 'rb') as f:
                            while True:
                                chunk = f.read(cfg['chunk_bytes'])
                                if not chunk:
                                    break
                                self.instance.writeAudio(AVI_ACTION.WRITE, 'audio/wav', chunk)
                    finally:
                        self.instance.writeAudio(AVI_ACTION.END, 'audio/wav', b'')
                    # one small status write per piece: the UI shows live progress and a
                    # reloaded page can tell a slow run from a dead one
                    update_status(store, project, NODE, 'transcribing', self._pipe(), piece=len(done) + n,
                                  pieces=len(pieces), resumed=len(done), duration_ms=media['duration_ms'])
                if not todo:
                    debug(f'{NODE}: transcript already complete for {source} — only the scoring runs')

            if self.instance.hasListener('video'):
                mime = MIME_BY_EXT.get(Path(source).suffix.lower(), 'video/mp4')
                update_status(store, project, NODE, 'streaming', self._pipe(), mime=mime, bytes=media['size_bytes'])
                sent = 0
                self.instance.writeVideo(AVI_ACTION.BEGIN, mime, b'')
                try:
                    for chunk in stream_chunks(store, source, cfg['chunk_bytes']):
                        self.instance.writeVideo(AVI_ACTION.WRITE, mime, chunk)
                        sent += len(chunk)
                finally:
                    self.instance.writeVideo(AVI_ACTION.END, mime, b'')
                update_status(store, project, NODE, 'streamed', self._pipe(), bytes=sent)
            elif not pieces:
                warning(f'{NODE}: no audio/video listener wired — only the episode reference was forwarded')
        finally:
            shutil.rmtree(work, ignore_errors=True)
