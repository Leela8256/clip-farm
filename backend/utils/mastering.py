"""
Mastering chain — the free replacement for Auphonic.

Pipeline: noise reduction (noisereduce) -> studio DSP (Pedalboard) -> loudness (ffmpeg-normalize)

If AUPHONIC_API_KEY is set in the environment, mastering routes through Auphonic instead
(see utils/auphonic.py).
"""

from __future__ import annotations
import os
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
import noisereduce as nr
from pedalboard import Pedalboard, NoiseGate, Compressor, HighpassFilter, Gain


LOUDNESS_TARGET = float(os.getenv("LOUDNESS_TARGET_LUFS", "-16"))
TRUE_PEAK = float(os.getenv("TRUE_PEAK_DBTP", "-1"))


def reduce_noise(in_wav: Path, out_wav: Path) -> Path:
    """
    Spectral-gating noise reduction. Non-stationary mode adapts to changing
    background noise (AC turning on, street sounds shifting).
    Processes in chunks to keep memory bounded on long episodes.
    """
    data, rate = sf.read(str(in_wav))

    # Mono-ise for consistent processing (podcasts are voice-first)
    if data.ndim > 1:
        data = data.mean(axis=1)

    chunk_sec = 60
    chunk_size = rate * chunk_sec
    cleaned = []
    for i in range(0, len(data), chunk_size):
        chunk = data[i : i + chunk_size]
        cleaned.append(
            nr.reduce_noise(
                y=chunk,
                sr=rate,
                stationary=False,
                prop_decrease=0.85,  # don't fully gate — keeps voice natural
            )
        )
    result = np.concatenate(cleaned)

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_wav), result, rate)
    return out_wav


def studio_polish(in_wav: Path, out_wav: Path) -> Path:
    """
    Spotify Pedalboard chain — approximates a broadcast voice chain:
    - Highpass 80Hz: remove rumble/plosives energy
    - NoiseGate: kill residual low-level noise between words
    - Compressor: even out volume dips when trailing off
    - Gain: modest make-up gain (final level set by loudnorm later)
    """
    data, rate = sf.read(str(in_wav))
    if data.ndim == 1:
        data = data.reshape(-1, 1)

    board = Pedalboard(
        [
            HighpassFilter(cutoff_frequency_hz=80),
            NoiseGate(threshold_db=-55, ratio=2.5, release_ms=250),
            Compressor(threshold_db=-18, ratio=2.5, attack_ms=5, release_ms=120),
            Gain(gain_db=2),
        ]
    )

    processed = board(data.astype(np.float32).T, rate).T

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_wav), processed, rate)
    return out_wav


def normalize_loudness(in_wav: Path, out_file: Path) -> Path:
    """
    Two-pass EBU R128 loudness normalisation via ffmpeg-normalize.
    Target: -16 LUFS / -1 dBTP (podcast standard, Spotify/Apple compatible).
    Outputs MP3 at 44.1kHz/128k directly.
    """
    out_file.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg-normalize",
        str(in_wav),
        "-o",
        str(out_file),
        "-t",
        str(LOUDNESS_TARGET),
        "-tp",
        str(TRUE_PEAK),
        "--dual-mono",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-f",
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return out_file


def normalize_final_mix(in_file: Path, out_file: Path) -> Path:
    """
    Re-applies loudness/true-peak normalisation to the fully stitched episode
    (after intro/outro brand-merge). Brand assets are rarely mastered to the
    same -16 LUFS / -1 dBTP target as the spoken-word episode — splicing them
    in unnormalised can drag the overall measured loudness and true peak past
    spec even when the episode itself was mastered correctly. This is a plain
    re-run of the same two-pass ffmpeg-normalize step on the final mix.
    """
    return normalize_loudness(in_file, out_file)


def master(in_wav: Path, out_file: Path, work_dir: Path) -> Path:
    """
    Full mastering chain. If AUPHONIC_API_KEY is set, delegate to Auphonic;
    otherwise run the local free stack.
    """
    if os.getenv("AUPHONIC_API_KEY"):
        from utils.auphonic import auphonic_master

        return auphonic_master(in_wav, out_file)

    denoised = work_dir / "denoised.wav"
    polished = work_dir / "polished.wav"

    reduce_noise(in_wav, denoised)
    studio_polish(denoised, polished)
    normalize_loudness(polished, out_file)

    return out_file
