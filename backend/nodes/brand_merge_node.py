"""
BrandMergeNode — RocketRide custom node.

Stitches the fixed company intro/outro around the mastered episode with
generous crossfades so music beds blend into speech naturally.

Input lane:  mastered_file (text)
Output lane: final_file (text)
"""

from __future__ import annotations
import os
from pathlib import Path

from pydub import AudioSegment

from utils.dsp import load_audio, export_mp3

MUSIC_CROSSFADE_MS = 800  # music-to-speech blends need longer fades than cuts


class BrandMergeNode:
    name = "podcast_brand_merge"
    inputs = {"mastered_file": "text"}
    outputs = {"final_file": "text"}

    def execute(self, inputs: dict) -> dict:
        episode = load_audio(inputs["mastered_file"])
        out_dir = Path(inputs["mastered_file"]).parent

        intro_path = Path(os.getenv("ASSETS_INTRO", "assets/intro/intro.mp3"))
        outro_path = Path(os.getenv("ASSETS_OUTRO", "assets/outro/outro.mp3"))

        result = episode
        if intro_path.exists():
            intro = load_audio(intro_path)
            xf = min(MUSIC_CROSSFADE_MS, len(intro) // 2, len(result) // 2)
            result = intro.append(result, crossfade=xf)
        if outro_path.exists():
            outro = load_audio(outro_path)
            xf = min(MUSIC_CROSSFADE_MS, len(outro) // 2, len(result) // 2)
            result = result.append(outro, crossfade=xf)

        final_path = export_mp3(result, out_dir / "final.mp3")
        return {"final_file": str(final_path)}
