"""
BrandMergeNode — RocketRide custom node.

Stitches the fixed company intro/outro around the mastered episode with
generous crossfades so music beds blend into speech naturally.

Brand assets are rarely mastered to the same -16 LUFS / -1 dBTP target as
the episode itself (music beds run louder/hotter than spoken word) — after
stitching, the mix is re-normalized to spec rather than trusting the
episode-only mastering pass to still hold after intro/outro are spliced in.

Input lane:  mastered_file (text)
Output lane: final_file (text)
"""

from __future__ import annotations
import os
from pathlib import Path

from pydub import AudioSegment

from utils.dsp import load_audio, export_wav
from utils.mastering import normalize_final_mix

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
        has_brand_assets = False
        if intro_path.exists():
            intro = load_audio(intro_path)
            xf = min(MUSIC_CROSSFADE_MS, len(intro) // 2, len(result) // 2)
            result = intro.append(result, crossfade=xf)
            has_brand_assets = True
        if outro_path.exists():
            outro = load_audio(outro_path)
            xf = min(MUSIC_CROSSFADE_MS, len(outro) // 2, len(result) // 2)
            result = result.append(outro, crossfade=xf)
            has_brand_assets = True

        final_path = out_dir / "final.mp3"
        if has_brand_assets:
            # Intro/outro shifted the mix's loudness/peak — re-normalize the
            # stitched result rather than trusting the episode-only mastering.
            stitched_wav = export_wav(result, out_dir / "stitched.wav")
            normalize_final_mix(stitched_wav, final_path)
        else:
            from utils.dsp import export_mp3

            export_mp3(result, final_path)

        return {"final_file": str(final_path)}
