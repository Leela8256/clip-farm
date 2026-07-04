"""
MasteringNode — RocketRide custom node.

Wraps the mastering chain (noisereduce -> Pedalboard -> ffmpeg-normalize),
or Auphonic when AUPHONIC_API_KEY is present.

Input lane:  rendered_wav (text)
Output lane: mastered_file (text)
"""

from __future__ import annotations
import os
from pathlib import Path

from utils.mastering import master


class MasteringNode:
    name = "podcast_mastering"
    inputs = {"rendered_wav": "text"}
    outputs = {"mastered_file": "text"}

    def execute(self, inputs: dict) -> dict:
        in_wav = Path(inputs["rendered_wav"])
        work_dir = in_wav.parent
        out_file = work_dir / "mastered.mp3"

        master(in_wav, out_file, work_dir)

        return {"mastered_file": str(out_file)}
