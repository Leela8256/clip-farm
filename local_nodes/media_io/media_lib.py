"""
The ffmpeg / PyAV half of media_io, kept free of engine imports so it can be
unit-tested (and read) on its own. Nothing in here knows anything about the
account store, a pipeline or an application's folder layout: paths in, paths
out.

The toolchain is the engine's own: the ffmpeg bundled with imageio_ffmpeg and
PyAV for probing — no ffprobe, no extra dependencies.
"""

from __future__ import annotations
import os
import shlex
import subprocess
from pathlib import Path

# A transcriber that flushes its buffer every 60 s stamps sentences relative to
# that buffer, so a piece must stay below one buffer for its timestamps to map
# back onto the source by a simple offset.
MAX_PIECE_SECONDS = 58
MIN_PIECE_SECONDS = 10
PIECE_RATE = 16000                 # what speech models want anyway
PIECE_CHANNELS = 1
DETECT_WIDTH = 640
DETECT_FPS = 10

MIME_BY_EXT = {'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
               '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
               '.flac': 'audio/flac'}


def mime_for(path: str | Path, default: str = 'video/mp4') -> str:
    return MIME_BY_EXT.get(Path(str(path)).suffix.lower(), default)


def ffmpeg_exe() -> str:
    exe = os.environ.get('CLIPFARM_FFMPEG')
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return 'ffmpeg'


def run_ffmpeg(args: list[str]) -> subprocess.CompletedProcess:
    cmd = [ffmpeg_exe(), '-hide_banner', '-nostdin', *args]
    try:
        return subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        tail = (exc.stderr or '').strip().splitlines()[-12:]
        raise RuntimeError(f'ffmpeg failed ({exc.returncode}): {" ".join(tail)}\ncommand: {shlex.join(cmd)}') from exc


def probe(path: str | Path) -> dict:
    """Normalized media metadata via PyAV (no ffprobe in the engine)."""
    import av

    with av.open(str(path)) as container:
        duration_ms = int(container.duration / 1000) if container.duration else 0
        video, fps = None, 0.0
        for stream in container.streams.video:
            rate = float(stream.average_rate) if stream.average_rate else 0.0
            if rate > 0:
                video, fps = stream, rate
                break
        audio = container.streams.audio[0] if container.streams.audio else None
        return {
            'has_video': video is not None,
            'has_audio': audio is not None,
            'duration_ms': duration_ms,
            'width': int(video.width) if video else 0,
            'height': int(video.height) if video else 0,
            'fps': round(fps, 3),
            'video_codec': video.codec_context.name if video else None,
            'audio_codec': audio.codec_context.name if audio else None,
            'audio_channels': int(audio.codec_context.channels) if audio else 0,
            'audio_sample_rate': int(audio.codec_context.sample_rate) if audio else 0,
            'container': container.format.name,
            'size_bytes': os.path.getsize(path),
        }


def clamp_piece_seconds(value, default: int = 45) -> int:
    try:
        seconds = int(float(value))
    except (TypeError, ValueError):
        seconds = int(default)
    return max(MIN_PIECE_SECONDS, min(MAX_PIECE_SECONDS, seconds))


def piece_name(index: int) -> str:
    return f'piece{index:04d}.wav'


def parse_range(text) -> tuple[int, int] | None:
    """'12000-18000' (ms) from the question context; None when absent or unreadable."""
    if text in (None, ''):
        return None
    parts = str(text).replace('..', '-').split('-')
    try:
        start, end = int(float(parts[0])), int(float(parts[1]))
    except (ValueError, IndexError):
        return None
    start = max(0, start)
    return (start, end) if end > start else None


def parse_ordinals(text) -> set[int]:
    """'0,1,4' -> {0, 1, 4}; anything unreadable is ignored rather than guessed at."""
    out: set[int] = set()
    for item in str(text or '').replace(';', ',').split(','):
        item = item.strip()
        if not item:
            continue
        try:
            out.add(int(float(item)))
        except (TypeError, ValueError):
            continue
    return out


