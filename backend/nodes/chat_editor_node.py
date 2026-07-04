"""
ChatEditorNode — drives the real RocketRide engine for conversational EDL editing.

The agent (.rocketride/chat_editor.pipe: chat source -> agent_rocketride with
llm_anthropic + memory_internal + tool_http_request) runs inside the RocketRide
engine, not in-process. This node just starts that pipeline once and relays
chat turns to it; the agent calls back into our own /api/internal/tools/*
endpoints to read the transcript and mutate the EDL. See
backend/api/routes/internal_tools.py for the tool implementations and
utils/edl.py for the EDL model those tools mutate.
"""

from __future__ import annotations
import os
from pathlib import Path

from rocketride import RocketRideClient
from rocketride.schema import Question, QuestionHistory

PIPE_PATH = str(Path(__file__).resolve().parents[2] / ".rocketride" / "chat_editor.pipe")


class ChatEditorNode:
    name = "podcast_chat_editor"
    inputs = {
        "job_id": "text",
        "user_message": "text",
        "chat_history": "json",
    }
    outputs = {"assistant_message": "text"}

    def __init__(self):
        self._token: str | None = None

    async def _ensure_started(self, client: RocketRideClient) -> str:
        if self._token is None:
            result = await client.use(filepath=PIPE_PATH, use_existing=True)
            self._token = result["token"]
        return self._token

    async def execute(self, inputs: dict) -> dict:
        job_id = inputs["job_id"]
        history: list[dict] = inputs.get("chat_history") or []

        question = Question()
        question.addContext(f"Job ID: {job_id}")
        for turn in history:
            question.addHistory(QuestionHistory(role=turn["role"], content=turn["content"]))
        question.addQuestion(inputs["user_message"])

        client = RocketRideClient(
            uri=os.environ["ROCKETRIDE_URI"], auth=os.environ["ROCKETRIDE_APIKEY"]
        )
        try:
            await client.connect()
            token = await self._ensure_started(client)
            response = await client.chat(token=token, question=question)
        finally:
            await client.disconnect()

        answers = response.get("answers") or []
        assistant_message = answers[0] if answers else "(no response from editor agent)"

        return {"assistant_message": assistant_message}
