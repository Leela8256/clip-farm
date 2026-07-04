"""Tests for the EditDecisionList model — the pipeline's single source of truth."""

from __future__ import annotations

from utils.edl import EditDecisionList


def _edl(total_ms=100_000):
    return EditDecisionList(job_id="test", source_file="test.mp3", total_duration_ms=total_ms)


def test_no_edits_keeps_entire_duration():
    edl = _edl()
    assert edl.get_keep_segments() == [{"start_ms": 0, "end_ms": 100_000}]
    assert edl.output_duration_ms() == 100_000


def test_single_cut_produces_two_keep_segments():
    edl = _edl()
    edl.add_cut(10_000, 15_000, reason="test")
    assert edl.get_keep_segments() == [
        {"start_ms": 0, "end_ms": 10_000},
        {"start_ms": 15_000, "end_ms": 100_000},
    ]
    assert edl.output_duration_ms() == 95_000


def test_cuts_are_sorted_regardless_of_insertion_order():
    edl = _edl()
    edl.add_cut(50_000, 55_000, reason="second")
    edl.add_cut(10_000, 15_000, reason="first")
    assert [e.start_ms for e in edl.edits] == [10_000, 50_000]


def test_overlapping_cuts_merge_into_one_gap():
    """Two overlapping cuts must not produce a zero-length or negative keep segment."""
    edl = _edl()
    edl.add_cut(10_000, 20_000, reason="a")
    edl.add_cut(15_000, 25_000, reason="b")
    keep = edl.get_keep_segments()
    assert keep == [
        {"start_ms": 0, "end_ms": 10_000},
        {"start_ms": 25_000, "end_ms": 100_000},
    ]


def test_adjacent_cuts_merge():
    edl = _edl()
    edl.add_cut(10_000, 20_000, reason="a")
    edl.add_cut(20_000, 30_000, reason="b")
    keep = edl.get_keep_segments()
    assert keep == [
        {"start_ms": 0, "end_ms": 10_000},
        {"start_ms": 30_000, "end_ms": 100_000},
    ]


def test_cut_covering_entire_duration_yields_no_keep_segments():
    edl = _edl()
    edl.add_cut(0, 100_000, reason="everything")
    assert edl.get_keep_segments() == []


def test_undo_cut_restores_original_keep_segments():
    edl = _edl()
    edit = edl.add_cut(10_000, 15_000, reason="test")
    assert edl.output_duration_ms() == 95_000
    removed = edl.remove_cut(edit.id)
    assert removed is True
    assert edl.get_keep_segments() == [{"start_ms": 0, "end_ms": 100_000}]


def test_undo_unknown_edit_id_returns_false():
    edl = _edl()
    assert edl.remove_cut("nonexistent") is False


def test_keep_segments_never_stored_only_derived():
    """AGENTS.md hard constraint: keep_segments must always be recomputed, never cached."""
    edl = _edl()
    edl.add_cut(10_000, 15_000, reason="test")
    first = edl.get_keep_segments()
    edl.add_cut(50_000, 60_000, reason="second")
    second = edl.get_keep_segments()
    assert first != second  # proves it wasn't a stale cached value


def test_to_dict_and_from_dict_round_trip():
    edl = _edl()
    edl.add_cut(10_000, 15_000, reason="test", source="agent")
    restored = EditDecisionList.from_dict(edl.to_dict())
    assert restored.get_keep_segments() == edl.get_keep_segments()
    assert restored.edits[0].reason == "test"
    assert restored.edits[0].source == "agent"


def test_stats_reflect_total_cuts_and_durations():
    edl = _edl()
    edl.add_cut(10_000, 15_000, reason="a")
    edl.add_cut(50_000, 52_000, reason="b")
    stats = edl.to_dict()["stats"]
    assert stats["total_cuts"] == 2
    assert stats["total_cut_ms"] == 7_000
    assert stats["output_duration_ms"] == 93_000
