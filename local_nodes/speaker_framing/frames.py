"""
The node's own ffmpeg helpers, so the framing node depends on nothing but the
engine's toolchain (the ffmpeg bundled with imageio_ffmpeg). Copied verbatim
from the media library the render node uses — same commands, same numbers.
"""

from __future__ import annotations
import os
import re
import shlex
import subprocess
from pathlib import Path

# The output shapes a framing plan can be made for; anything else keeps the
# configured canvas.
ASPECTS = ('9:16', '4:5', '1:1', '16:9')

_SCENE_PTS = re.compile(r'pts_time:\s*([0-9.]+)')


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


def canvas_dims(aspect: str, size: int) -> tuple[int, int]:
    """
    Canvas geometry from the long edge: 9:16 (1080x1920 at 1920) and 16:9
    (1920x1080), plus the two feed shapes, which keep the portrait WIDTH so a
    preview scales proportionally: 4:5 -> 1080x1350 and 1:1 -> 1080x1080.
    """
    size = int(size) // 2 * 2
    short = int(round(size * 9 / 16)) // 2 * 2
    if aspect in ('vertical', '9:16'):
        return short, size
    if aspect in ('wide', '16:9'):
        return size, short
    if aspect == '4:5':
        return short, int(round(short * 5 / 4)) // 2 * 2
    if aspect == '1:1':
        return short, short
    raise ValueError(f'unknown aspect {aspect!r}')


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


def frame_seconds(markdown: str) -> list[float]:
    """Seconds column of the frame grabber's markdown table, in row order."""
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
