"""
Tests for the audio DSP engine — zero-crossing snapping, crossfade rendering,
and both silence detectors (amplitude-based and VAD-gap-based).
"""

from __future__ import annotations

import numpy as np
import pytest
from pydub import AudioSegment

from utils.dsp import (
    snap_to_zero_crossing,
    render_edl,
    detect_silences,
    detect_silences_from_vad_gaps,
)
from utils.edl import EditDecisionList

from .conftest import make_tone, make_silence


# ── zero-crossing snapping ──────────────────────────────────────────


def test_snap_clamps_to_zero_at_start():
    audio = make_tone(1000)
    assert snap_to_zero_crossing(audio, 0) == 0


def test_snap_clamps_to_end():
    audio = make_tone(1000)
    assert snap_to_zero_crossing(audio, len(audio)) == len(audio)
    assert snap_to_zero_crossing(audio, 999_999) == len(audio)


def test_snap_finds_an_actual_zero_crossing():
    """The result should land on or very near a genuine sign change, not an arbitrary offset."""
    audio = make_tone(2000, freq_hz=440.0)
    target_ms = 1000
    snapped = snap_to_zero_crossing(audio, target_ms)

    # Snapped position must be within the search window
    assert abs(snapped - target_ms) <= 15

    # Verify a genuine sign change occurs within ~1ms of the snapped position.
    # The function returns a millisecond value, so the sample-precise crossing
    # can sit up to ~1ms (≈44 samples at 44.1kHz) from the rounded ms position.
    samples = np.array(audio.get_array_of_samples())
    sr = audio.frame_rate
    idx = int(snapped * sr / 1000)
    half = sr // 1000 + 2  # ~1ms of samples either side
    window = samples[max(0, idx - half) : idx + half]
    signs = np.sign(window)
    assert np.any(np.diff(signs) != 0), "snapped position isn't near any zero-crossing"


# ── EDL rendering (crossfades, de-click) ────────────────────────────


def test_render_edl_produces_shorter_output_than_source():
    audio = make_tone(10_000)
    audio.export("/tmp/_test_source.wav", format="wav")

    edl = EditDecisionList(job_id="t", source_file="/tmp/_test_source.wav", total_duration_ms=len(audio))
    edl.add_cut(3000, 5000, reason="test")

    rendered = render_edl(edl, crossfade_ms=20)
    # Expect ~8000ms minus crossfade overlap, well under the original 10000ms
    assert len(rendered) < len(audio)
    assert len(rendered) > 7000  # not over-trimmed


def test_render_edl_raises_when_everything_is_cut():
    audio = make_tone(5000)
    audio.export("/tmp/_test_source2.wav", format="wav")

    edl = EditDecisionList(job_id="t", source_file="/tmp/_test_source2.wav", total_duration_ms=len(audio))
    edl.add_cut(0, 5000, reason="cut everything")

    with pytest.raises(ValueError, match="no keep segments"):
        render_edl(edl)


def test_render_edl_no_cuts_returns_near_original_length():
    audio = make_tone(3000)
    audio.export("/tmp/_test_source3.wav", format="wav")

    edl = EditDecisionList(job_id="t", source_file="/tmp/_test_source3.wav", total_duration_ms=len(audio))
    rendered = render_edl(edl)
    # Single keep-segment, no joins — should be exactly the source length
    assert abs(len(rendered) - len(audio)) <= 1


# ── amplitude-based silence detection ───────────────────────────────


def test_detect_silences_finds_clean_gap(tone_with_silence_gap):
    result = detect_silences(tone_with_silence_gap, silence_threshold_db=-40, min_silence_ms=800)
    assert len(result) == 1
    start, end = result[0]
    # The silence is roughly at [2000, 3500); cuttable region should be inside that
    assert 2000 <= start < end <= 3500


def test_detect_silences_ignores_short_gaps():
    audio = make_tone(1000) + make_silence(300) + make_tone(1000)
    result = detect_silences(audio, silence_threshold_db=-40, min_silence_ms=800)
    assert result == []


def test_detect_silences_finds_nothing_in_continuous_tone(continuous_tone):
    result = detect_silences(continuous_tone, silence_threshold_db=-40, min_silence_ms=800)
    assert result == []


# ── VAD-gap-based silence detection (the noisy-audio fallback) ──────


def test_vad_gap_detection_finds_gap_between_segments():
    segments = [
        {"start_ms": 0, "end_ms": 2000},
        {"start_ms": 3500, "end_ms": 5500},  # 1500ms gap
    ]
    result = detect_silences_from_vad_gaps(segments, total_duration_ms=5500, min_silence_ms=800)
    assert len(result) == 1
    start, end = result[0]
    assert 2000 <= start < end <= 3500


def test_vad_gap_detection_ignores_short_gaps():
    segments = [
        {"start_ms": 0, "end_ms": 2000},
        {"start_ms": 2300, "end_ms": 4000},  # 300ms gap, below threshold
    ]
    result = detect_silences_from_vad_gaps(segments, total_duration_ms=4000, min_silence_ms=800)
    assert result == []


def test_vad_gap_detection_catches_trailing_silence():
    """A long gap after the last segment (before end of file) must also be caught."""
    segments = [{"start_ms": 0, "end_ms": 2000}]
    result = detect_silences_from_vad_gaps(segments, total_duration_ms=5000, min_silence_ms=800)
    assert len(result) == 1
    start, end = result[0]
    assert 2000 <= start < end <= 5000


def test_vad_gap_detection_works_regardless_of_noise_floor():
    """
    This is the exact scenario that motivated adding this detector: gaps are
    derived from transcript segment boundaries, not audio amplitude, so a
    noisy recording (high noise floor) doesn't defeat it the way
    detect_silences() can be defeated. No audio object is even passed in.
    """
    segments = [
        {"start_ms": 0, "end_ms": 10_000},
        {"start_ms": 14_200, "end_ms": 20_000},  # 4200ms gap, same shape as the real bug found in testing
    ]
    result = detect_silences_from_vad_gaps(segments, total_duration_ms=20_000, min_silence_ms=800)
    assert len(result) == 1
    start, end = result[0]
    assert 10_000 <= start < end <= 14_200


def test_vad_gap_detection_handles_overlapping_segments():
    """Overlapping/out-of-order segments (e.g. from imperfect VAD) shouldn't produce negative gaps."""
    segments = [
        {"start_ms": 0, "end_ms": 5000},
        {"start_ms": 4000, "end_ms": 9000},  # overlaps the previous segment
    ]
    result = detect_silences_from_vad_gaps(segments, total_duration_ms=9000, min_silence_ms=800)
    assert result == []
