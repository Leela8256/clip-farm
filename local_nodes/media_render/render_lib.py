"""
media_render's ffmpeg / PyAV library: every graph, encode and measurement the
node performs. Nothing here knows about a store, a project or an application —
it takes local paths, millisecond timelines and plain dicts.

Everything runs on the engine's own toolchain: the ffmpeg bundled with
imageio_ffmpeg (libx264, libass, loudnorm) and PyAV for probing — no extra
dependencies to install.

Audio and video are cut from the *same* keep-segment list with hard cuts and
10 ms de-click fades on the audio, so both streams come out the same length
and captions can be timed through one plan.

(In this repository `podcast_common/media.py` re-exports this module, so the
older import path keeps working.)
"""

from __future__ import annotations
import json
import os
import re
import shlex
import subprocess
from pathlib import Path

LAYOUTS = ('vertical', 'wide')

# The shapes a clip can be rendered in. 'vertical' and 'wide' are the two
# render passes; an aspect narrows what the vertical pass actually produces
# (9:16 as always, or 4:5 / 1:1 for the feed formats).
CLIP_ASPECTS = ('9:16', '4:5', '1:1', '16:9')

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


_DURATION_RE = re.compile(r'Duration:\s*(\d+):(\d+):(\d+\.?\d*)')
_VIDEO_RE = re.compile(r'Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+)', re.S)
_FPS_RE = re.compile(r'([\d.]+) fps')
_AUDIO_RE = re.compile(r'Stream #\d+:\d+.*?: Audio: (\w+).*?, (\d+) Hz, (\w+[\d.]*)')
_FORMAT_RE = re.compile(r'Input #0, ([^,]+(?:,[^,]+)*), from')
_CHANNEL_NAMES = {'mono': 1, 'stereo': 2, 'quad': 4, '5.0': 5, '5.1': 6, '7.1': 8}


def _probe_ffmpeg(path: str | Path) -> dict:
    """
    The same metadata read from `ffmpeg -i` output. Only used where PyAV is not
    installed (the engine always has it — it is in requirements.txt); it keeps
    the node runnable, and testable, on a bare toolchain.
    """
    text = subprocess.run([ffmpeg_exe(), '-hide_banner', '-nostdin', '-i', str(path)],
                          capture_output=True, text=True).stderr or ''
    duration_ms = 0
    match = _DURATION_RE.search(text)
    if match:
        duration_ms = int((int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))) * 1000)
    video = _VIDEO_RE.search(text)
    fps = 0.0
    if video:
        line = text[video.start():text.find('\n', video.start())]
        rate = _FPS_RE.search(line)
        fps = float(rate.group(1)) if rate else 0.0
    audio = _AUDIO_RE.search(text)
    fmt = _FORMAT_RE.search(text)
    return {
        'has_video': bool(video),
        'has_audio': bool(audio),
        'duration_ms': duration_ms,
        'width': int(video.group(2)) if video else 0,
        'height': int(video.group(3)) if video else 0,
        'fps': round(fps, 3),
        'video_codec': video.group(1) if video else None,
        'audio_codec': audio.group(1) if audio else None,
        'audio_channels': _CHANNEL_NAMES.get(audio.group(3), 2) if audio else 0,
        'audio_sample_rate': int(audio.group(2)) if audio else 0,
        'container': fmt.group(1) if fmt else '',
        'size_bytes': os.path.getsize(path),
    }


def probe(path: str | Path) -> dict:
    """Normalized media metadata via PyAV (no ffprobe in the engine)."""
    try:
        import av
    except ImportError:
        return _probe_ffmpeg(path)

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
    """
    Output geometry for a clip from the vertical long edge: vertical 9:16
    (1080x1920 at 1920) and wide 16:9 (1920x1080) as always, plus the two feed
    shapes, which keep the portrait WIDTH so a preview scales proportionally:
    4:5 -> 1080x1350 and 1:1 -> 1080x1080 at 1920, 540x674 / 540x540 at 960.
    """
    size = int(size) // 2 * 2
    short = int(round(size * 9 / 16)) // 2 * 2
    if layout in ('vertical', '9:16'):
        return short, size
    if layout in ('wide', '16:9'):
        return size, short
    if layout == '4:5':
        return short, int(round(short * 5 / 4)) // 2 * 2
    if layout == '1:1':
        return short, short
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


def _audio_graph(segments_ms: list[tuple[int, int]], mutes_ms: list[tuple[int, int]] | None = None) -> str:
    """
    atrim + de-click fades + concat, then the mastering chain, ending in [pre].
    Muted ranges (a filler kept in the picture but silenced) are zeroed on the
    source timeline before the cuts, with tiny ramps so the mute never clicks.
    """
    parts = []
    n = len(segments_ms)
    source = '[0:a]'
    if mutes_ms:
        ramp = DECLICK_FADE_S
        volume = ','.join(
            f"volume=enable='between(t,{s / 1000:.3f},{e / 1000:.3f})':volume=0:eval=frame"
            for s, e in mutes_ms if e > s
        )
        parts.append(f'[0:a]{volume},asplit={n}' + ''.join(f'[m{i}]' for i in range(n)))
        source = None
        del ramp
    for i, (start, end) in enumerate(segments_ms):
        length = (end - start) / 1000
        fade_out_at = max(0.0, length - DECLICK_FADE_S)
        src = source if source else f'[m{i}]'
        parts.append(
            f'{src}atrim=start={start / 1000:.3f}:end={end / 1000:.3f},asetpts=PTS-STARTPTS,'
            f'afade=t=in:d={DECLICK_FADE_S},afade=t=out:st={fade_out_at:.3f}:d={DECLICK_FADE_S}[a{i}]'
        )
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


def render_audio(src_wav: str | Path, segments_ms: list[tuple[int, int]], out_wav: str | Path,
                 mutes_ms: list[tuple[int, int]] | None = None,
                 loudness_lufs: float = LOUDNESS_TARGET_LUFS,
                 true_peak: float = TRUE_PEAK_DBTP) -> Path:
    """
    Cut, clean and master a short piece of audio with ffmpeg only. Two-pass EBU
    R128 loudnorm to -16 LUFS / -1 dBTP (linear when the measurement allows it,
    ffmpeg's dynamic mode otherwise).
    """
    out_wav = Path(out_wav)
    graph = _audio_graph(segments_ms, mutes_ms)
    base = f'loudnorm=I={float(loudness_lufs)}:TP={float(true_peak)}:LRA={LOUDNESS_RANGE_LU}'

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


def loudnorm_filter(target_lufs: float = LOUDNESS_TARGET_LUFS, stats: dict | None = None,
                    true_peak: float = TRUE_PEAK_DBTP) -> str:
    """
    The loudnorm filter string. Without `stats` it is the measurement (first)
    pass; with the first pass's JSON it is the linear second pass that actually
    lands on the target.
    """
    base = f'loudnorm=I={float(target_lufs)}:TP={float(true_peak)}:LRA={LOUDNESS_RANGE_LU}'
    if not stats:
        return base
    try:
        return (f'{base}:measured_I={stats["input_i"]}:measured_TP={stats["input_tp"]}'
                f':measured_LRA={stats["input_lra"]}:measured_thresh={stats["input_thresh"]}'
                f':offset={stats["target_offset"]}:linear=true')
    except KeyError:
        return base


