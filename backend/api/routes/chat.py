"""
Chat endpoint — conversational EDL editing.

Each turn is relayed to the real RocketRide engine (see
nodes/chat_editor_node.py and .rocketride/chat_editor.pipe). The agent
mutates the EDL itself via HTTP tool calls back into
/api/internal/tools/*, so this route re-reads the EDL from Postgres after
the turn completes rather than receiving it back from the node.
"""

from __future__ import annotations
import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from nodes.chat_editor_node import ChatEditorNode
from workers.tasks import load_state
from db.session import get_session
from db.models import Job, ChatTurn

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


# Sync SQLAlchemy calls are wrapped in asyncio.to_thread so they don't block
# the event loop this async route shares with the WebSocket status relays.


def _persist_turn(job_id: str, user_message: str, assistant_message: str) -> dict | None:
    """Record the chat turn and return the agent-mutated EDL (read after the
    agent's tool calls have committed). Runs in a worker thread."""
    with get_session() as session:
        job = session.get(Job, job_id)
        if job is None:
            raise HTTPException(404, "Job not found")
        edl = job.edl
        session.add(ChatTurn(job_id=job_id, role="user", content=user_message))
        session.add(ChatTurn(job_id=job_id, role="assistant", content=assistant_message))
    return edl


@router.post("/chat/{job_id}")
async def chat(job_id: str, req: ChatRequest):
    transcript = await asyncio.to_thread(load_state, job_id, "transcript")
    if transcript is None:
        raise HTTPException(404, "Job not ready — transcription must finish first")

    result = await _node().execute(
        {
            "job_id": job_id,
            "user_message": req.message,
            "chat_history": req.chat_history,
        }
    )
    assistant_message = result["assistant_message"]

    edl = await asyncio.to_thread(_persist_turn, job_id, req.message, assistant_message)

    new_history = req.chat_history + [
        {"role": "user", "content": req.message},
        {"role": "assistant", "content": assistant_message},
    ]

    return {
        "assistant_message": assistant_message,
        "edl": edl,
        "chat_history": new_history,
    }
