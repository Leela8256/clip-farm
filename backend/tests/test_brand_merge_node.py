"""
Regression tests for BrandMergeNode's re-normalization behavior — the exact
bug found in manual E2E testing (see mastering.py's normalize_final_mix docstring).
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from nodes.brand_merge_node import BrandMergeNode
from tests.conftest import make_tone


def test_brand_merge_renormalizes_when_intro_present(tmp_path, monkeypatch):
    episode = make_tone(3000)
    mastered_path = tmp_path / "mastered.mp3"
    episode.export(str(mastered_path), format="mp3")

    intro = make_tone(1000, freq_hz=880.0)
    intro_path = tmp_path / "intro.mp3"
    intro.export(str(intro_path), format="mp3")

    monkeypatch.setenv("ASSETS_INTRO", str(intro_path))
    monkeypatch.setenv("ASSETS_OUTRO", str(tmp_path / "does_not_exist.mp3"))

    with patch("nodes.brand_merge_node.normalize_final_mix") as mock_normalize:
        mock_normalize.side_effect = lambda in_f, out_f: out_f.write_bytes(b"fake mp3")
        result = BrandMergeNode().execute({"mastered_file": str(mastered_path)})

    mock_normalize.assert_called_once()
    assert result["final_file"] == str(tmp_path / "final.mp3")


def test_brand_merge_skips_normalization_when_no_brand_assets(tmp_path, monkeypatch):
    episode = make_tone(3000)
    mastered_path = tmp_path / "mastered.mp3"
    episode.export(str(mastered_path), format="mp3")

    monkeypatch.setenv("ASSETS_INTRO", str(tmp_path / "no_intro.mp3"))
    monkeypatch.setenv("ASSETS_OUTRO", str(tmp_path / "no_outro.mp3"))

    with patch("nodes.brand_merge_node.normalize_final_mix") as mock_normalize:
        result = BrandMergeNode().execute({"mastered_file": str(mastered_path)})

    mock_normalize.assert_not_called()
    assert Path(result["final_file"]).exists()
