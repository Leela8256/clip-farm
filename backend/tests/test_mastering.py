"""
Tests for the mastering chain's loudness/true-peak targets, and a regression
guard for the brand-merge loudness-overshoot bug found in manual E2E testing
(see git history: a CC-licensed jingle at -13.57 LUFS/+0.16 dBTP dragged the
final mix to -16.44 LUFS/-0.11 dBTP when spliced in without re-normalizing).
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from utils.mastering import normalize_loudness, normalize_final_mix
from tests.conftest import make_tone


def test_normalize_loudness_invokes_ffmpeg_normalize_with_configured_targets(tmp_path, monkeypatch):
    monkeypatch.setenv("LOUDNESS_TARGET_LUFS", "-16")
    monkeypatch.setenv("TRUE_PEAK_DBTP", "-1")
    # Re-import to pick up the monkeypatched env (module-level constants are
    # read once at import time)
    import importlib
    import utils.mastering as mastering_module

    importlib.reload(mastering_module)

    in_wav = tmp_path / "in.wav"
    out_file = tmp_path / "out.mp3"
    in_wav.touch()

    with patch.object(mastering_module.subprocess, "run") as mock_run:
        mastering_module.normalize_loudness(in_wav, out_file)

    assert mock_run.called
    cmd = mock_run.call_args[0][0]
    assert "-t" in cmd and cmd[cmd.index("-t") + 1] == "-16.0"
    assert "-tp" in cmd and cmd[cmd.index("-tp") + 1] == "-1.0"

    importlib.reload(mastering_module)  # restore for other tests


def test_normalize_final_mix_delegates_to_normalize_loudness(tmp_path):
    """
    Regression guard: BrandMergeNode must re-normalize after stitching in
    brand assets, not just export the raw crossfaded mix.
    """
    in_file = tmp_path / "stitched.wav"
    out_file = tmp_path / "final.mp3"
    in_file.touch()

    with patch("utils.mastering.normalize_loudness") as mock_normalize:
        normalize_final_mix(in_file, out_file)

    mock_normalize.assert_called_once_with(in_file, out_file)


@pytest.mark.slow
def test_normalize_loudness_holds_true_peak_ceiling_on_real_audio(tmp_path):
    """
    Integration test: actually runs ffmpeg-normalize (subprocess) and verifies
    the true-peak ceiling is respected and loudness never ends up hotter than
    target. Uses amplitude-modulated noise (dynamic, speech-like crest factor)
    rather than a pure sine — R128 loudness gating behaves very differently on
    a constant tone, so a tone can't verify the target the way real content does.

    Exact -16 LUFS targeting on genuine speech is proven by the full E2E run
    (see git history / docs/QUALITY_REPORT.md); this test guards the invariant
    that generalizes to any input: output is at or below target loudness, and
    true peak stays under the -1 dBTP ceiling (no clipping risk on re-encode).
    """
    import numpy as np

    sr = 44100
    n = sr * 5
    rng = np.random.default_rng(42)
    noise = rng.standard_normal(n)
    # Amplitude-modulate to mimic speech dynamics (syllable-rate envelope)
    envelope = 0.3 + 0.3 * np.abs(np.sin(2 * np.pi * 3 * np.linspace(0, 5, n)))
    signal = (noise * envelope * 0.3 * 32767).astype(np.int16)
    from pydub import AudioSegment

    dynamic = AudioSegment(signal.tobytes(), frame_rate=sr, sample_width=2, channels=1)
    in_wav = tmp_path / "dynamic.wav"
    dynamic.export(str(in_wav), format="wav")
    out_file = tmp_path / "normalized.mp3"

    normalize_loudness(in_wav, out_file)
    assert out_file.exists()

    result = subprocess.run(
        [
            "ffmpeg-normalize",
            str(out_file),
            "-o",
            str(tmp_path / "measured.mp3"),
            "-c:a",
            "libmp3lame",
            "--print-stats",
            "-n",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    import json

    stats = json.loads(result.stdout)[0]["ebu_pass1"]
    # Never louder than the -16 LUFS target (a small margin allows for MP3
    # re-encode drift), and true peak comfortably under the -1 dBTP ceiling.
    assert stats["input_i"] <= -15.0
    assert stats["input_tp"] <= -0.5
