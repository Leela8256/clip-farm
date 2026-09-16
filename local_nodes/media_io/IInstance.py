"""
media_io — the front door of a media pipeline: it reads one file from the
account store and hands it to the rest of the pipeline in the shape the next
node needs.

Everything it touches is named in the question context; the node knows nothing
about the caller's folder layout.

  source:        store path of the recording                       (required)
  mode:          auto | probe | transcribe_feed | detect_copy | slice
  range:         <a>-<b> in ms (slice / detect_copy)
  piece_seconds: length of a transcriber piece (10-58, default 45)
  skip_pieces:   ordinals a previous run already handled ('0,1,2')
  detect_width:  width of the detection copy (default 640)
  detect_fps:    frame rate of the detection copy (default 10)
  video:         yes | no — also write a video slice in `slice` mode
  write_to:      store path for the probe JSON, or the prefix for slices
  status_to:     store path for the progress file (absent -> SSE only)

Lanes

  text   a reference JSON: what the file is, which intervals were streamed on
         the audio lane (in stream order) and the caller's own context keys,
         echoed back so the nodes behind media_io can read them.
  audio  in `transcribe_feed`: the recording as fixed-length 16 kHz mono WAV
         pieces, ONE STREAM PER PIECE. A transcriber stamps sentences relative
         to the stream it was fed, so with pieces shorter than its flush buffer
         every timestamp maps back onto the source exactly: the piece's offset
         (from the reference) plus the in-piece time, keyed by the engine's
         running metadata.source.stream_index.
  video  in `detect_copy`: a small, low-frame-rate copy (640 px / 10 fps by
         default) for frame grabbers and vision models, with timestamps
         restarting at 0.
"""

from __future__ import annotations
import json
import shutil
import tempfile
import time
from pathlib import Path

from rocketlib import IInstanceBase, Entry, AVI_ACTION, warning, debug
from ai.common.schema import Question

from local_nodes.podcast_common.store import exists, get_store, write_file, write_json
from local_nodes.podcast_common.cache import local_source
from local_nodes.podcast_common.config import as_bool

from .media_lib import (
    build_reference,
    clamp_piece_seconds,
    mime_for,
    parse_ordinals,
    parse_range,
    piece_name,
    probe,
    probe_payload,
    slice_audio,
    slice_video_for_detection,
    split_audio,
)
from .IGlobal import IGlobal

NODE = 'media_io'
MODES = ('auto', 'probe', 'transcribe_feed', 'detect_copy', 'slice')

try:
    from rocketlib.engine import monitorSSE
except Exception:  # noqa: BLE001
    monitorSSE = None


