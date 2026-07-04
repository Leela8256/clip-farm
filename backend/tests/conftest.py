"""Shared fixtures for synthetic test audio — no external files or network needed."""

from __future__ import annotations

import numpy as np
import pytest
from pydub import AudioSegment


def make_tone(duration_ms: int, freq_hz: float = 440.0, sample_rate: int = 44100, amplitude: float = 0.5) -> AudioSegment:
    """A continuous sine tone — has no natural zero-crossing gaps, good for crossfade/render tests."""
    n_samples = int(sample_rate * duration_ms / 1000)
    t = np.linspace(0, duration_ms / 1000, n_samples, endpoint=False)
    wave = (amplitude * np.sin(2 * np.pi * freq_hz * t) * 32767).astype(np.int16)
    return AudioSegment(
        wave.tobytes(), frame_rate=sample_rate, sample_width=2, channels=1
    )


def make_silence(duration_ms: int, sample_rate: int = 44100) -> AudioSegment:
    return AudioSegment.silent(duration=duration_ms, frame_rate=sample_rate)


@pytest.fixture
def tone_with_silence_gap():
    """speech(2s) -> silence(1.5s) -> speech(2s): a clean amplitude-detectable silence gap."""
    speech_a = make_tone(2000, amplitude=0.5)
    gap = make_silence(1500)
    speech_b = make_tone(2000, amplitude=0.5)
    return speech_a + gap + speech_b


@pytest.fixture
def continuous_tone():
    """5 seconds of continuous tone — no silence anywhere."""
    return make_tone(5000, amplitude=0.5)
