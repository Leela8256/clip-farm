"""
Celery tasks — long-running pipeline stages.

Two entry points:
- run_autopilot: full automatic pipeline (transcribe -> auto-clean -> render -> master -> brand)
- run_transcribe_only: transcription for chat-editing mode (user edits EDL interactively,
  then calls render_and_finish when done)
- render_and_finish: render current EDL -> master -> brand merge
"""

from __future__ import annotations
import json
from pathlib import Path

from workers.celery_app import celery_app
from nodes.transcription_node import TranscriptionNode
from nodes.auto_cleanup_node import AutoCleanupNode
from nodes.audio_dsp_node import AudioDSPNode
from nodes.mastering_node import MasteringNode
from nodes.brand_merge_node import BrandMergeNode


def _job_dir(job_id: str) -> Path:
    d = Path("tmp/jobs") / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _save_state(job_id: str, key: str, data: dict | str):
    path = _job_dir(job_id) / f"{key}.json"
    path.write_text(json.dumps(data) if isinstance(data, dict) else data)


def load_state(job_id: str, key: str) -> dict | None:
    path = _job_dir(job_id) / f"{key}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


@celery_app.task(bind=True)
def run_transcribe_only(self, job_id: str, audio_path: str) -> dict:
    """Transcribe for chat-editing mode. EDL starts empty."""
    self.update_state(state="PROGRESS", meta={"stage": "transcribing"})

    transcript = TranscriptionNode().execute({"audio_path": audio_path})["transcript"]
    _save_state(job_id, "transcript", transcript)

    from utils.dsp import load_audio
    from utils.edl import EditDecisionList

    audio = load_audio(audio_path)
    edl = EditDecisionList(
        job_id=job_id, source_file=audio_path, total_duration_ms=len(audio)
    )
    _save_state(job_id, "edl", edl.to_dict())

    return {"stage": "ready_for_editing", "transcript_segments": len(transcript["segments"])}


@celery_app.task(bind=True)
def run_autopilot(self, job_id: str, audio_path: str) -> dict:
    """Full automatic pipeline, end to end."""
    self.update_state(state="PROGRESS", meta={"stage": "transcribing"})
    transcript = TranscriptionNode().execute({"audio_path": audio_path})["transcript"]
    _save_state(job_id, "transcript", transcript)

    self.update_state(state="PROGRESS", meta={"stage": "auto_cleanup"})
    edl = AutoCleanupNode().execute(
        {"audio_path": audio_path, "transcript": transcript, "job_id": job_id}
    )["edl"]
    _save_state(job_id, "edl", edl)

    self.update_state(state="PROGRESS", meta={"stage": "rendering"})
    rendered = AudioDSPNode().execute({"edl": edl})["rendered_wav"]

    self.update_state(state="PROGRESS", meta={"stage": "mastering"})
    mastered = MasteringNode().execute({"rendered_wav": rendered})["mastered_file"]

    self.update_state(state="PROGRESS", meta={"stage": "brand_merge"})
    final = BrandMergeNode().execute({"mastered_file": mastered})["final_file"]

    _save_state(job_id, "result", {"final_file": final})
    return {"stage": "done", "final_file": final}


@celery_app.task(bind=True)
def render_and_finish(self, job_id: str) -> dict:
    """Render the current EDL (after chat editing) and finish the pipeline."""
    edl = load_state(job_id, "edl")
    if edl is None:
        raise ValueError(f"No EDL found for job {job_id}")

    self.update_state(state="PROGRESS", meta={"stage": "rendering"})
    rendered = AudioDSPNode().execute({"edl": edl})["rendered_wav"]

    self.update_state(state="PROGRESS", meta={"stage": "mastering"})
    mastered = MasteringNode().execute({"rendered_wav": rendered})["mastered_file"]

    self.update_state(state="PROGRESS", meta={"stage": "brand_merge"})
    final = BrandMergeNode().execute({"mastered_file": mastered})["final_file"]

    _save_state(job_id, "result", {"final_file": final})
    return {"stage": "done", "final_file": final}