def question_text(question) -> str:
    """The caller's own question, echoed in the reference for the nodes behind this one."""
    items = getattr(question, 'questions', None) or []
    return (getattr(items[0], 'text', '') or '').strip() if items else ''


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


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        pass

    def open(self, obj: Entry):
        self._entry = obj

    # ---------------------------------------------------------------- progress

    def _pipe(self):
        return getattr(self.instance, 'pipeId', None)

    def _status(self, store, status_to: str | None, stage: str, **data) -> None:
        """The progress line: a file for a client that reloads, an SSE event for one that is watching."""
        payload = {'node': NODE, 'stage': stage, 'time': time.time(), **data}
        if store is not None and status_to:
            try:
                write_json(store, status_to, payload)
            except Exception as exc:  # noqa: BLE001
                debug(f'{NODE}: could not write {status_to}: {exc}')
        pipe = self._pipe()
        if monitorSSE is not None and pipe is not None:
            try:
                monitorSSE(pipe, 'podcast', payload)
            except Exception:  # noqa: BLE001
                pass
        debug(f'{NODE}: {stage} {json.dumps(data, default=str)[:160]}')

    # ------------------------------------------------------------------ inputs

    def writeQuestions(self, question: Question):
        store = get_store()
        if store is None:
            raise RuntimeError(f'{NODE}: no account file store available for this task')
        ctx = parse_context(question)
        source = (ctx.get('source') or '').strip()
        status_to = (ctx.get('status_to') or '').strip() or None
        if not source:
            raise ValueError(f"{NODE}: add 'source: <store path>' to the question context")
        try:
            self._run(store, ctx, source, status_to, question_text(question))
        except Exception as exc:  # noqa: BLE001 — leave a readable status behind, then fail the pipe
            self._status(store, status_to, 'error', source=source, message=str(exc))
            raise

    def _mode(self, ctx: dict) -> str:
        mode = str(ctx.get('mode') or self.IGlobal.config['mode'] or 'auto').strip().lower()
        if mode not in MODES:
            warning(f'{NODE}: unknown mode {mode!r} — falling back to auto')
            mode = 'auto'
        if mode != 'auto':
            return mode
        if self.instance.hasListener('audio'):
            return 'transcribe_feed'
        if self.instance.hasListener('video'):
            return 'detect_copy'
        return 'probe'

    def _run(self, store, ctx: dict, source: str, status_to: str | None, question: str = '') -> None:
        cfg = self.IGlobal.config
        mode = self._mode(ctx)
        write_to = (ctx.get('write_to') or '').strip() or None
        if not exists(store, source):
            raise FileNotFoundError(f'{NODE}: source not found in the store: {source!r}')

        self._status(store, status_to, 'probing', source=source, mode=mode)
        local = local_source(store, source)
        media = probe(local)
        payload = probe_payload(media, source)
        # every mode but `slice` (where write_to names the slices) records the
        # probe, so a caller gets the numbers from whichever mode it runs
        if write_to and mode != 'slice':
            write_json(store, write_to, {**payload, 'probed': time.time()})

        if mode == 'slice':
            self._slice(store, ctx, source, local, media, write_to, status_to, question)
            return

        work = Path(tempfile.mkdtemp(prefix='media_io_'))
        try:
            streamed: list[dict] = []
            pieces: list[dict] = []
            skipped: set[int] = set()
            piece_seconds = clamp_piece_seconds(ctx.get('piece_seconds') or cfg['piece_seconds'])
            detect = None

            if mode == 'transcribe_feed':
                if not media['has_audio']:
                    raise ValueError(f'{NODE}: the recording has no audio track')
                skipped = parse_ordinals(ctx.get('skip_pieces'))
                self._status(store, status_to, 'splitting', source=source, piece_seconds=piece_seconds,
                             resumed=len(skipped))
                pieces = split_audio(local, work, piece_seconds)
                streamed = [p for p in pieces if p['index'] not in skipped]
            elif mode == 'detect_copy':
                detect = {'width': int(float(ctx.get('detect_width') or cfg['detect_width'])),
                          'fps': int(float(ctx.get('detect_fps') or cfg['detect_fps'])),
                          'source_width': int(media.get('width') or 0),
                          'source_height': int(media.get('height') or 0)}

            ref = build_reference(source=source, mode=mode, media=media, context=ctx, question=question,
                                  streamed=streamed,
                                  piece_seconds=piece_seconds if mode == 'transcribe_feed' else 0,
                                  pieces_total=len(pieces), skipped=skipped, detect=detect)
            if self.instance.hasListener('text'):
                self.instance.writeText(json.dumps(ref))

            if mode == 'transcribe_feed':
                self._feed(store, status_to, streamed, len(pieces), len(skipped), media, cfg['chunk_bytes'])
            elif mode == 'detect_copy':
                self._detect_copy(store, ctx, local, media, detect, status_to, work)
            elif not self.instance.hasListener('text'):
                warning(f'{NODE}: nothing is wired to this node — the probe was written and nothing streamed')
        finally:
            shutil.rmtree(work, ignore_errors=True)

    # ------------------------------------------------------------------ modes

    def _feed(self, store, status_to, streamed: list[dict], total: int, resumed: int, media: dict,
              chunk_bytes: int) -> None:
        """One WAV piece per stream, in order — the stream index IS the piece's place in `pieces`."""
        if not self.instance.hasListener('audio'):
            warning(f'{NODE}: no audio listener wired — only the reference was forwarded')
            return
        self._status(store, status_to, 'transcribing', piece=resumed, pieces=total, resumed=resumed,
                     duration_ms=media['duration_ms'])
        for n, piece in enumerate(streamed, start=1):
            self.instance.writeAudio(AVI_ACTION.BEGIN, 'audio/wav',
                                     self._descriptor(piece['index'], piece['offset_ms'], piece['duration_ms']))
            try:
                with open(piece['path'], 'rb') as f:
                    while True:
                        chunk = f.read(chunk_bytes)
                        if not chunk:
                            break
                        self.instance.writeAudio(AVI_ACTION.WRITE, 'audio/wav', chunk)
            finally:
                self.instance.writeAudio(AVI_ACTION.END, 'audio/wav', b'')
            # one small status write per piece: a watching client sees live
            # progress and a reloaded one can tell a slow run from a dead one
            self._status(store, status_to, 'transcribing', piece=resumed + n, pieces=total, resumed=resumed,
                         duration_ms=media['duration_ms'])
        if not streamed:
            debug(f'{NODE}: every piece was skipped — nothing was streamed')

    def _descriptor(self, index: int, offset_ms: int, duration_ms: int) -> bytes:
        """Optional producer enrichment of the stream descriptor (the engine builds the
        authoritative one; its stream_index is what a consumer relies on)."""
        try:
            from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload

            doc = build_stream_descriptor(self, 'audio', resource_name=piece_name(index), origin='extracted',
                                          source_mime='audio/wav', duration=duration_ms / 1000, piece=index,
                                          offset_ms=offset_ms)
            return descriptor_to_payload(doc)
        except Exception as exc:  # noqa: BLE001
            debug(f'{NODE}: no stream descriptor for piece {index}: {exc}')
            return b''

    def _detect_copy(self, store, ctx: dict, local: Path, media: dict, detect: dict, status_to, work: Path) -> None:
        """A small copy of the recording (or of `range:`) on the video lane, timestamps from 0."""
        if not self.instance.hasListener('video'):
            warning(f'{NODE}: no video listener wired — only the reference was forwarded')
            return
        if not media['has_video']:
            raise ValueError(f'{NODE}: the recording has no video track')
        span = parse_range(ctx.get('range')) or (0, int(media['duration_ms']))
        self._status(store, status_to, 'streaming', width=detect['width'], fps=detect['fps'],
                     start_ms=span[0], end_ms=span[1])
        copy = slice_video_for_detection(local, span[0], span[1], work / 'detect.mp4',
                                         width=detect['width'], fps=detect['fps'])
        sent = self._stream_video(copy, detect, span[1] - span[0], media)
        self._status(store, status_to, 'streamed', bytes=sent, width=detect['width'], fps=detect['fps'])

    def _stream_video(self, path: Path, detect: dict, duration_ms: int, media: dict) -> int:
        try:
            from ai.common.avi.descriptor import video_begin_payload

            width, height = int(media.get('width') or 0), int(media.get('height') or 0)
            det_h = int(round(detect['width'] * height / width)) // 2 * 2 if width and height else None
            payload = video_begin_payload(None, size=path.stat().st_size, duration=duration_ms / 1000,
                                          fps=detect['fps'], width=detect['width'], height=det_h,
                                          name=path.name, origin='extracted')
        except Exception as exc:  # noqa: BLE001
            debug(f'{NODE}: no video descriptor: {exc}')
            payload = b''
        mime = mime_for(path)
        sent = 0
        self.instance.writeVideo(AVI_ACTION.BEGIN, mime, payload)
        try:
            with open(path, 'rb') as f:
                while True:
                    chunk = f.read(self.IGlobal.config['chunk_bytes'])
                    if not chunk:
                        break
                    self.instance.writeVideo(AVI_ACTION.WRITE, mime, chunk)
                    sent += len(chunk)
        finally:
            self.instance.writeVideo(AVI_ACTION.END, mime, b'')
        return sent

    def _slice(self, store, ctx: dict, source: str, local: Path, media: dict, write_to: str | None,
               status_to, question: str = '') -> None:
        """`range:` decoded to store files the caller named, and reported on the text lane."""
        span = parse_range(ctx.get('range'))
        if span is None:
            raise ValueError(f"{NODE}: slice needs 'range: <start_ms>-<end_ms>' in the question context")
        if not write_to:
            raise ValueError(f"{NODE}: slice needs 'write_to: <store path prefix>' in the question context")
        prefix = write_to[:-1] if write_to.endswith('/') else write_to
        want_video = as_bool(ctx.get('video'), False) and bool(media['has_video'])
        work = Path(tempfile.mkdtemp(prefix='media_io_slice_'))
        files: dict[str, str] = {}
        try:
            self._status(store, status_to, 'slicing', source=source, start_ms=span[0], end_ms=span[1],
                         video=want_video)
            wav = slice_audio(local, span[0], span[1], work / 'slice.wav')
            files['audio'] = write_file(store, f'{prefix}.wav', wav)
            if want_video:
                detect_width = int(float(ctx.get('detect_width') or self.IGlobal.config['detect_width']))
                detect_fps = int(float(ctx.get('detect_fps') or self.IGlobal.config['detect_fps']))
                mp4 = slice_video_for_detection(local, span[0], span[1], work / 'slice.mp4',
                                                width=detect_width, fps=detect_fps)
                files['video'] = write_file(store, f'{prefix}.mp4', mp4)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        ref = build_reference(source=source, mode='slice', media=media, context=ctx, question=question,
                              files=files)
        ref['range'] = [span[0], span[1]]
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(ref))
        self._status(store, status_to, 'sliced', files=sorted(files), start_ms=span[0], end_ms=span[1])
