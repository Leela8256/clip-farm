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
                 mutes_ms: list[tuple[int, int]] | None = None) -> Path:
    """
    Cut, clean and master a clip's audio with ffmpeg only. Two-pass EBU R128
    loudnorm to -16 LUFS / -1 dBTP (linear when the measurement allows it,
    ffmpeg's dynamic mode otherwise).
    """
    out_wav = Path(out_wav)
    graph = _audio_graph(segments_ms, mutes_ms)
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
                       ass_path: str | Path | None, work: Path) -> str:
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
) -> Path:
    """Render a clip through its layout plan (the audio is already cut and mastered)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    width, height = int(layout['source']['width']), int(layout['source']['height'])
    pieces = layout_pieces(keep, layout['segments'])
    graph = build_layout_graph(pieces, layout, width, height, fps, ass_path, work)
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
