"""
AudioDSPNode — RocketRide custom node.

Renders the EDL into actual audio: zero-crossing snapped cuts, de-click fades,
crossfaded joins. Output is an intermediate WAV for the mastering stage.

Input lane:  edl (json)
Output lane: rendered_wav (text — file path)
"""

from __future__ import annotations
import os
from pathlib import Path

from utils.edl import EditDecisionList
from utils.dsp import render_edl, export_wav


class AudioDSPNode:
    name = "podcast_audio_dsp"
    inputs = {"edl": "json"}
    outputs = {"rendered_wav": "text"}

    def execute(self, inputs: dict) -> dict:
        edl = EditDecisionList.from_dict(inputs["edl"])
        crossfade = int(os.getenv("CROSSFADE_MS", "20"))

        rendered = render_edl(edl, crossfade_ms=crossfade)

        out_dir = Path(os.getenv("OUTPUT_DIR", "tmp/outputs")) / edl.job_id
        out_path = export_wav(rendered, out_dir / "rendered.wav")

        return {"rendered_wav": str(out_path)}
