"""
Edit Decision List (EDL) — the single source of truth for all audio edits.

The EDL is a non-destructive list of cuts. Audio is never modified in place.
Rendering happens once at export time by reading keep_segments derived from edits.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Literal
from datetime import datetime
import json
import uuid


@dataclass
class Edit:
    id: str
    type: Literal["cut"]
    start_ms: int
    end_ms: int
    reason: str
    source: Literal["auto", "agent", "user"]

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "reason": self.reason,
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Edit":
        return cls(**d)


@dataclass
class EditDecisionList:
    job_id: str
    source_file: str
    total_duration_ms: int
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    edits: list[Edit] = field(default_factory=list)

    def add_cut(
        self,
        start_ms: int,
        end_ms: int,
        reason: str,
        source: Literal["auto", "agent", "user"] = "agent",
    ) -> Edit:
        """Add a cut to the EDL. Returns the created Edit."""
        edit = Edit(
            id=f"edit_{uuid.uuid4().hex[:8]}",
            type="cut",
            start_ms=start_ms,
            end_ms=end_ms,
            reason=reason,
            source=source,
        )
        self.edits.append(edit)
        self._sort_edits()
        return edit

    def remove_cut(self, edit_id: str) -> bool:
        """Remove a cut by ID. Returns True if found and removed."""
        before = len(self.edits)
        self.edits = [e for e in self.edits if e.id != edit_id]
        return len(self.edits) < before

    def get_keep_segments(self) -> list[dict]:
        """
        Derive keep_segments from edits. Always recomputed — never stored separately.
        Returns list of {start_ms, end_ms} dicts representing audio to keep.
        """
        if not self.edits:
            return [{"start_ms": 0, "end_ms": self.total_duration_ms}]

        sorted_edits = sorted(self.edits, key=lambda e: e.start_ms)
        segments = []
        cursor = 0

        for edit in sorted_edits:
            if edit.start_ms > cursor:
                segments.append({"start_ms": cursor, "end_ms": edit.start_ms})
            cursor = max(cursor, edit.end_ms)

        if cursor < self.total_duration_ms:
            segments.append({"start_ms": cursor, "end_ms": self.total_duration_ms})

        return segments

    def total_cut_ms(self) -> int:
        return sum(e.end_ms - e.start_ms for e in self.edits)

    def output_duration_ms(self) -> int:
        return self.total_duration_ms - self.total_cut_ms()

    def _sort_edits(self):
        self.edits.sort(key=lambda e: e.start_ms)

    def to_dict(self) -> dict:
        return {
            "job_id": self.job_id,
            "source_file": self.source_file,
            "total_duration_ms": self.total_duration_ms,
            "created_at": self.created_at,
            "edits": [e.to_dict() for e in self.edits],
            "keep_segments": self.get_keep_segments(),
            "stats": {
                "total_cuts": len(self.edits),
                "total_cut_ms": self.total_cut_ms(),
                "output_duration_ms": self.output_duration_ms(),
            },
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)

    @classmethod
    def from_dict(cls, d: dict) -> "EditDecisionList":
        edl = cls(
            job_id=d["job_id"],
            source_file=d["source_file"],
            total_duration_ms=d["total_duration_ms"],
            created_at=d.get("created_at", datetime.utcnow().isoformat()),
        )
        edl.edits = [Edit.from_dict(e) for e in d.get("edits", [])]
        return edl

    @classmethod
    def from_json(cls, s: str) -> "EditDecisionList":
        return cls.from_dict(json.loads(s))
