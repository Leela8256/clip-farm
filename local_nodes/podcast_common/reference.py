"""
The app's reading of a `media_io` reference.

media_io is generic: it knows a source file, the intervals it streamed and the
context keys its caller wrote. This module turns that into what the podcast
nodes need — which project the run belongs to, and where each streamed piece
sits on the recording — without teaching the generic node anything about
projects.

The reference (text lane):

    {"kind": "media_io_reference", "source": "projects/ep1/source/ep.mp4",
     "media": {...}, "duration_ms": 3_600_000,
     "pieces": [[0, 45_000], [45_000, 90_000], ...],   # streamed THIS run, in stream order
     "piece_indices": [0, 1, ...],                     # their ordinals in the full grid
     "pieces_total": 80, "piece_seconds": 45, "skipped": [],
     "question": "...", "context": {"project": "projects/ep1", ...}}

A sentence stamped by the transcriber at `in_piece_ms` inside stream `k` sits
at `pieces[k][0] + in_piece_ms` on the recording. That indirection is the
whole reason the pieces exist: the stock transcriber stamps relative to the
buffer it flushed, never to the file.
"""

from __future__ import annotations
import json


def media_reference(text) -> dict | None:
    """A media_io reference travelling on a text lane, or None for anything else."""
    if isinstance(text, dict):
        data = text
    else:
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            return None
    if not isinstance(data, dict):
        return None
    if data.get('kind') == 'media_io_reference' or data.get('source') or data.get('project'):
        return data
    return None


def ref_context(ref: dict | None) -> dict:
    ctx = (ref or {}).get('context')
    return ctx if isinstance(ctx, dict) else {}


def ref_project(ref: dict | None) -> str:
    """The project root the caller named in the question context ('project: projects/<episode>')."""
    root = ref_context(ref).get('project') or (ref or {}).get('project') or ''
    return str(root).strip().strip('/')


def piece_offsets(ref: dict | None) -> tuple[list[int], list[int], int]:
    """(start of every streamed piece, its ordinal in the full grid, the nominal piece length in ms)."""
    ref = ref or {}
    pieces = [p for p in (ref.get('pieces') or []) if isinstance(p, (list, tuple)) and len(p) >= 2]
    offsets = [int(p[0]) for p in pieces]
    indices = [int(i) for i in (ref.get('piece_indices') or [])]
    if len(indices) < len(offsets):                    # a reference without ordinals: stream order it is
        indices = indices + list(range(len(indices), len(offsets)))
    return offsets, indices, int(float(ref.get('piece_seconds') or 0) * 1000)


def pieces_block(ref: dict | None) -> dict:
    """
    The transcript's own record of the hand-off, in the shape the analysis files
    have always carried: how long a piece is, how many there are, how many were
    streamed this run and where each of them starts.
    """
    ref = ref or {}
    offsets, indices, _ = piece_offsets(ref)
    pieces = [p for p in (ref.get('pieces') or []) if isinstance(p, (list, tuple)) and len(p) >= 2]
    skipped = [int(i) for i in (ref.get('skipped') or [])]
    return {'seconds': int(ref.get('piece_seconds') or 0),
            'total': int(ref.get('pieces_total') or len(pieces)),
            'count': len(pieces), 'resumed': len(skipped),
            'indices': indices[:len(pieces)], 'offsets_ms': offsets,
            'durations_ms': [int(p[1]) - int(p[0]) for p in pieces]}
