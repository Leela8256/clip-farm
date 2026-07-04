"""
Audio DSP utilities — the engine that makes cuts invisible.

Every cut goes through:
1. Zero-crossing snapping (no clicks/pops)
2. Micro-fades at edit boundaries (5-10ms de-click)
3. Crossfade joins between segments (default 20ms)

The EDL renderer reads keep_segments and produces the final audio.
Original files are never modified.
"""

from __future__ import annotations
import numpy as np
from pydub import AudioSegment
from pathlib import Path

from utils.edl import EditDecisionList

DEFAULT_CROSSFADE_MS = 20
DECLICK_FADE_MS = 8
ZERO_CROSS_SEARCH_MS = 15  # search window for nearest zero-crossing


def load_audio(path: str | Path) -> AudioSegment:
    """Load any audio format pydub/ffmpeg supports."""
    return AudioSegment.from_file(str(path))


def _samples(segment: AudioSegment) -> np.ndarray:
    """AudioSegment -> mono numpy array (for analysis only, not rendering)."""
    arr = np.array(segment.get_array_of_samples())
    if segment.channels == 2:
        arr = arr.reshape((-1, 2)).mean(axis=1)
    return arr


def snap_to_zero_crossing(audio: AudioSegment, position_ms: int) -> int:
    """
    Find the nearest zero-crossing to position_ms within a small search window.
    Cutting at zero-crossings prevents audible clicks/pops.
    Returns the adjusted position in ms.
    """
    if position_ms <= 0:
        return 0
    if position_ms >= len(audio):
        return len(audio)

    window_start = max(0, position_ms - ZERO_CROSS_SEARCH_MS)
    window_end = min(len(audio), position_ms + ZERO_CROSS_SEARCH_MS)
    window = audio[window_start:window_end]

    samples = _samples(window)
    if len(samples) < 2:
        return position_ms

    # Find sign changes (zero crossings)
    signs = np.sign(samples)
    crossings = np.where(np.diff(signs) != 0)[0]
    if len(crossings) == 0:
        return position_ms

    # Nearest crossing to the center of the window
    sr = audio.frame_rate
    center_sample = int((position_ms - window_start) * sr / 1000)
    nearest = crossings[np.argmin(np.abs(crossings - center_sample))]

    adjusted_ms = window_start + int(nearest * 1000 / sr)
    return adjusted_ms


def render_edl(
    edl: EditDecisionList,
    crossfade_ms: int = DEFAULT_CROSSFADE_MS,
) -> AudioSegment:
    """
    Render final audio from an EDL's keep_segments.

    For each segment:
    - Snap boundaries to zero-crossings
    - Apply micro fade-in/fade-out (de-click)
    Then join all segments with crossfades.
    """
    audio = load_audio(edl.source_file)
    keep = edl.get_keep_segments()

    if not keep:
        raise ValueError("EDL produced no keep segments — everything was cut")

    rendered_parts: list[AudioSegment] = []

    for seg in keep:
        start = snap_to_zero_crossing(audio, seg["start_ms"])
        end = snap_to_zero_crossing(audio, seg["end_ms"])
        if end <= start:
            continue

        part = audio[start:end]

        # De-click: tiny fades at boundaries
        fade = min(DECLICK_FADE_MS, len(part) // 4)
        if fade > 0:
            part = part.fade_in(fade).fade_out(fade)

        rendered_parts.append(part)

    if not rendered_parts:
        raise ValueError("No renderable segments after zero-crossing adjustment")

    # Join with crossfades — this is what makes cuts inaudible
    result = rendered_parts[0]
    for part in rendered_parts[1:]:
        xf = min(crossfade_ms, len(result) // 2, len(part) // 2)
        result = result.append(part, crossfade=max(0, xf))

    return result


def detect_silences(
    audio: AudioSegment,
    silence_threshold_db: float = -40.0,
    min_silence_ms: int = 800,
    keep_pause_ms: int = 350,
) -> list[tuple[int, int]]:
    """
    Detect silence regions longer than min_silence_ms.
    Returns (start_ms, end_ms) tuples for the *cuttable* portion of each silence —
    we keep keep_pause_ms of natural pause so speech doesn't sound rushed.
    """
    from pydub.silence import detect_silence as pydub_detect

    raw = pydub_detect(
        audio,
        min_silence_len=min_silence_ms,
        silence_thresh=silence_threshold_db,
        seek_step=10,
    )

    cuttable = []
    for start, end in raw:
        # Keep a natural pause: shrink the cut region from both sides
        pad = keep_pause_ms // 2
        cut_start = start + pad
        cut_end = end - pad
        if cut_end - cut_start > 100:  # only cut if meaningful amount remains
            cuttable.append((cut_start, cut_end))

    return cuttable


def export_mp3(
    audio: AudioSegment,
    out_path: str | Path,
    bitrate: str = "128k",
) -> Path:
    """Export final audio as MP3, 44.1kHz — Spotify-compatible."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    audio = audio.set_frame_rate(44100)
    audio.export(str(out_path), format="mp3", bitrate=bitrate)
    return out_path


def export_wav(audio: AudioSegment, out_path: str | Path) -> Path:
    """Export as WAV — intermediate format for the mastering chain."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    audio.export(str(out_path), format="wav")
    return out_path
