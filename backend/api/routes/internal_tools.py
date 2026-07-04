"""
Internal EDL tool endpoints — called by the RocketRide chat_editor agent
(.rocketride/chat_editor.pipe) via its tool_http_request node.

Not part of the public API surface: only reachable because the pipe's
urlWhitelist restricts the agent to these exact routes. All state reads and
mutations go through Postgres via db.session, same as the rest of the app.
"""

from __future__ import annotations
from contextlib import contextmanager

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from workers.tasks import load_state
from db.session import get_session
from db.models import Job
from utils.edl import EditDecisionList

router = APIRouter()


def _load_job_state(job_id: str) -> tuple[dict, EditDecisionList]:
    transcript = load_state(job_id, "transcript")
    edl_dict = load_state(job_id, "edl")
    if transcript is None or edl_dict is None:
        raise HTTPException(404, f"Job {job_id} not ready — transcription must finish first")
    return transcript, EditDecisionList.from_dict(edl_dict)


@contextmanager
def _mutate_edl(job_id: str):
    """
    Read-modify-write the EDL inside a single row-locked transaction, so two
    concurrent agent tool calls (the pipe allows up to 5 in flight) can't both
    read the same EDL, each append a cut, and clobber each other — one cut
    would silently vanish. `SELECT ... FOR UPDATE` serializes them.
    """
    with get_session() as session:
        job = session.get(Job, job_id, with_for_update=True)
        if job is None or job.edl is None:
            raise HTTPException(404, f"Job {job_id} not ready — transcription must finish first")
        edl = EditDecisionList.from_dict(job.edl)
        yield edl
        job.edl = edl.to_dict()


class SearchTranscriptRequest(BaseModel):
    job_id: str
    query: str


@router.post("/internal/tools/search_transcript")
def search_transcript(req: SearchTranscriptRequest):
    transcript, _ = _load_job_state(req.job_id)
    q = req.query.lower()
    hits = [
        {"text": seg["text"], "start_ms": seg["start_ms"], "end_ms": seg["end_ms"]}
        for seg in transcript["segments"]
        if q in seg["text"].lower()
    ]
    return {"matches": hits[:10]}


class TranscriptAroundRequest(BaseModel):
    job_id: str
    center_ms: int
    window_ms: int = 30000


@router.post("/internal/tools/transcript_around")
def transcript_around(req: TranscriptAroundRequest):
    transcript, _ = _load_job_state(req.job_id)
    lo, hi = req.center_ms - req.window_ms, req.center_ms + req.window_ms
    segments = [
        {"text": s["text"], "start_ms": s["start_ms"], "end_ms": s["end_ms"]}
        for s in transcript["segments"]
        if s["end_ms"] >= lo and s["start_ms"] <= hi
    ]
    return {"segments": segments}


class ApplyCutRequest(BaseModel):
    job_id: str
    start_ms: int
    end_ms: int
    reason: str


@router.post("/internal/tools/apply_cut")
def apply_cut(req: ApplyCutRequest):
    with _mutate_edl(req.job_id) as edl:
        edit = edl.add_cut(req.start_ms, req.end_ms, req.reason, source="agent")
        result = {
            "applied": edit.to_dict(),
            "output_duration_ms": edl.output_duration_ms(),
            "total_cuts": len(edl.edits),
        }
    return result


class UndoCutRequest(BaseModel):
    job_id: str
    edit_id: str


@router.post("/internal/tools/undo_cut")
def undo_cut(req: UndoCutRequest):
    with _mutate_edl(req.job_id) as edl:
        removed = edl.remove_cut(req.edit_id)
        result = {"removed": removed, "total_cuts": len(edl.edits)}
    return result


@router.get("/internal/tools/list_cuts")
def list_cuts(job_id: str):
    _, edl = _load_job_state(job_id)
    return {"cuts": [e.to_dict() for e in edl.edits]}