def split_audio(local: Path, work: Path, piece_seconds: int) -> list[dict]:
    """
    Fixed-length mono 16 kHz WAV pieces of a recording with their exact start
    offsets. The offsets are measured (probed) rather than assumed: ffmpeg's
    segmenter cuts on frame boundaries, so a piece is rarely exactly
    `piece_seconds` long and a nominal grid would drift over an hour.
    """
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(['-y', '-i', str(local), '-vn', '-ac', str(PIECE_CHANNELS), '-ar', str(PIECE_RATE),
                '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', str(piece_seconds),
                '-reset_timestamps', '1', str(work / 'piece%04d.wav')])
    pieces, offset = [], 0
    for index, path in enumerate(sorted(work.glob('piece*.wav'))):
        duration = int(probe(path)['duration_ms'])
        pieces.append({'index': index, 'path': path, 'offset_ms': offset, 'duration_ms': duration})
        offset += duration
    return pieces


def slice_audio(src: str | Path, start_ms: int, end_ms: int, out_path: str | Path) -> Path:
    """Sample-accurate audio slice; the codec follows the extension (.wav / .mp3)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    codec = ['-c:a', 'libmp3lame', '-b:a', '128k'] if out_path.suffix == '.mp3' else ['-c:a', 'pcm_s16le']
    run_ffmpeg(['-y', '-ss', f'{start_ms / 1000:.3f}', '-t', f'{(end_ms - start_ms) / 1000:.3f}',
                '-i', str(src), '-vn', '-ar', '48000', *codec, str(out_path)])
    return out_path


def slice_video_for_detection(src: str | Path, start_ms: int, end_ms: int, out_path: str | Path,
                              width: int = DETECT_WIDTH, fps: int = DETECT_FPS) -> Path:
    """
    A small, fast-to-decode copy of an interval for frame grabbers and vision
    models: downscaled, reduced frame rate, no audio, timestamps restarting at
    0 so frame times are interval times.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    args = ['-y', '-ss', f'{start_ms / 1000:.3f}']
    if end_ms > start_ms:
        args += ['-t', f'{(end_ms - start_ms) / 1000:.3f}']
    args += ['-i', str(src), '-an', '-vf', f'scale={width}:-2,fps={fps}', '-c:v', 'libx264',
             '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(out_path)]
    run_ffmpeg(args)
    return out_path


def probe_payload(media: dict, source: str) -> dict:
    """The JSON `probe` writes and forwards: what the file is, plus where it came from."""
    return {'schema_version': 1, 'source': source,
            'duration_ms': int(media.get('duration_ms') or 0),
            'width': int(media.get('width') or 0), 'height': int(media.get('height') or 0),
            'fps': media.get('fps'), 'has_video': bool(media.get('has_video')),
            'has_audio': bool(media.get('has_audio')), 'size': int(media.get('size_bytes') or 0),
            'video_codec': media.get('video_codec'), 'audio_codec': media.get('audio_codec'),
            'audio_channels': media.get('audio_channels'), 'audio_sample_rate': media.get('audio_sample_rate'),
            'container': media.get('container'), 'size_bytes': int(media.get('size_bytes') or 0)}


def build_reference(*, source: str, mode: str, media: dict, context: dict | None = None,
                    question: str = '', streamed: list[dict] | None = None, piece_seconds: int = 0,
                    pieces_total: int = 0, skipped=None, detect: dict | None = None,
                    files: dict | None = None) -> dict:
    """
    The JSON media_io forwards on the text lane. `pieces` are the intervals of
    the SOURCE that were streamed in this run, in stream order: stream 0 is
    pieces[0], stream 1 is pieces[1] and so on, so a consumer places a
    timestamp with `pieces[stream_index][0] + in_stream_ms`. `piece_indices`
    says which ordinals of the full grid those are, for a run that skipped
    pieces a previous run already handled.
    """
    streamed = streamed or []
    ref = {
        'schema_version': 1,
        'kind': 'media_io_reference',
        'source': source,
        'mode': mode,
        'media': {k: media.get(k) for k in ('duration_ms', 'width', 'height', 'fps', 'has_video', 'has_audio')},
        'duration_ms': int(media.get('duration_ms') or 0),
        'pieces': [[int(p['offset_ms']), int(p['offset_ms']) + int(p['duration_ms'])] for p in streamed],
        'piece_indices': [int(p['index']) for p in streamed],
        'pieces_total': int(pieces_total),
        'piece_seconds': int(piece_seconds),
        'skipped': sorted(int(i) for i in (skipped or [])),
        'context': dict(context or {}),
        'question': str(question or ''),
    }
    if detect:
        ref['detect'] = dict(detect)
    if files:
        ref['files'] = dict(files)
    return ref