def master_wav(src_wav: str | Path, out_wav: str | Path, *, loudness_lufs: float = LOUDNESS_TARGET_LUFS,
               channels: int = 2, true_peak: float = TRUE_PEAK_DBTP) -> Path:
    """
    Two-pass EBU R128 mastering of a COMPLETE programme (intro, cards, body,
    outro — everything already joined). Nothing may be added to the audio after
    this or the finished file misses the target.
    """
    src_wav, out_wav = Path(src_wav), Path(out_wav)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    base = loudnorm_filter(loudness_lufs, true_peak=true_peak)
    measure = subprocess.run(
        [ffmpeg_exe(), '-hide_banner', '-nostdin', '-i', str(src_wav), '-vn',
         '-af', f'{base}:print_format=json', '-f', 'null', '-'],
        capture_output=True, text=True,
    )
    second = loudnorm_filter(loudness_lufs, _loudnorm_stats(measure.stderr), true_peak=true_peak)
    run_ffmpeg(['-y', '-i', str(src_wav), '-vn', '-af', f'{second},aresample=48000',
                '-ar', '48000', '-ac', str(int(channels)), '-c:a', 'pcm_s16le', str(out_wav)])
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


_RMS_RE = re.compile(r'RMS level dB:\s*(-?[\d.]+|-inf)')


def rms_level(path: str | Path, at_ms: int, window_ms: int = 60) -> float | None:
    """RMS level (dBFS) of a short window starting at at_ms; None when unmeasurable."""
    if at_ms < 0:
        return None
    result = subprocess.run(
        [ffmpeg_exe(), '-hide_banner', '-nostdin', '-ss', f'{at_ms / 1000:.3f}', '-t', f'{window_ms / 1000:.3f}',
         '-i', str(path), '-af', 'astats=metadata=0:measure_perchannel=none:measure_overall=RMS_level', '-f', 'null', '-'],
        capture_output=True, text=True,
    )
    values = _RMS_RE.findall(result.stderr or '')
    if not values:
        return None
    value = values[-1]
    return -120.0 if value == '-inf' else float(value)


def measure_levels(path: str | Path, ranges: list[tuple[int, int]], window_ms: int = 60) -> dict[int, float]:
    """
    The loudness just before and just after each cut range, keyed by the
    range's start (level before) and end (level after) in ms — what the cut
    safety check compares to refuse joins across a loudness step.
    """
    levels: dict[int, float] = {}
    for start, end in ranges:
        before = rms_level(path, start - window_ms, window_ms)
        after = rms_level(path, end, window_ms)
        if before is not None:
            levels[int(start)] = before
        if after is not None:
            levels[int(end)] = after
    return levels


def _escape_filter_path(path: str | Path) -> str:
    text = str(path)
    for ch in ('\\', ':', "'"):
        text = text.replace(ch, '\\' + ch)
    return text


