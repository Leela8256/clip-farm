"""
TranscriptionNode — RocketRide custom node.

Input lane:  audio_path (file path, str)
Output lane: transcript (JSON) — segments + word-level timestamps

Uses faster-whisper locally. Model size configurable via WHISPER_MODEL env
(tiny/base/small/medium/large-v3). Word timestamps are the foundation both
editing modes depend on.
"""

from __future__ import annotations
import os
from pathlib import Path

from faster_whisper import WhisperModel

_model_cache: dict[str, WhisperModel] = {}


def _get_model() -> WhisperModel:
    name = os.getenv("WHISPER_MODEL", "base")
    device = os.getenv("WHISPER_DEVICE", "cpu")
    key = f"{name}:{device}"
    if key not in _model_cache:
        compute = "float16" if device == "cuda" else "int8"
        _model_cache[key] = WhisperModel(name, device=device, compute_type=compute)
    return _model_cache[key]


class TranscriptionNode:
    """RocketRide node contract: execute(inputs) -> outputs dict."""

    name = "podcast_transcription"
    inputs = {"audio_path": "text"}
    outputs = {"transcript": "json"}

    def execute(self, inputs: dict) -> dict:
        audio_path = inputs["audio_path"]
        if not Path(audio_path).exists():
            raise FileNotFoundError(audio_path)

        model = _get_model()
        segments, info = model.transcribe(
            audio_path,
            word_timestamps=True,
            vad_filter=True,  # skip long non-speech, faster + cleaner
        )

        result = {
            "language": info.language,
            "duration_sec": info.duration,
            "segments": [],
        }

        for seg in segments:
            words = [
                {
                    "word": w.word.strip(),
                    "start_ms": int(w.start * 1000),
                    "end_ms": int(w.end * 1000),
                    "probability": round(w.probability, 3),
                }
                for w in (seg.words or [])
            ]
            result["segments"].append(
                {
                    "id": seg.id,
                    "text": seg.text.strip(),
                    "start_ms": int(seg.start * 1000),
                    "end_ms": int(seg.end * 1000),
                    "words": words,
                }
            )

        return {"transcript": result}
