"""
AutoCleanupNode — RocketRide custom node.

Input lanes:  audio_path (text), transcript (json)
Output lane:  edl (json)

Deterministic rule-based cleanup — no LLM needed:
1. Detect long silences (> MIN_SILENCE_MS), keep a natural pause, cut the rest
2. Detect filler words from the transcript word list, cut at word boundaries
"""

from __future__ import annotations
import os
from pathlib import Path

from utils.edl import EditDecisionList
from utils.dsp import load_audio, detect_silences, detect_silences_from_vad_gaps


DEFAULT_FILLERS = {"um", "uh", "erm", "hmm", "mhm"}


def _configured_fillers() -> set[str]:
    raw = os.getenv("FILLER_WORDS", "")
    extra = {w.strip().lower() for w in raw.split(",") if w.strip()}
    # single-word fillers only in auto mode — multi-word phrases like
    # "you know" are too contextual to cut blindly; the chat agent handles those
    return DEFAULT_FILLERS | {w for w in extra if " " not in w}


def _merge_overlapping(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Union overlapping/adjacent (start, end) ranges from the two silence detectors."""
    if not ranges:
        return []
    ranges = sorted(ranges)
    merged = [ranges[0]]
    for start, end in ranges[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


class AutoCleanupNode:
    name = "podcast_auto_cleanup"
    inputs = {"audio_path": "text", "transcript": "json"}
    outputs = {"edl": "json"}

    def execute(self, inputs: dict) -> dict:
        audio_path = inputs["audio_path"]
        transcript = inputs["transcript"]
        job_id = inputs.get("job_id", Path(audio_path).parent.name)

        audio = load_audio(audio_path)
        edl = EditDecisionList(
            job_id=job_id,
            source_file=audio_path,
            total_duration_ms=len(audio),
        )

        # 1. Silence cuts — two complementary signals, deduplicated:
        #    amplitude-based (works well on clean studio recordings) and
        #    VAD-gap-based (catches pauses amplitude detection misses on
        #    noisy/lo-fi source where the noise floor sits close to speech
        #    level, since transcription segments are already VAD-filtered).
        silence_thresh = float(os.getenv("SILENCE_THRESHOLD_DB", "-40"))
        min_silence = int(os.getenv("MIN_SILENCE_MS", "800"))
        amplitude_silences = detect_silences(audio, silence_thresh, min_silence)
        vad_silences = detect_silences_from_vad_gaps(
            transcript.get("segments", []), len(audio), min_silence
        )
        for start, end in _merge_overlapping(amplitude_silences + vad_silences):
            edl.add_cut(start, end, reason="long silence", source="auto")

        # 2. Filler word cuts (word boundaries from transcript)
        fillers = _configured_fillers()
        for seg in transcript.get("segments", []):
            for word in seg.get("words", []):
                clean = word["word"].lower().strip(".,!?;:")
                if clean in fillers and word.get("probability", 1.0) > 0.5:
                    # pad slightly so the crossfade has room
                    edl.add_cut(
                        max(0, word["start_ms"] - 10),
                        min(len(audio), word["end_ms"] + 10),
                        reason=f"filler word: {clean}",
                        source="auto",
                    )

        return {"edl": edl.to_dict()}
