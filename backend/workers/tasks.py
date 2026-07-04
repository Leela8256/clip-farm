"""
Celery tasks — long-running pipeline stages.

Two entry points:
- run_autopilot: full automatic pipeline (transcribe -> auto-clean -> render -> master -> brand)
- run_transcribe_only: transcription for chat-editing mode (user edits EDL interactively,
  then calls render_and_finish when done)
- render_and_finish: render current EDL -> master -> brand merge

Job state (transcript, EDL, status, result) lives in Postgres, not the
filesystem — see backend/db/. Progress is also pushed live over the
RocketRide DAP WebSocket channel (see workers/events.py) so the frontend
can subscribe instead of polling Celery's own status endpoint.
"""

from __future__ import annotations

from sqlalchemy import select

from workers.celery_app import celery_app
from workers.events import publish_stage, publish_terminal
from db.session import get_session
from db.models import Job
from nodes.transcription_node import TranscriptionNode
from nodes.auto_cleanup_node import AutoCleanupNode
from nodes.audio_dsp_node import AudioDSPNode
from nodes.mastering_node import MasteringNode
from nodes.brand_merge_node import BrandMergeNode


def _set_stage(job_id: str, stage: str, celery_task) -> None:
    celery_task.update_state(state="PROGRESS", meta={"stage": stage})
    with get_session() as session:
        job = session.get(Job, job_id)
        if job:
            job.status = "running"
            job.stage = stage
    publish_stage(job_id, stage)


def _set_field(job_id: str, **fields) -> None:
    with get_session() as session:
        job = session.get(Job, job_id)
        if job:
            for key, value in fields.items():
                setattr(job, key, value)


def load_state(job_id: str, key: str) -> dict | str | None:
    """Read a single field of job state. Mirrors the old file-based API."""
    with get_session() as session:
        job = session.get(Job, job_id)
        if job is None:
            return None
        if key == "result":
            return {"final_file": job.final_file} if job.final_file else None
        return getattr(job, key, None)


@celery_app.task(bind=True)
def run_transcribe_only(self, job_id: str, audio_path: str) -> dict:
    """Transcribe for chat-editing mode. EDL starts empty."""
    _set_stage(job_id, "transcribing", self)

    transcript = TranscriptionNode().execute({"audio_path": audio_path})["transcript"]
    _set_field(job_id, transcript=transcript)

    from utils.dsp import load_audio
    from utils.edl import EditDecisionList

    audio = load_audio(audio_path)
    edl = EditDecisionList(
        job_id=job_id, source_file=audio_path, total_duration_ms=len(audio)
    )
    _set_field(job_id, edl=edl.to_dict())

    publish_terminal(job_id, "ready_for_editing")
    return {"stage": "ready_for_editing", "transcript_segments": len(transcript["segments"])}


@celery_app.task(bind=True)
def run_autopilot(self, job_id: str, audio_path: str) -> dict:
    """Full automatic pipeline, end to end."""
    _set_stage(job_id, "transcribing", self)
    transcript = TranscriptionNode().execute({"audio_path": audio_path})["transcript"]
    _set_field(job_id, transcript=transcript)

    _set_stage(job_id, "auto_cleanup", self)
    edl = AutoCleanupNode().execute(
        {"audio_path": audio_path, "transcript": transcript, "job_id": job_id}
    )["edl"]
    _set_field(job_id, edl=edl)

    _set_stage(job_id, "rendering", self)
    rendered = AudioDSPNode().execute({"edl": edl})["rendered_wav"]

    _set_stage(job_id, "mastering", self)
    mastered = MasteringNode().execute({"rendered_wav": rendered})["mastered_file"]

    _set_stage(job_id, "brand_merge", self)
    final = BrandMergeNode().execute({"mastered_file": mastered})["final_file"]

    _set_field(job_id, final_file=final, status="done", stage="done")
    publish_terminal(job_id, "done", final_file=final)
    return {"stage": "done", "final_file": final}


@celery_app.task(bind=True)
def render_and_finish(self, job_id: str) -> dict:
    """Render the current EDL (after chat editing) and finish the pipeline."""
    edl = load_state(job_id, "edl")
    if edl is None:
        raise ValueError(f"No EDL found for job {job_id}")

    _set_stage(job_id, "rendering", self)
    rendered = AudioDSPNode().execute({"edl": edl})["rendered_wav"]

    _set_stage(job_id, "mastering", self)
    mastered = MasteringNode().execute({"rendered_wav": rendered})["mastered_file"]

    _set_stage(job_id, "brand_merge", self)
    final = BrandMergeNode().execute({"mastered_file": mastered})["final_file"]

    _set_field(job_id, final_file=final, status="done", stage="done")
    publish_terminal(job_id, "done", final_file=final)
    return {"stage": "done", "final_file": final}