def build_video_filter(segments_ms: list[tuple[int, int]], layout: str, width: int, height: int,
                       fps: int, ass_path: str | Path | None, logo: dict | None = None,
                       logo_input: int = 2) -> str:
    """Cut the (already clip-seeked) video into the keep segments, concat, reframe, brand, caption."""
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

    if layout in ('vertical', '9:16', '4:5', '1:1'):
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
    if logo:
        parts.extend(logo_chain(logo, width, height, logo_input, tail, '[logoed]'))
        tail = '[logoed]'
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
    logo: dict | None = None,
    logo_path: str | Path | None = None,
    width: int | None = None,
    height: int | None = None,
) -> Path:
    # `layout` still decides the reframe STYLE (blur-pad for portrait shapes,
    # letterbox for wide); an explicit width/height overrides its geometry.
    width, height = (int(width), int(height)) if (width and height) else dims(layout, size)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    use_logo = logo if (logo and logo_path) else None
    graph = build_video_filter(segments_ms, layout, width, height, fps, ass_path, logo=use_logo, logo_input=2)
    seconds = (clip_end_ms - clip_start_ms) / 1000
    brand = ['-loop', '1', '-framerate', str(fps), '-t', f'{seconds:.3f}', '-i', str(logo_path)] if use_logo else []
    run_ffmpeg(
        [
            '-y', '-ss', f'{clip_start_ms / 1000:.3f}', '-t', f'{(clip_end_ms - clip_start_ms) / 1000:.3f}',
            '-i', str(video_path), '-i', str(audio_path), *brand,
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


# ------------------------------------------------------------ visual director

DETECT_WIDTH = 640
DETECT_FPS = 10
_SCENE_PTS = re.compile(r'pts_time:\s*([0-9.]+)')


def detect_scenes(path: str | Path, threshold: float = 0.35, scale_width: int = 320) -> list[int]:
    """Shot changes (ms) via ffmpeg's scene score on a downscaled decode of the whole file."""
    result = subprocess.run(
        [ffmpeg_exe(), '-hide_banner', '-nostdin', '-i', str(path), '-an',
         '-vf', f"scale={scale_width}:-2,select='gt(scene,{threshold})',showinfo", '-f', 'null', '-'],
        capture_output=True, text=True,
    )
    cuts = []
    for line in (result.stderr or '').splitlines():
        if 'Parsed_showinfo' not in line:
            continue
        m = _SCENE_PTS.search(line)
        if m:
            cuts.append(int(float(m.group(1)) * 1000))
    return sorted(set(cuts))


def slice_video_for_detection(src: str | Path, start_ms: int, end_ms: int, out_path: str | Path,
                              width: int = DETECT_WIDTH, fps: int = DETECT_FPS) -> Path:
    """
    A small, fast-to-decode copy of the clip interval for the stock frame
    grabber + face detector: downscaled, reduced frame rate, no audio,
    timestamps restarting at 0 so frame times are clip times.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(['-y', '-ss', f'{start_ms / 1000:.3f}', '-t', f'{(end_ms - start_ms) / 1000:.3f}', '-i', str(src),
                '-an', '-vf', f'scale={width}:-2,fps={fps}', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(out_path)])
    return out_path


def crop_thumbnail(video_path: str | Path, out_jpg: str | Path, at_ms: int, box: tuple[int, int, int, int],
                   pad: float = 0.6, size: int = 160) -> Path:
    """A square face thumbnail around a box (source pixels) at a given time."""
    x, y, w, h = box
    side = int(max(w, h) * (1 + 2 * pad))
    cx, cy = x + w / 2, y + h / 2
    out_jpg = Path(out_jpg)
    run_ffmpeg(['-y', '-ss', f'{at_ms / 1000:.3f}', '-i', str(video_path), '-frames:v', '1',
                '-vf', f"crop={side}:{side}:{int(cx - side / 2)}:{int(cy - side / 2)}:exact=1,scale={size}:{size}",
                '-q:v', '4', str(out_jpg)])
    return out_jpg


def _interp(keyframes: list[list[int]], t_ms: float) -> tuple[float, float]:
    """Linear interpolation of [t, x, y] keyframes."""
    if t_ms <= keyframes[0][0]:
        return keyframes[0][1], keyframes[0][2]
    for a, b in zip(keyframes, keyframes[1:]):
        if a[0] <= t_ms <= b[0]:
            span = max(1, b[0] - a[0])
            f = (t_ms - a[0]) / span
            return a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f
    return keyframes[-1][1], keyframes[-1][2]


def write_pan_commands(path: str | Path, target: str, keyframes: list[list[int]], start_ms: int, end_ms: int,
                       fps: int, max_x: int, max_y: int) -> Path:
    """
    A sendcmd file moving one crop window frame by frame (times relative to
    the piece start). The last keyframe holds to the end.
    """
    path = Path(path)
    lines = []
    frames = int(round((end_ms - start_ms) / 1000 * fps)) + 1
    for k in range(frames):
        t = k / fps
        x, y = _interp(keyframes, start_ms + t * 1000)
        x = int(round(max(0, min(max_x, x))))
        y = int(round(max(0, min(max_y, y))))
        lines.append(f'{t:.4f} {target} x {x}, {target} y {y};')
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return path


def _escape_cmd_path(path: str | Path) -> str:
    return _escape_filter_path(path)


def build_layout_graph(pieces: list[dict], layout: dict, width: int, height: int, fps: int,
                       ass_path: str | Path | None, work: Path, logo: dict | None = None,
                       logo_input: int = 2) -> str:
    """
    The video filter graph for a layout plan: each piece (a keep segment
    intersected with a layout segment, in clip time) is trimmed from the
    decoded clip, reframed by its layout — crops driven per frame by sendcmd
    files written next to the graph — scaled to the canvas and concatenated;
    captions and pixel format last.
    """
    out_w, out_h = int(layout['canvas']['width']), int(layout['canvas']['height'])
    paths = layout.get('paths') or []
    parts = [f'[0:v]fps={fps},setpts=PTS-STARTPTS,split={len(pieces)}' + ''.join(f'[b{i}]' for i in range(len(pieces)))]
    outs = []
    for i, piece in enumerate(pieces):
        s, e = piece['start_ms'], piece['end_ms']
        seg = piece['segment']
        layout_name = seg['layout']
        base = f'[b{i}]trim=start={s / 1000:.3f}:end={e / 1000:.3f},setpts=PTS-STARTPTS'
        seg_paths = [p for p in paths if p['segment'] == piece['segment_index']]

        def pan_chain(p: dict, label: str, panel_w: int, panel_h: int) -> str:
            cmd = write_pan_commands(work / f'pan_{i}_{label}.cmd', f'crop@{label}', p['keyframes'], s, e, fps,
                                     width - p['w'], height - p['h'])
            x0, y0 = _interp(p['keyframes'], s)
            return (f"sendcmd=f='{_escape_cmd_path(cmd)}',crop@{label}={p['w']}:{p['h']}:{int(x0)}:{int(y0)}:exact=1,"
                    f'scale={panel_w}:{panel_h}')

        if layout_name == 'solo_follow' and seg_paths:
            parts.append(f'{base},{pan_chain(seg_paths[0], f"p{i}a", out_w, out_h)}[v{i}]')
        elif layout_name in ('stacked_two', 'side_by_side') and len(seg_paths) >= 2:
            a, b = seg_paths[0], seg_paths[1]
            if layout_name == 'stacked_two':
                pw, ph, join = out_w, out_h // 2, 'vstack'
            else:
                pw, ph, join = out_w // 2, out_h, 'hstack'
            parts.append(f'{base},split[s{i}a][s{i}b]')
            parts.append(f'[s{i}a]{pan_chain(a, f"p{i}a", pw, ph)}[t{i}a]')
            parts.append(f'[s{i}b]{pan_chain(b, f"p{i}b", pw, ph)}[t{i}b]')
            parts.append(f'[t{i}a][t{i}b]{join}[v{i}]')
        elif layout_name == 'screen_share' and seg_paths:
            top_h = int(out_w * height / width) // 2 * 2 if width >= height else int(out_h * 0.58) // 2 * 2
            top_h = min(top_h, int(out_h * 0.58) // 2 * 2)
            bot_h = out_h - top_h
            parts.append(f'{base},split[s{i}a][s{i}b]')
            parts.append(f'[s{i}a]scale={out_w}:{top_h}:force_original_aspect_ratio=decrease,pad={out_w}:{top_h}:(ow-iw)/2:(oh-ih)/2[t{i}a]')
            parts.append(f'[s{i}b]{pan_chain(seg_paths[0], f"p{i}b", out_w, bot_h)}[t{i}b]')
            parts.append(f'[t{i}a][t{i}b]vstack[v{i}]')
        elif layout_name == 'fixed_crop' and seg_paths:
            p = seg_paths[0]
            k = p['keyframes'][0]
            parts.append(f'{base},crop={p["w"]}:{p["h"]}:{k[1]}:{k[2]}:exact=1,scale={out_w}:{out_h}[v{i}]')
        elif layout_name == 'original' or (out_w >= out_h):
            parts.append(f'{base},scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2[v{i}]')
        else:  # full_frame: blur-pad
            parts.append(f'{base},split[f{i}a][f{i}b]')
            parts.append(f'[f{i}b]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},gblur=sigma=30,eq=brightness=-0.08[g{i}]')
            parts.append(f'[f{i}a]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[h{i}]')
            parts.append(f'[g{i}][h{i}]overlay=(W-w)/2:(H-h)/2[v{i}]')
        # a crop window is rarely the exact output aspect, so scale keeps the
        # picture's shape by giving each piece its own (near-square) pixel
        # aspect — and concat refuses to join pieces whose SARs differ.
        # Square pixels everywhere: the sub-0.1 % stretch is invisible.
        parts.append(f'[v{i}]setsar=1[u{i}]')
        outs.append(f'[u{i}]')
    if len(outs) > 1:
        parts.append(''.join(outs) + f'concat=n={len(outs)}:v=1:a=0[joined]')
        tail = '[joined]'
    else:
        tail = outs[0]
    if logo:
        parts.extend(logo_chain(logo, out_w, out_h, logo_input, tail, '[logoed]'))
        tail = '[logoed]'
    if ass_path:
        parts.append(f"{tail}subtitles='{_escape_filter_path(ass_path)}'[captioned]")
        tail = '[captioned]'
    parts.append(f'{tail}format=yuv420p[vout]')
    return ';'.join(parts)


def layout_pieces(keep: list[tuple[int, int]], segments: list[dict]) -> list[dict]:
    """Keep segments split at layout boundaries: the units the layout graph renders."""
    pieces = []
    for s, e in keep:
        for idx, seg in enumerate(segments):
            a, b = max(s, seg['start_ms']), min(e, seg['end_ms'])
            if b - a >= 40:
                pieces.append({'start_ms': a, 'end_ms': b, 'segment_index': idx, 'segment': seg})
    return pieces or [{'start_ms': 0, 'end_ms': max(e for _, e in keep), 'segment_index': 0,
                       'segment': {'layout': 'full_frame', 'subjects': []}}]


def render_layout_video(
    video_path: str | Path,
    clip_start_ms: int,
    clip_end_ms: int,
    keep: list[tuple[int, int]],
    layout: dict,
    audio_path: str | Path,
    out_path: str | Path,
    work: Path,
    ass_path: str | Path | None = None,
    fps: int = 30,
    crf: int = 20,
    preset: str = 'veryfast',
    logo: dict | None = None,
    logo_path: str | Path | None = None,
) -> Path:
    """Render a clip through its layout plan (the audio is already cut and mastered)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    width, height = int(layout['source']['width']), int(layout['source']['height'])
    pieces = layout_pieces(keep, layout['segments'])
    use_logo = logo if (logo and logo_path) else None
    graph = build_layout_graph(pieces, layout, width, height, fps, ass_path, work, logo=use_logo, logo_input=2)
    seconds = (clip_end_ms - clip_start_ms) / 1000
    brand = ['-loop', '1', '-framerate', str(fps), '-t', f'{seconds:.3f}', '-i', str(logo_path)] if use_logo else []
    run_ffmpeg(
        [
            '-y', '-ss', f'{clip_start_ms / 1000:.3f}', '-t', f'{(clip_end_ms - clip_start_ms) / 1000:.3f}',
            '-i', str(video_path), '-i', str(audio_path), *brand,
            '-filter_complex', graph, '-map', '[vout]', '-map', '1:a',
            '-c:v', 'libx264', '-preset', preset, '-crf', str(crf), '-r', str(fps),
            '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', str(out_path),
        ]
    )
    return out_path


# --------------------------------------------------------- long programmes
#
# Rendering a whole timeline (an episode, a lecture, a stream) rather than a
# short piece: resumable parts, lead-in / tail-out material, ducked music and
# mastering over the finished programme. Everything below is additive — the
# single-pass path above is untouched — and the same rules apply: trim +
# concat (never chained xfade), audio and video cut from the same keep list,
# mutes/bleeps on the source timeline, setsar=1 before every concat.
#
# `episode_*` is the historical name of the long-programme helpers.

EPISODE_PART_MS = 300_000          # ~5 minutes of output per resumable video part
EPISODE_MIN_PART_MS = 20_000       # a shorter tail is folded into the previous part
BLEEP_HZ = 1000
BLEEP_DB = -14.0
DUCK_THRESHOLD = 0.03
DUCK_ATTACK_MS = 20
DUCK_RELEASE_MS = 400
EPISODE_DECLICK_MS = 30

ASPECTS = {'16:9': (16, 9), '9:16': (9, 16), '1:1': (1, 1), '4:5': (4, 5), '5:4': (5, 4),
           '4:3': (4, 3), '3:4': (3, 4), '21:9': (21, 9)}

# Friendly caption names mapped onto the burn-in presets in captions.py.
# (captions.resolve_caption_style knows the same aliases.)
CAPTION_STYLE_PRESETS = {'clean': 'minimal', 'classic': 'classic', 'bold': 'yellow-bold',
                         'yellow': 'yellow-bold', 'outline': 'white-outline', 'minimal': 'minimal'}

_CARD_FONTS = (
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
)


def card_font_file() -> str | None:
    """A TTF for drawtext (ffmpeg has no fontconfig in some builds); None = let ffmpeg pick."""
    for candidate in _CARD_FONTS:
        if os.path.exists(candidate):
            return candidate
    try:
        import matplotlib  # noqa: F401  (only if the engine happens to have it)

        path = Path(matplotlib.get_data_path()) / 'fonts/ttf/DejaVuSans.ttf'
        if path.exists():
            return str(path)
    except Exception:  # noqa: BLE001
        pass
    return None


def parse_aspect(aspect: str | None) -> tuple[int, int]:
    if isinstance(aspect, str) and aspect in ASPECTS:
        return ASPECTS[aspect]
    text = str(aspect or '16:9').replace('x', ':').strip()
    try:
        w, h = text.split(':')
        wi, hi = int(float(w)), int(float(h))
        if wi > 0 and hi > 0:
            return wi, hi
    except (ValueError, TypeError):
        pass
    return 16, 9


def aspect_dims(aspect: str | None, short_edge: int = 1080) -> tuple[int, int]:
    """Output geometry from the SHORT edge: 16:9 -> 1920x1080, 9:16 -> 1080x1920, 1:1 -> 1080x1080."""
    w, h = parse_aspect(aspect)
    short_edge = int(short_edge) // 2 * 2
    if w <= h:
        width, height = short_edge, int(round(short_edge * h / w))
    else:
        height, width = short_edge, int(round(short_edge * w / h))
    return width // 2 * 2, height // 2 * 2


def capped_dims(aspect: str | None, max_edge: int) -> tuple[int, int]:
    """Same shape, long edge capped (range previews and the rough pass)."""
    w, h = parse_aspect(aspect)
    long_edge = int(max_edge) // 2 * 2
    if w >= h:
        width, height = long_edge, int(round(long_edge * h / w))
    else:
        height, width = long_edge, int(round(long_edge * w / h))
    return max(2, width // 2 * 2), max(2, height // 2 * 2)


def preview_dims(aspect: str | None, max_w: int, max_h: int,
                 source_w: int = 0, source_h: int = 0) -> tuple[int, int]:
    """
    The largest frame of `aspect` that fits inside max_w x max_h and is never
    bigger than the source itself — the preview tiers' geometry. A 640x360
    recording previews at 640x360, not blown up to 1280x720.
    """
    w, h = parse_aspect(aspect)
    scale = min(float(max_w) / w, float(max_h) / h)
    source_long = max(int(source_w or 0), int(source_h or 0))
    if source_long > 0:
        scale = min(scale, float(source_long) / max(w, h))
    width = max(2, int(round(w * scale)) // 2 * 2)
    height = max(2, int(round(h * scale)) // 2 * 2)
    return width, height


def export_short_edge(size, source_w: int = 0, source_h: int = 0, default: int = 1080) -> int:
    """`size: 720 | 1080 | source` from the export question -> the output's short edge."""
    text = str(size or '').strip().lower()
    if text in ('source', 'original', 'max'):
        short = min(int(source_w or 0), int(source_h or 0))
        return max(2, short // 2 * 2) if short else default
    try:
        value = int(float(text))
    except (TypeError, ValueError):
        return default
    return max(2, value // 2 * 2) if value > 0 else default


def quality_block(tier: str, check: dict | None, *, crf: int, preset: str, channels: int,
                  source_width=None, source_height=None, fps=None, width=None, height=None) -> dict:
    """
    The report's `quality` record: what the file REALLY is (probed), next to
    the settings it was encoded with and the source it came from. `upscaled`
    is a measurement, not a promise — it is True only if the output really is
    larger than the recording.
    """
    check = check if isinstance(check, dict) else {}
    out_w = int(check.get('width') or width or 0)
    out_h = int(check.get('height') or height or 0)
    src_w = int(source_width or 0)
    src_h = int(source_height or 0)
    measured_fps = check.get('fps') or fps
    return {
        'tier': str(tier),
        'width': out_w,
        'height': out_h,
        'fps': round(float(measured_fps), 3) if measured_fps else None,
        'video_codec': check.get('video_codec') or ('h264' if out_w else None),
        'crf': int(crf),
        'preset': str(preset),
        'audio_channels': int(check.get('audio_channels') or channels or 0),
        'source_width': src_w or None,
        'source_height': src_h or None,
        'upscaled': bool(src_w and src_h and out_w and out_h and max(out_w, out_h) > max(src_w, src_h)),
    }


def caption_layout_for(width: int, height: int) -> str:
    """Which caption geometry (captions.CAPTION_LAYOUTS) fits an output frame."""
    return 'vertical' if height > width else 'wide'


# ------------------------------------------------------------------- ranges


def range_to_keep(map_rows: list, out_a: int, out_b: int) -> list[tuple[int, int]]:
    """
    Output-timeline window -> the source keep slices that produce it, using the
    prepared spec's map ([src_start, src_end, out_start] per kept segment).
    """
    out_a, out_b = int(out_a), int(out_b)
    if out_b <= out_a:
        return []
    slices: list[tuple[int, int]] = []
    for row in map_rows or []:
        src_s, src_e, out_s = int(row[0]), int(row[1]), int(row[2])
        out_e = out_s + (src_e - src_s)
        a, b = max(out_a, out_s), min(out_b, out_e)
        if b <= a:
            continue
        slices.append((src_s + (a - out_s), src_s + (b - out_s)))
    return slices


def shift_groups(groups: list[list[dict]], offset_ms: int, window_ms: int | None = None) -> list[list[dict]]:
    """Caption groups moved onto a part's / range's local timeline, dropping what falls outside."""
    out: list[list[dict]] = []
    for group in groups or []:
        words = []
        for w in group:
            start = int(w['start_ms']) - offset_ms
            end = int(w['end_ms']) - offset_ms
            if end <= 0 or (window_ms is not None and start >= window_ms):
                continue
            start = max(0, start)
            if window_ms is not None:
                end = min(window_ms, end)
            if end > start:
                words.append({**w, 'start_ms': start, 'end_ms': end})
        if words:
            out.append(words)
    return out


# ----------------------------------------------------- source -> output time


class TimelineMap:
    """
    Maps a time in the clip's source audio to the rendered output timeline,
    given the keep segments and the crossfade applied at each join.
    """

    def __init__(self, segments: list[tuple[int, int]], crossfades: list[int] | None = None):
        self.segments = [tuple(s) for s in segments]
        crossfades = crossfades or [0] * max(0, len(self.segments) - 1)
        self.offsets: list[int] = []
        out = 0
        for i, (start, end) in enumerate(self.segments):
            if i > 0:
                out -= crossfades[i - 1]
            self.offsets.append(out)
            out += end - start
        self.total_ms = out

    def to_output(self, t_ms: int) -> int | None:
        for (start, end), offset in zip(self.segments, self.offsets):
            if start <= t_ms <= end:
                return offset + (t_ms - start)
        return None


def map_words_to_output(words: list[dict], timeline: TimelineMap) -> list[dict]:
    """Re-time words onto the rendered timeline; words inside a cut are dropped."""
    mapped = []
    for w in words:
        start = timeline.to_output(w['start_ms'])
        end = timeline.to_output(w['end_ms'])
        if start is None or end is None or end <= start:
            continue
        mapped.append({**w, 'start_ms': start, 'end_ms': end})
    return mapped


# -------------------------------------------------------------- episode audio


def _range_expr(ranges: list[tuple[int, int]]) -> str:
    return '+'.join(f'between(t,{s / 1000:.3f},{e / 1000:.3f})' for s, e in ranges)


def episode_audio_graph(
    keep: list[tuple[int, int]],
    mutes: list[tuple[int, int]] | None = None,
    bleeps: list[tuple[int, int]] | None = None,
    *,
    noise_reduction: bool = True,
    high_pass: bool = True,
    compression: bool = True,
    music: dict | None = None,
    music_input: int = 1,
    source_duration_ms: int = 0,
    fade_in_ms: int = EPISODE_DECLICK_MS,
    fade_out_ms: int = EPISODE_DECLICK_MS,
    source: str = '[0:a]',
    out_label: str = '[pre]',
) -> str:
    """
    The whole episode's audio in one graph, ending in `out_label` (before any
    loudnorm): mutes + bleeps on the SOURCE timeline, then the keep-list cuts,
    then clean-up, then music ducked under the speech with sidechaincompress.
    """
    keep = [(int(s), int(e)) for s, e in keep if e > s]
    if not keep:
        raise ValueError('episode audio needs at least one keep segment')
    mutes = [(int(s), int(e)) for s, e in (mutes or []) if e > s]
    bleeps = [(int(s), int(e)) for s, e in (bleeps or []) if e > s]
    n = len(keep)
    parts: list[str] = []

    # 1. source-timeline gating: muted ranges and the speech under every bleep go to zero
    silenced = mutes + bleeps
    head = f'{source}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
    if silenced:
        head += ''.join(
            f",volume=enable='between(t,{s / 1000:.3f},{e / 1000:.3f})':volume=0:eval=frame" for s, e in silenced
        )
    parts.append(f'{head}[speech_src]')
    src = '[speech_src]'

    # 2. the bleep tone itself: a 1 kHz sine at -14 dB, audible only inside the bleep ranges
    if bleeps:
        tone_ms = max(e for _, e in bleeps)
        parts.append(
            f'sine=frequency={BLEEP_HZ}:sample_rate=48000:duration={tone_ms / 1000:.3f},'
            f'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,'
            f'volume={BLEEP_DB}dB,'
            f"volume=enable='not({_range_expr(bleeps)})':volume=0:eval=frame[tone]"
        )
        parts.append(f'{src}[tone]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[bleeped]')
        src = '[bleeped]'

    # 3. the cuts: atrim per keep segment + de-click ramps, then concat
    if n > 1:
        parts.append(f'{src}asplit={n}' + ''.join(f'[k{i}]' for i in range(n)))
    for i, (start, end) in enumerate(keep):
        length = (end - start) / 1000
        fade_out_at = max(0.0, length - DECLICK_FADE_S)
        piece_src = f'[k{i}]' if n > 1 else src
        parts.append(
            f'{piece_src}atrim=start={start / 1000:.3f}:end={end / 1000:.3f},asetpts=PTS-STARTPTS,'
            f'afade=t=in:d={DECLICK_FADE_S},afade=t=out:st={fade_out_at:.3f}:d={DECLICK_FADE_S}[a{i}]'
        )
    if n > 1:
        parts.append(''.join(f'[a{i}]' for i in range(n)) + f'concat=n={n}:v=0:a=1[cat]')
        tail = '[cat]'
    else:
        tail = '[a0]'

    # 4. clean-up chain (each stage is a spec flag)
    chain = []
    if noise_reduction:
        chain.append('afftdn=nr=10:nf=-40')
    if high_pass:
        chain.append('highpass=f=80')
    if compression:
        chain.append('acompressor=threshold=0.126:ratio=2.5:attack=5:release=120')
    if chain:
        parts.append(f'{tail}{",".join(chain)}[clean]')
        tail = '[clean]'

    total_ms = sum(e - s for s, e in keep)

    # 5. music under the speech, ducked by a sidechain fed from the speech itself
    if music:
        gain_db = float(music.get('gain_db', -22))
        duck_db = abs(float(music.get('duck_db', -12)))
        fade_ms = int(music.get('fade_ms', 1500))
        ratio = max(2.0, min(20.0, round(duck_db / 1.5, 2)))
        parts.append(f'{tail}asplit=2[spk][sc]')
        music_fade_out = max(0.0, (total_ms - fade_ms) / 1000)
        parts.append(
            f'[{music_input}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,'
            f'aloop=loop=-1:size={total_ms * 48 + 48000},atrim=end={total_ms / 1000:.3f},asetpts=PTS-STARTPTS,'
            f'volume={gain_db}dB,'
            f'afade=t=in:d={fade_ms / 1000:.3f},afade=t=out:st={music_fade_out:.3f}:d={fade_ms / 1000:.3f}[mus]'
        )
        parts.append(
            f'[mus][sc]sidechaincompress=threshold={DUCK_THRESHOLD}:ratio={ratio}:'
            f'attack={DUCK_ATTACK_MS}:release={DUCK_RELEASE_MS}[duck]'
        )
        parts.append('[spk][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]')
        tail = '[mixed]'

    # 6. programme fades
    fade_out_at = max(0.0, (total_ms - fade_out_ms) / 1000)
    parts.append(
        f'{tail}afade=t=in:d={max(0, fade_in_ms) / 1000:.3f},'
        f'afade=t=out:st={fade_out_at:.3f}:d={max(0, fade_out_ms) / 1000:.3f}{out_label}'
    )
    del source_duration_ms
    return ';'.join(parts)


def render_episode_audio(
    src_media: str | Path,
    keep: list[tuple[int, int]],
    out_wav: str | Path,
    *,
    mutes: list[tuple[int, int]] | None = None,
    bleeps: list[tuple[int, int]] | None = None,
    noise_reduction: bool = True,
    high_pass: bool = True,
    compression: bool = True,
    music_path: str | Path | None = None,
    music: dict | None = None,
    master: bool = True,
    loudness_lufs: float = LOUDNESS_TARGET_LUFS,
    true_peak: float = TRUE_PEAK_DBTP,
    channels: int = 2,
) -> Path:
    """
    One full-length audio pass for an episode: cuts, mutes, bleeps, clean-up,
    ducked music and (when `master`) the two-pass loudnorm to the target LUFS.
    """
    out_wav = Path(out_wav)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    music_cfg = music if (music and music_path) else None
    graph = episode_audio_graph(
        keep, mutes, bleeps, noise_reduction=noise_reduction, high_pass=high_pass,
        compression=compression, music=music_cfg, music_input=1,
    )
    inputs = ['-i', str(src_media)]
    if music_cfg:
        inputs += ['-i', str(music_path)]

    tail = 'aresample=48000'
    if master:
        base = f'loudnorm=I={float(loudness_lufs)}:TP={float(true_peak)}:LRA={LOUDNESS_RANGE_LU}'
        measure = subprocess.run(
            [ffmpeg_exe(), '-hide_banner', '-nostdin', *inputs,
             '-filter_complex', f'{graph};[pre]{base}:print_format=json[out]', '-map', '[out]', '-f', 'null', '-'],
            capture_output=True, text=True,
        )
        stats = _loudnorm_stats(measure.stderr)
        second = base
        if stats:
            try:
                second = (
                    f'{base}:measured_I={stats["input_i"]}:measured_TP={stats["input_tp"]}'
                    f':measured_LRA={stats["input_lra"]}:measured_thresh={stats["input_thresh"]}'
                    f':offset={stats["target_offset"]}:linear=true'
                )
            except KeyError:
                second = base
        tail = f'{second},aresample=48000'

    run_ffmpeg(['-y', *inputs, '-filter_complex', f'{graph};[pre]{tail}[out]', '-map', '[out]',
                '-ar', '48000', '-ac', str(int(channels)), '-c:a', 'pcm_s16le', str(out_wav)])
    return out_wav


def assemble_episode_audio(pieces: list[dict], out_wav: str | Path, channels: int = 2) -> Path:
    """
    Join the mastered body with the intro/outro audio and the silent card gaps,
    in the order the video parts are concatenated. `pieces` items are either
    {'path': ...} or {'silence_ms': n}.
    """
    out_wav = Path(out_wav)
    if len(pieces) == 1 and pieces[0].get('path'):
        return Path(pieces[0]['path'])
    inputs: list[str] = []
    labels: list[str] = []
    parts: list[str] = []
    for i, piece in enumerate(pieces):
        if piece.get('path'):
            inputs += ['-i', str(piece['path'])]
        else:
            seconds = max(0.001, int(piece.get('silence_ms') or 0) / 1000)
            inputs += ['-f', 'lavfi', '-t', f'{seconds:.3f}', '-i', 'anullsrc=r=48000:cl=stereo']
        parts.append(f'[{i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,'
                     f'asetpts=PTS-STARTPTS[p{i}]')
        labels.append(f'[p{i}]')
    parts.append(''.join(labels) + f'concat=n={len(labels)}:v=0:a=1[out]')
    run_ffmpeg(['-y', *inputs, '-filter_complex', ';'.join(parts), '-map', '[out]',
                '-ar', '48000', '-ac', str(int(channels)), '-c:a', 'pcm_s16le', str(out_wav)])
    return out_wav


def encode_audio_deliverable(src_wav: str | Path, out_path: str | Path) -> Path:
    """episode.mp3 (192 kbps) / episode.wav (48 kHz 16-bit) from the finished audio."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    codec = ['-c:a', 'libmp3lame', '-b:a', '192k'] if out_path.suffix.lower() == '.mp3' else ['-c:a', 'pcm_s16le']
    run_ffmpeg(['-y', '-i', str(src_wav), '-vn', '-ar', '48000', *codec, str(out_path)])
    return out_path


# -------------------------------------------------------------- episode video


def plan_episode_parts(keep: list[tuple[int, int]], part_ms: int = EPISODE_PART_MS,
                       min_part_ms: int = EPISODE_MIN_PART_MS) -> list[dict]:
    """
    Split the keep list into ~`part_ms` chunks of OUTPUT time. A keep segment
    longer than a part is split inside itself (an exact source cut — the audio
    is rendered separately in one pass, so nothing can drift).
    """
    keep = [(int(s), int(e)) for s, e in keep if e > s]
    if not keep:
        return []
    part_ms = max(1000, int(part_ms))
    chunks: list[list[tuple[int, int]]] = []
    current: list[tuple[int, int]] = []
    used = 0
    for start, end in keep:
        cursor = start
        while cursor < end:
            room = part_ms - used
            if room <= 0:
                chunks.append(current)
                current, used, room = [], 0, part_ms
            take = min(end - cursor, room)
            if (end - cursor) - take < 200:      # never leave a sub-frame sliver behind
                take = end - cursor
            current.append((cursor, cursor + take))
            used += take
            cursor += take
    if current:
        chunks.append(current)
    if len(chunks) > 1 and sum(e - s for s, e in chunks[-1]) < min_part_ms:
        chunks[-2].extend(chunks.pop())
    parts = []
    out = 0
    for i, segments in enumerate(chunks):
        duration = sum(e - s for s, e in segments)
        parts.append({'n': i + 1, 'keep': [[s, e] for s, e in segments], 'out_start_ms': out,
                      'out_end_ms': out + duration, 'duration_ms': duration})
        out += duration
    return parts


def spec_hash(spec: dict, exclude: tuple[str, ...] = ('range', 'quality', 'prepared_at', 'warnings')) -> str:
    """
    Identity of a render: the prepared spec minus the fields that do not change
    the picture (the requested range, the quality preset, timestamps). A part
    already on disk under the same hash is reused on a re-run.
    """
    import hashlib

    trimmed = {k: v for k, v in (spec or {}).items() if k not in exclude}
    blob = json.dumps(trimmed, sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()[:16]


def reframe_chain(out_w: int, out_h: int, fit: str = 'fit', background: str = 'blur') -> list[str]:
    """
    Aspect conversion as a list of graph statements taking [rf_in] to [rf_out]:
    `fill` crops to cover, `fit` letterboxes on a blurred copy or a flat colour.
    Always ends in setsar=1 so concat accepts every piece.
    """
    if str(fit).lower() == 'fill':
        return [f'[rf_in]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,'
                f'crop={out_w}:{out_h},setsar=1[rf_out]']
    if str(background or 'blur').lower() == 'blur':
        return [
            '[rf_in]split[rf_fg][rf_bg]',
            f'[rf_bg]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},'
            f'gblur=sigma=30,eq=brightness=-0.08[rf_bgo]',
            f'[rf_fg]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[rf_fgo]',
            '[rf_bgo][rf_fgo]overlay=(W-w)/2:(H-h)/2,setsar=1[rf_out]',
        ]
    colour = str(background or 'black')
    if colour.startswith('#'):
        colour = '0x' + colour[1:]
    return [f'[rf_in]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,'
            f'pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:color={colour},setsar=1[rf_out]']


def logo_chain(logo: dict, out_w: int, out_h: int, logo_input: int, video_label: str, out_label: str) -> list[str]:
    """A watermark scaled to a fraction of the frame height, in one of the four corners."""
    height = max(8, int(round(out_h * float(logo.get('height', 0.10) or 0.10))))
    opacity = max(0.0, min(1.0, float(logo.get('opacity', 1.0) if logo.get('opacity') is not None else 1.0)))
    margin = max(8, int(round(out_h * 0.04)))
    corner = str(logo.get('corner') or 'tr').lower()
    x = f'W-w-{margin}' if corner in ('tr', 'br') else f'{margin}'
    y = f'H-h-{margin}' if corner in ('bl', 'br') else f'{margin}'
    return [
        f'[{logo_input}:v]scale=-1:{height},format=rgba,colorchannelmixer=aa={opacity:.3f}[lg]',
        f'{video_label}[lg]overlay={x}:{y}:format=auto:shortest=1{out_label}',
    ]


def episode_part_graph(
    segments_ms: list[tuple[int, int]],
    out_w: int,
    out_h: int,
    fps: int,
    *,
    fit: str = 'fit',
    background: str = 'blur',
    ass_path: str | Path | None = None,
    logo: dict | None = None,
    logo_input: int = 1,
    base_ms: int = 0,
) -> str:
    """
    One resumable part of the episode: its keep slices trimmed out of the
    (already seeked) decode, concatenated, reframed to the output aspect, the
    logo overlaid and the captions burned in. Ends in [vout].
    """
    frame_ms = 1000 / max(1, fps)
    usable = [(int(s) - int(base_ms), int(e) - int(base_ms)) for s, e in segments_ms if e - s >= frame_ms]
    if not usable:
        raise ValueError('No keep slice in this part is long enough to hold a video frame')
    n = len(usable)
    parts = [f'[0:v]fps={fps},setpts=PTS-STARTPTS,split={n}' + ''.join(f'[b{i}]' for i in range(n))]
    for i, (start, end) in enumerate(usable):
        parts.append(f'[b{i}]trim=start={start / 1000:.3f}:end={end / 1000:.3f},setpts=PTS-STARTPTS,'
                     f'fps={fps},setsar=1[v{i}]')
    if n > 1:
        parts.append(''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0[joined]')
        tail = '[joined]'
    else:
        tail = '[v0]'
    parts.append(f'{tail}null[rf_in]')
    parts.extend(reframe_chain(out_w, out_h, fit, background))
    tail = '[rf_out]'
    if logo:
        parts.extend(logo_chain(logo, out_w, out_h, logo_input, tail, '[logoed]'))
        tail = '[logoed]'
    if ass_path:
        parts.append(f"{tail}subtitles='{_escape_filter_path(ass_path)}'[captioned]")
        tail = '[captioned]'
    parts.append(f'{tail}format=yuv420p[vout]')
    return ';'.join(parts)


def render_episode_part(
    video_path: str | Path,
    segments_ms: list[tuple[int, int]],
    out_path: str | Path,
    out_w: int,
    out_h: int,
    *,
    fps: int = 30,
    crf: int = 20,
    preset: str = 'veryfast',
    fit: str = 'fit',
    background: str = 'blur',
    ass_path: str | Path | None = None,
    logo: dict | None = None,
    logo_path: str | Path | None = None,
) -> Path:
    """Encode one video-only part (captions burned in; the audio is a separate pass)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    base = int(min(s for s, _ in segments_ms))
    last = int(max(e for _, e in segments_ms))
    use_logo = logo if (logo and logo_path) else None
    graph = episode_part_graph(segments_ms, out_w, out_h, fps, fit=fit, background=background,
                               ass_path=ass_path, logo=use_logo, logo_input=1, base_ms=base)
    inputs = ['-ss', f'{base / 1000:.3f}', '-t', f'{(last - base) / 1000:.3f}', '-i', str(video_path)]
    if use_logo:
        # a looped still never ends on its own: bound it and let overlay finish with the picture
        inputs += ['-loop', '1', '-framerate', str(fps), '-t', f'{(last - base) / 1000:.3f}', '-i', str(logo_path)]
    run_ffmpeg(['-y', *inputs, '-filter_complex', graph, '-map', '[vout]', '-an',
                '-c:v', 'libx264', '-preset', preset, '-crf', str(crf), '-r', str(fps),
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(out_path)])
    return out_path


def _escape_drawtext(text: str) -> str:
    out = str(text or '').replace('\\', '\\\\')
    for ch in (':', "'", '%'):
        out = out.replace(ch, '\\' + ch)
    return out


def card_graph(text: str, subtitle: str, out_w: int, out_h: int, font: str | None = None,
               colour: str = 'white') -> str:
    """drawtext over a flat colour source: the title / end card."""
    font_arg = f":fontfile='{_escape_filter_path(font)}'" if font else ''
    size = max(24, int(out_h * 0.075))
    sub_size = max(18, int(out_h * 0.040))
    parts = [f"[0:v]drawtext=text='{_escape_drawtext(text)}':fontcolor={colour}:fontsize={size}"
             f"{font_arg}:x=(w-text_w)/2:y=(h-text_h)/2-{int(out_h * 0.03)}[t1]"]
    tail = '[t1]'
    if subtitle:
        parts.append(f"{tail}drawtext=text='{_escape_drawtext(subtitle)}':fontcolor=0xBBBBBB:fontsize={sub_size}"
                     f"{font_arg}:x=(w-text_w)/2:y=(h+text_h)/2+{int(out_h * 0.05)}[t2]")
        tail = '[t2]'
    parts.append(f'{tail}setsar=1,format=yuv420p[vout]')
    return ';'.join(parts)


def render_card(text: str, subtitle: str, seconds: float, out_path: str | Path, out_w: int, out_h: int,
                fps: int = 30, crf: int = 20, preset: str = 'veryfast', background: str = '0x111111') -> Path:
    """A silent title / end card part, generated with lavfi (no assets needed)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    seconds = max(0.5, float(seconds or 3))
    source = f'color=c={background}:s={out_w}x{out_h}:r={fps}:d={seconds:.3f}'
    encode = ['-c:v', 'libx264', '-preset', preset, '-crf', str(crf), '-r', str(fps),
              '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(out_path)]
    graph = card_graph(text, subtitle, out_w, out_h, card_font_file())
    try:
        run_ffmpeg(['-y', '-f', 'lavfi', '-i', source, '-filter_complex', graph, '-map', '[vout]', '-an',
                    '-t', f'{seconds:.3f}', *encode])
    except RuntimeError:
        # a build without drawtext (no libfreetype) still gets the timing right
        run_ffmpeg(['-y', '-f', 'lavfi', '-i', source, '-vf', 'setsar=1,format=yuv420p', '-an',
                    '-t', f'{seconds:.3f}', *encode])
    return out_path


def render_asset_part(asset_path: str | Path, out_path: str | Path, out_w: int, out_h: int,
                      fps: int = 30, crf: int = 20, preset: str = 'veryfast',
                      fit: str = 'fit', background: str = 'blur') -> Path:
    """An intro / outro clip conformed to the episode's geometry (video only, SAR 1)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    parts = [f'[0:v]fps={fps},setpts=PTS-STARTPTS,null[rf_in]']
    parts.extend(reframe_chain(out_w, out_h, fit, background))
    parts.append('[rf_out]format=yuv420p[vout]')
    run_ffmpeg(['-y', '-i', str(asset_path), '-filter_complex', ';'.join(parts), '-map', '[vout]', '-an',
                '-c:v', 'libx264', '-preset', preset, '-crf', str(crf), '-r', str(fps),
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(out_path)])
    return out_path


def extract_audio(src: str | Path, out_wav: str | Path) -> Path:
    """48 kHz stereo PCM of an asset's audio (silence when it has none)."""
    out_wav = Path(out_wav)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(['-y', '-i', str(src), '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', str(out_wav)])
    return out_wav


def concat_parts(paths: list[str | Path], out_path: str | Path, work: Path) -> Path:
    """
    Join the encoded parts with the concat demuxer (stream copy — every part was
    encoded with the same settings). Falls back to a re-encode if copy fails.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if len(paths) == 1:
        shutil_copy(paths[0], out_path)
        return out_path
    listing = Path(work) / 'parts.txt'
    listing.write_text('\n'.join(f"file '{Path(p).as_posix()}'" for p in paths) + '\n', encoding='utf-8')
    try:
        run_ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', str(listing), '-c', 'copy',
                    '-movflags', '+faststart', str(out_path)])
    except RuntimeError:
        run_ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', str(listing), '-c:v', 'libx264',
                    '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart', str(out_path)])
    return out_path


def shutil_copy(src: str | Path, dst: str | Path) -> Path:
    import shutil

    shutil.copyfile(str(src), str(dst))
    return Path(dst)


def mux_episode(video_path: str | Path, audio_path: str | Path, out_path: str | Path,
                audio_bitrate: str = '192k') -> Path:
    """Final mux: the concatenated picture + the one-pass mastered audio."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(['-y', '-i', str(video_path), '-i', str(audio_path), '-map', '0:v:0', '-map', '1:a:0',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', audio_bitrate, '-movflags', '+faststart',
                '-shortest', str(out_path)])
    return out_path


def transcode_aspect(src_path: str | Path, out_path: str | Path, out_w: int, out_h: int,
                     fps: int = 30, crf: int = 20, preset: str = 'veryfast',
                     fit: str = 'fit', background: str = 'blur', audio_bitrate: str = '192k') -> Path:
    """An extra aspect of a finished episode (same audio, reframed picture)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    parts = ['[0:v]null[rf_in]']
    parts.extend(reframe_chain(out_w, out_h, fit, background))
    parts.append('[rf_out]format=yuv420p[vout]')
    run_ffmpeg(['-y', '-i', str(src_path), '-filter_complex', ';'.join(parts), '-map', '[vout]', '-map', '0:a?',
                '-c:v', 'libx264', '-preset', preset, '-crf', str(crf), '-r', str(fps),
                '-c:a', 'aac', '-b:a', audio_bitrate, '-movflags', '+faststart', str(out_path)])
    return out_path


# ------------------------------------------------------------------ chapters


def ffmetadata_chapters(chapters: list[dict], total_ms: int, title: str | None = None) -> str:
    """
    ;FFMETADATA1 chapter list (TIMEBASE 1/1000) — the file podcast hosts and
    `ffmpeg -i chapters.txt` accept.
    """
    def esc(text: str) -> str:
        out = str(text or '')
        for ch in ('\\', '=', ';', '#'):
            out = out.replace(ch, '\\' + ch)
        return out.replace('\n', ' ')

    lines = [';FFMETADATA1']
    if title:
        lines.append(f'title={esc(title)}')
    marks = sorted(({'title': c.get('title') or f'Chapter {i + 1}', 'out_ms': max(0, int(c.get('out_ms') or 0))}
                    for i, c in enumerate(chapters or [])), key=lambda c: c['out_ms'])
    for i, mark in enumerate(marks):
        end = marks[i + 1]['out_ms'] if i + 1 < len(marks) else max(int(total_ms), mark['out_ms'] + 1)
        if end <= mark['out_ms']:
            continue
        lines += ['', '[CHAPTER]', 'TIMEBASE=1/1000', f'START={mark["out_ms"]}', f'END={end}',
                  f'title={esc(mark["title"])}']
    return '\n'.join(lines) + '\n'


def chapters_payload(chapters: list[dict], total_ms: int) -> dict:
    """chapters.json — the same marks with end times and hh:mm:ss labels."""
    marks = sorted(({'title': c.get('title') or f'Chapter {i + 1}', 'start_ms': max(0, int(c.get('out_ms') or 0))}
                    for i, c in enumerate(chapters or [])), key=lambda c: c['start_ms'])
    out = []
    for i, mark in enumerate(marks):
        end = marks[i + 1]['start_ms'] if i + 1 < len(marks) else max(int(total_ms), mark['start_ms'])
        out.append({'title': mark['title'], 'start_ms': mark['start_ms'], 'end_ms': end,
                    'start': _hhmmss(mark['start_ms'])})
    return {'schema_version': 1, 'duration_ms': int(total_ms), 'chapters': out}


def _hhmmss(ms: int) -> str:
    s = max(0, int(ms)) // 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f'{h:02d}:{m:02d}:{sec:02d}'


# ------------------------------------------------------- caption restyling


_ASS_ALIGNMENT = {'bottom': 2, 'middle': 5, 'center': 5, 'top': 8}


def _ass_colour(value: str | None) -> str | None:
    """#RRGGBB -> &H00BBGGRR (ASS colours are ABGR)."""
    if not value or not isinstance(value, str):
        return None
    text = value.strip().lstrip('#')
    if len(text) != 6:
        return None
    try:
        r, g, b = text[0:2], text[2:4], text[4:6]
        int(text, 16)
    except ValueError:
        return None
    return f'&H00{b}{g}{r}'.upper().replace('&H00', '&H00')


def restyle_ass(ass_text: str, style: dict | None) -> str:
    """
    Apply the studio's caption controls to a built ASS script without touching
    the caption builder: font, size, colour, position, karaoke on/off and
    per-speaker colours (a \\c override in front of each line).
    """
    style = style or {}
    lines = ass_text.splitlines()
    out = []
    for line in lines:
        if line.startswith('Style: Default,'):
            fields = line[len('Style: '):].split(',')
            if style.get('font'):
                fields[1] = str(style['font'])
            if style.get('size'):
                try:
                    fields[2] = str(int(style['size']))
                except (TypeError, ValueError):
                    pass
            colour = _ass_colour(style.get('color'))
            if colour:
                fields[3] = colour
            align = _ASS_ALIGNMENT.get(str(style.get('position') or 'bottom').lower())
            if align:
                fields[18] = str(align)
                if align == 8:
                    fields[21] = str(max(40, int(fields[21]) // 4))
            out.append('Style: ' + ','.join(fields))
            continue
        if line.startswith('Dialogue:'):
            if style.get('karaoke') is False:
                line = re.sub(r'\{\\k\d+\}', '', line)
            out.append(line)
            continue
        out.append(line)
    return '\n'.join(out) + '\n'


def colour_dialogue(ass_text: str, colours: list[str | None]) -> str:
    """Per-line primary colour (per-speaker captions): one entry per Dialogue line."""
    out, index = [], 0
    for line in ass_text.splitlines():
        if line.startswith('Dialogue:'):
            colour = _ass_colour(colours[index]) if index < len(colours) else None
            index += 1
            if colour:
                head, _, text = line.partition(',,0,0,0,,')
                if _:
                    line = f'{head},,0,0,0,,{{\\c{colour}}}{text}'
        out.append(line)
    return '\n'.join(out) + '\n'


def conform_audio(src: str | Path, out_wav: str | Path, duration_ms: int) -> Path:
    """An asset's audio padded/trimmed to exactly its rendered part's length."""
    out_wav = Path(out_wav)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    seconds = max(0.001, int(duration_ms) / 1000)
    run_ffmpeg(['-y', '-i', str(src), '-vn', '-af', 'apad', '-t', f'{seconds:.3f}',
                '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', str(out_wav)])
    return out_wav
