"""
Chat endpoint — conversational EDL editing.

Chat turns are fast enough to run synchronously in the API process
(only LLM calls + JSON manipulation; no audio rendering happens here).
"""

from __future__ import annotations
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from nodes.chat_editor_node import ChatEditorNode
from workers.tasks import load_state

router = APIRouter()

_chat_node: ChatEditorNode | None = None


def _node() -> ChatEditorNode:
    global _chat_node
    if _chat_node is None:
        _chat_node = ChatEditorNode()
    return _chat_node


class ChatRequest(BaseModel):
    message: str
    chat_history: list = []


@router.post("/chat/{job_id}")
def chat(job_id: str, req: ChatRequest):
    transcript = load_state(job_id, "transcript")
    edl = load_state(job_id, "edl")
    if transcript is None or edl is None:
        raise HTTPException(404, "Job not ready — transcription must finish first")

    result = _node().execute(
        {
            "transcript": transcript,
            "edl": edl,
            "user_message": req.message,
            "chat_history": req.chat_history,
        }
    )

    # Persist updated EDL
    edl_path = Path("tmp/jobs") / job_id / "edl.json"
    edl_path.write_text(json.dumps(result["edl"]))

    return {
        "assistant_message": result["assistant_message"],
        "edl": result["edl"],
        "chat_history": result["chat_history"],
    }
