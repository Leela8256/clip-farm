"""Job lifecycle endpoints — start pipelines, poll status, fetch state."""

from __future__ import annotations
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from celery.result import AsyncResult
from workers.celery_app import celery_app
from workers.tasks import run_autopilot, run_transcribe_only, render_and_finish, load_state
from db.session import get_session
from db.models import Job

router = APIRouter()


class StartJobRequest(BaseModel):
    job_id: str
    audio_path: str
    mode: str  # "autopilot" | "chat"


@router.post("/jobs")
def start_job(req: StartJobRequest):
    if not Path(req.audio_path).exists():
        raise HTTPException(404, "Audio file not found — upload first")
    if req.mode not in ("autopilot", "chat"):
        raise HTTPException(400, "mode must be 'autopilot' or 'chat'")

    with get_session() as session:
        session.merge(Job(id=req.job_id, mode=req.mode, audio_path=req.audio_path, status="pending"))

    if req.mode == "autopilot":
        task = run_autopilot.delay(req.job_id, req.audio_path)
    else:
        task = run_transcribe_only.delay(req.job_id, req.audio_path)

    return {"job_id": req.job_id, "task_id": task.id, "mode": req.mode}


@router.post("/jobs/{job_id}/render")
def render(job_id: str):
    """Finish a chat-editing session: render current EDL -> master -> brand."""
    if load_state(job_id, "edl") is None:
        raise HTTPException(404, "No EDL for this job")
    task = render_and_finish.delay(job_id)
    return {"job_id": job_id, "task_id": task.id}


@router.get("/tasks/{task_id}/status")
def task_status(task_id: str):
    result = AsyncResult(task_id, app=celery_app)
    payload = {"task_id": task_id, "state": result.state}
    if result.state == "PROGRESS":
        payload["stage"] = (result.info or {}).get("stage")
    elif result.state == "SUCCESS":
        payload["result"] = result.result
    elif result.state == "FAILURE":
        payload["error"] = str(result.info)
    return payload


@router.get("/jobs/{job_id}/transcript")
def get_transcript(job_id: str):
    transcript = load_state(job_id, "transcript")
    if transcript is None:
        raise HTTPException(404, "Transcript not ready")
    return transcript


@router.get("/jobs/{job_id}/edl")
def get_edl(job_id: str):
    edl = load_state(job_id, "edl")
    if edl is None:
        raise HTTPException(404, "EDL not found")
    return edl
