"""
ffmpeg / PyAV helpers shared by the podcast nodes. Everything runs on the
engine's own toolchain: the ffmpeg bundled with imageio_ffmpeg (libx264,
libass, loudnorm) and PyAV for probing — no extra dependencies to install.

Audio and video are cut from the *same* keep-segment list with hard cuts and
10 ms de-click fades on the audio, so both streams come out the same length
and captions can be timed through one plan.
"""

from __future__ import annotations
import json
import os
import re
import shlex
import subprocess
from pathlib import Path

LAYOUTS = ('vertical', 'wide')

LOUDNESS_TARGET_LUFS = -16.0
TRUE_PEAK_DBTP = -1.0
LOUDNESS_RANGE_LU = 11.0
DECLICK_FADE_S = 0.01


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


def dims(layout: str, size: int) -> tuple[int, int]:
    """Output geometry from the long edge: vertical 9:16 (1080x1920 at 1920), wide 16:9 (1920x1080)."""
    size = int(size) // 2 * 2
    short = int(round(size * 9 / 16)) // 2 * 2
    if layout == 'vertical':
        return short, size
    if layout == 'wide':
        return size, short
    raise ValueError(f'unknown layout {layout!r}')


def slice_audio(src: str | Path, start_ms: int, end_ms: int, out_path: str | Path) -> Path:
    """Sample-accurate audio slice; codec follows the extension (.wav / .mp3)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    codec = ['-c:a', 'libmp3lame', '-b:a', '128k'] if out_path.suffix == '.mp3' else ['-c:a', 'pcm_s16le']
    run_ffmpeg(
        [
            '-y', '-ss', f'{start_ms / 1000:.3f}', '-t', f'{(end_ms - start_ms) / 1000:.3f}',
            '-i', str(src), '-vn', '-ar', '48000', *codec, str(out_path),
        ]
    )
    return out_path


_SILENCE_START = re.compile(r'silence_start:\s*([\d.]+)')
_SILENCE_END = re.compile(r'silence_end:\s*([\d.]+)')


def detect_silences(
    wav: str | Path,
    threshold_db: float = -40.0,
    min_silence_ms: int = 800,
    keep_pause_ms: int = 350,
) -> list[tuple[int, int]]:
    """
    Long silences via ffmpeg's silencedetect. Returns the *cuttable* part of
    each silence — a natural pause of keep_pause_ms is left in place so speech
    doesn't sound rushed.
    """
    cmd = [ffmpeg_exe(), '-hide_banner', '-nostdin', '-i', str(wav),
           '-af', f'silencedetect=noise={threshold_db}dB:d={min_silence_ms / 1000:.3f}', '-f', 'null', '-']
    result = subprocess.run(cmd, capture_output=True, text=True)
    starts = [float(m) for m in _SILENCE_START.findall(result.stderr)]
    ends = [float(m) for m in _SILENCE_END.findall(result.stderr)]
    cuttable = []
    pad = keep_pause_ms // 2
    for start, end in zip(starts, ends):
        cut_start = int(start * 1000) + pad
        cut_end = int(end * 1000) - pad
        if cut_end - cut_start > 100:
            cuttable.append((cut_start, cut_end))
    return cuttable


def keep_segments(cuts: list[tuple[int, int]], total_ms: int, min_keep_ms: int = 80) -> list[tuple[int, int]]:
    """Derive keep segments from cut ranges (merged, clamped to the clip)."""
    ranges = sorted((max(0, s), min(total_ms, e)) for s, e in cuts if e > s)
    merged: list[tuple[int, int]] = []
    for start, end in ranges:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    keep = []
    cursor = 0
    for start, end in merged:
        if start > cursor:
            keep.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < total_ms:
        keep.append((cursor, total_ms))
    keep = [(s, e) for s, e in keep if e - s >= min_keep_ms]
    return keep or [(0, total_ms)]


def _audio_graph(segments_ms: list[tuple[int, int]]) -> str:
    """atrim + de-click fades + concat, then the mastering chain, ending in [pre]."""
    parts = []
    for i, (start, end) in enumerate(segments_ms):
        length = (end - start) / 1000
        fade_out_at = max(0.0, length - DECLICK_FADE_S)
        parts.append(
            f'[0:a]atrim=start={start / 1000:.3f}:end={end / 1000:.3f},asetpts=PTS-STARTPTS,'
            f'afade=t=in:d={DECLICK_FADE_S},afade=t=out:st={fade_out_at:.3f}:d={DECLICK_FADE_S}[a{i}]'
        )
    n = len(segments_ms)
    if n > 1:
        parts.append(''.join(f'[a{i}]' for i in range(n)) + f'concat=n={n}:v=0:a=1[cat]')
        cat = '[cat]'
    else:
        cat = '[a0]'
    # noise reduction -> rumble highpass -> gentle compression (threshold -18 dBFS)
    parts.append(f'{cat}afftdn=nr=10:nf=-40,highpass=f=80,acompressor=threshold=0.126:ratio=2.5:attack=5:release=120[pre]')
    return ';'.join(parts)


_LOUDNORM_JSON = re.compile(r'\{[^{}]*"input_i"[^{}]*\}', re.S)


def _loudnorm_stats(stderr: str) -> dict | None:
    match = _LOUDNORM_JSON.search(stderr or '')
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def render_audio(src_wav: str | Path, segments_ms: list[tuple[int, int]], out_wav: str | Path) -> Path:
    """
    Cut, clean and master a clip's audio with ffmpeg only. Two-pass EBU R128
    loudnorm to -16 LUFS / -1 dBTP (linear when the measurement allows it,
    ffmpeg's dynamic mode otherwise).
    """
    out_wav = Path(out_wav)
    graph = _audio_graph(segments_ms)
    base = f'loudnorm=I={LOUDNESS_TARGET_LUFS}:TP={TRUE_PEAK_DBTP}:LRA={LOUDNESS_RANGE_LU}'

    measure = subprocess.run(
        [ffmpeg_exe(), '-hide_banner', '-nostdin', '-i', str(src_wav),
         '-filter_complex', f'{graph};[pre]{base}:print_format=json[out]', '-map', '[out]', '-f', 'null', '-'],
        capture_output=True, text=True,
    )
    second_pass = base
    stats = _loudnorm_stats(measure.stderr)
    if stats:
        try:
            second_pass = (
                f'{base}:measured_I={stats["input_i"]}:measured_TP={stats["input_tp"]}'
                f':measured_LRA={stats["input_lra"]}:measured_thresh={stats["input_thresh"]}'
                f':offset={stats["target_offset"]}:linear=true'
            )
        except KeyError:
            second_pass = base

    run_ffmpeg(
        ['-y', '-i', str(src_wav), '-filter_complex', f'{graph};[pre]{second_pass},aresample=48000[out]',
         '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s16le', str(out_wav)]
    )
    return out_wav


def measure_loudness(path: str | Path) -> dict | None:
    """Integrated loudness / true peak of a finished file (EBU R128, via loudnorm's analysis pass)."""
    result = subprocess.run(
        [ffmpeg_exe(), '-hide_banner', '-nostdin', '-i', str(path), '-vn',
         '-af', f'loudnorm=I={LOUDNESS_TARGET_LUFS}:TP={TRUE_PEAK_DBTP}:LRA={LOUDNESS_RANGE_LU}:print_format=json',
         '-f', 'null', '-'],
        capture_output=True, text=True,
    )
    stats = _loudnorm_stats(result.stderr)
    if not stats:
        return None
    try:
        return {
            'integrated_lufs': round(float(stats['input_i']), 1),
            'true_peak_dbtp': round(float(stats['input_tp']), 1),
            'loudness_range_lu': round(float(stats['input_lra']), 1),
        }
    except (KeyError, ValueError):
        return None


def _escape_filter_path(path: str | Path) -> str:
    text = str(path)
    for ch in ('\\', ':', "'"):
        text = text.replace(ch, '\\' + ch)
    return text


def build_video_filter(segments_ms: list[tuple[int, int]], layout: str, width: int, height: int,
                       fps: int, ass_path: str | Path | None) -> str:
    """Cut the (already clip-seeked) video into the keep segments, concat, reframe, caption."""
    frame_ms = 1000 / fps
    usable = [(s, e) for s, e in segments_ms if e - s >= frame_ms]
    if not usable:
        raise ValueError('No segment is long enough to hold a single video frame')

    n = len(usable)
    parts = [f'[0:v]fps={fps},setpts=PTS-STARTPTS,split={n}' + ''.join(f'[b{i}]' for i in range(n))]
    for i, (start, end) in enumerate(usable):
        parts.append(f'[b{i}]trim=start={start / 1000:.3f}:end={end / 1000:.3f},setpts=PTS-STARTPTS,fps={fps}[v{i}]')
    if n > 1:
        parts.append(''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0[joined]')
        current = '[joined]'
    else:
        current = '[v0]'

    if layout == 'vertical':
        # blur-pad reframe: the full frame sits on a blurred, darkened copy of itself
        parts.append(f'{current}split[fgsrc][bgsrc]')
        parts.append(
            f'[bgsrc]scale={width}:{height}:force_original_aspect_ratio=increase,'
            f'crop={width}:{height},gblur=sigma=30,eq=brightness=-0.08[bg]'
        )
        parts.append(f'[fgsrc]scale={width}:{height}:force_original_aspect_ratio=decrease[fg]')
        parts.append('[bg][fg]overlay=(W-w)/2:(H-h)/2[framed]')
    else:
        parts.append(
            f'{current}scale={width}:{height}:force_original_aspect_ratio=decrease,'
            f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2[framed]'
        )

    tail = '[framed]'
    if ass_path:
        parts.append(f"{tail}subtitles='{_escape_filter_path(ass_path)}'[captioned]")
        tail = '[captioned]'
    parts.append(f'{tail}format=yuv420p[vout]')
    return ';'.join(parts)


def render_clip_video(
    video_path: str | Path,
    clip_start_ms: int,
    clip_end_ms: int,
    segments_ms: list[tuple[int, int]],
    audio_path: str | Path,
    out_path: str | Path,
    layout: str = 'vertical',
    size: int = 1920,
    ass_path: str | Path | None = None,
    fps: int = 30,
    crf: int = 20,
    preset: str = 'veryfast',
) -> Path:
    width, height = dims(layout, size)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    graph = build_video_filter(segments_ms, layout, width, height, fps, ass_path)
    run_ffmpeg(
        [
            '-y', '-ss', f'{clip_start_ms / 1000:.3f}', '-t', f'{(clip_end_ms - clip_start_ms) / 1000:.3f}',
            '-i', str(video_path), '-i', str(audio_path),
            '-filter_complex', graph, '-map', '[vout]', '-map', '1:a',
            '-c:v', 'libx264', '-preset', preset, '-crf', str(crf), '-r', str(fps),
            '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', str(out_path),
        ]
    )
    return out_path


def thumbnail(video_path: str | Path, out_jpg: str | Path, at_ms: int = 1000) -> Path:
    out_jpg = Path(out_jpg)
    run_ffmpeg(['-y', '-ss', f'{at_ms / 1000:.3f}', '-i', str(video_path), '-frames:v', '1', '-q:v', '3', str(out_jpg)])
    return out_jpg
