"""
ChatEditorNode — RocketRide custom node.

The conversational editing agent. Claude receives the transcript with word
timestamps and a set of tools that mutate the EDL. The agent never touches
audio — it only proposes timestamped edits; the DSP layer executes them.

Input lanes:  transcript (json), edl (json), user_message (text), chat_history (json)
Output lanes: edl (json), assistant_message (text), chat_history (json)
"""

from __future__ import annotations
import json
import os

import anthropic

from utils.edl import EditDecisionList

MODEL = "claude-sonnet-4-6"
MAX_AGENT_TURNS = 8

SYSTEM_PROMPT = """You are a podcast audio editor assistant. You have access to a full transcript with word-level timestamps.

Your job is to help the user edit their podcast by modifying an Edit Decision List (EDL).
You can only call the tools available to you — you cannot play audio or see waveforms.

Rules:
- Always confirm before applying a cut larger than 60 seconds
- When the user references a time ("around 12 minutes"), find the nearest natural pause within ±30 seconds
- When the user describes content ("the part where I talked about X"), search the transcript text and show them the matching segment before cutting
- Never cut mid-word. Always find the nearest word boundary.
- After every edit, summarise what changed and what the new runtime will be"""

TOOLS = [
    {
        "name": "search_transcript",
        "description": "Search the transcript for text. Returns matching segments with their timestamps. Use this when the user describes content they want to find or cut.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Text to search for (case-insensitive substring match)"}
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_transcript_around",
        "description": "Get transcript segments within a time window. Use when the user references a timestamp ('around 12 minutes in').",
        "input_schema": {
            "type": "object",
            "properties": {
                "center_ms": {"type": "integer", "description": "Center of the window in milliseconds"},
                "window_ms": {"type": "integer", "description": "Half-width of window in ms (default 30000)"},
            },
            "required": ["center_ms"],
        },
    },
    {
        "name": "apply_cut",
        "description": "Add a cut to the EDL. start_ms and end_ms must align with word boundaries from the transcript. Returns updated EDL stats.",
        "input_schema": {
            "type": "object",
            "properties": {
                "start_ms": {"type": "integer"},
                "end_ms": {"type": "integer"},
                "reason": {"type": "string", "description": "Short human-readable reason for the cut"},
            },
            "required": ["start_ms", "end_ms", "reason"],
        },
    },
    {
        "name": "undo_cut",
        "description": "Remove a cut from the EDL by its edit ID.",
        "input_schema": {
            "type": "object",
            "properties": {"edit_id": {"type": "string"}},
            "required": ["edit_id"],
        },
    },
    {
        "name": "list_cuts",
        "description": "List all current cuts in the EDL with IDs, timestamps, and reasons.",
        "input_schema": {"type": "object", "properties": {}},
    },
]


class ChatEditorNode:
    name = "podcast_chat_editor"
    inputs = {
        "transcript": "json",
        "edl": "json",
        "user_message": "text",
        "chat_history": "json",
    }
    outputs = {"edl": "json", "assistant_message": "text", "chat_history": "json"}

    def __init__(self):
        self.client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    # ── tool implementations ────────────────────────────────

    def _search_transcript(self, transcript: dict, query: str) -> list[dict]:
        q = query.lower()
        hits = []
        for seg in transcript["segments"]:
            if q in seg["text"].lower():
                hits.append(
                    {
                        "text": seg["text"],
                        "start_ms": seg["start_ms"],
                        "end_ms": seg["end_ms"],
                    }
                )
        return hits[:10]

    def _transcript_around(
        self, transcript: dict, center_ms: int, window_ms: int = 30000
    ) -> list[dict]:
        lo, hi = center_ms - window_ms, center_ms + window_ms
        return [
            {"text": s["text"], "start_ms": s["start_ms"], "end_ms": s["end_ms"]}
            for s in transcript["segments"]
            if s["end_ms"] >= lo and s["start_ms"] <= hi
        ]

    def _run_tool(self, name: str, args: dict, transcript: dict, edl: EditDecisionList) -> dict:
        if name == "search_transcript":
            return {"matches": self._search_transcript(transcript, args["query"])}
        if name == "get_transcript_around":
            return {
                "segments": self._transcript_around(
                    transcript, args["center_ms"], args.get("window_ms", 30000)
                )
            }
        if name == "apply_cut":
            edit = edl.add_cut(args["start_ms"], args["end_ms"], args["reason"], source="agent")
            return {
                "applied": edit.to_dict(),
                "output_duration_ms": edl.output_duration_ms(),
                "total_cuts": len(edl.edits),
            }
        if name == "undo_cut":
            removed = edl.remove_cut(args["edit_id"])
            return {"removed": removed, "total_cuts": len(edl.edits)}
        if name == "list_cuts":
            return {"cuts": [e.to_dict() for e in edl.edits]}
        return {"error": f"unknown tool {name}"}

    # ── main agent loop ─────────────────────────────────────

    def execute(self, inputs: dict) -> dict:
        transcript = inputs["transcript"]
        edl = EditDecisionList.from_dict(inputs["edl"])
        history: list = inputs.get("chat_history") or []

        # Compact transcript context: segment-level only in the system context;
        # the agent pulls word detail via tools when needed
        transcript_summary = "\n".join(
            f"[{s['start_ms']//60000}:{(s['start_ms']//1000)%60:02d}] {s['text']}"
            for s in transcript["segments"]
        )

        messages = history + [{"role": "user", "content": inputs["user_message"]}]

        assistant_text = ""
        for _ in range(MAX_AGENT_TURNS):
            response = self.client.messages.create(
                model=MODEL,
                max_tokens=2000,
                system=SYSTEM_PROMPT
                + f"\n\nTranscript (segment level):\n{transcript_summary}"
                + f"\n\nCurrent EDL stats: {len(edl.edits)} cuts, "
                f"output runtime {edl.output_duration_ms()//60000}m{(edl.output_duration_ms()//1000)%60:02d}s",
                tools=TOOLS,
                messages=messages,
            )

            tool_uses = [b for b in response.content if b.type == "tool_use"]
            texts = [b.text for b in response.content if b.type == "text"]
            if texts:
                assistant_text = "\n".join(texts)

            if response.stop_reason != "tool_use" or not tool_uses:
                break

            messages.append({"role": "assistant", "content": response.content})
            tool_results = []
            for tu in tool_uses:
                result = self._run_tool(tu.name, tu.input, transcript, edl)
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": json.dumps(result),
                    }
                )
            messages.append({"role": "user", "content": tool_results})

        # Persist a serialisable history (strip tool blocks for simplicity in v1)
        new_history = history + [
            {"role": "user", "content": inputs["user_message"]},
            {"role": "assistant", "content": assistant_text},
        ]

        return {
            "edl": edl.to_dict(),
            "assistant_message": assistant_text,
            "chat_history": new_history,
        }
