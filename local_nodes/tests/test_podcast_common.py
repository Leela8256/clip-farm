"""
Unit tests for the pure logic behind the podcast nodes (no engine needed):
    python3 -m unittest discover -s local_nodes/tests -v
"""

from __future__ import annotations
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from local_nodes.podcast_common.clips import (  # noqa: E402
    TimelineMap,
    assign_ids,
    chunk_sentences,
    filler_cuts,
    fmt_timestamp,
    locate_span,
    map_words_to_output,
    merge_chapters,
    parse_candidate_answer,
    parse_chapters,
    parse_timestamp,
    snap_to_sentences,
    snap_to_word_boundaries,
    validate_candidates,
    words_in_range,
)
from local_nodes.podcast_common.captions import build_ass, build_srt, build_vtt, group_words  # noqa: E402
from local_nodes.podcast_common.media import dims, keep_segments  # noqa: E402


def sentences(count: int, length_ms: int = 5000) -> list[dict]:
    return [{'id': i, 'text': f'Sentence number {i} about something.', 'start_ms': i * length_ms, 'end_ms': (i + 1) * length_ms}
            for i in range(count)]


def words(text: str, start_ms: int = 1000, step_ms: int = 400) -> list[dict]:
    return [{'word': w, 'start_ms': start_ms + i * step_ms, 'end_ms': start_ms + i * step_ms + 300, 'probability': 0.9}
            for i, w in enumerate(text.split())]


class TimestampTests(unittest.TestCase):
    def test_round_trip(self):
        self.assertEqual(fmt_timestamp(3_723_000), '1:02:03')
        self.assertEqual(fmt_timestamp(65_000), '01:05')
        self.assertEqual(parse_timestamp('1:02:03'), 3_723_000)
        self.assertEqual(parse_timestamp('02:03.5'), 123_500)
        self.assertEqual(parse_timestamp(1500), 1500)
        self.assertIsNone(parse_timestamp('garbage'))
        self.assertIsNone(parse_timestamp(True))


class ChunkingTests(unittest.TestCase):
    def test_time_chunks_with_overlap_and_tail_merge(self):
        chunks = chunk_sentences(sentences(150), 10 * 60_000, 45_000)  # 12.5 minutes
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[1][0]['start_ms'], 555_000)  # 45 s before the 10-minute mark
        self.assertEqual(chunks[-1][-1]['end_ms'], 750_000)

    def test_short_episode_is_one_chunk(self):
        self.assertEqual(len(chunk_sentences(sentences(12), 10 * 60_000, 45_000)), 1)
        self.assertEqual(chunk_sentences([], 10, 0), [])


class AnswerParsingTests(unittest.TestCase):
    PAYLOAD = {
        'chunk': 1,
        'candidates': [
            {'start': '00:10', 'end': '01:05', 'title': 'A', 'hook': 'h', 'reason': 'r', 'quote': 'q',
             'scores': {'hook': 9, 'clarity': 7, 'standalone': 8}},
            {'start': '00:20', 'end': '01:00', 'title': 'B overlaps A', 'scores': {'hook': 5, 'clarity': 5, 'standalone': 5}},
            {'start': '05:00', 'end': '05:10', 'title': 'too short'},
            {'start': '07:00', 'end': '09:30', 'title': 'too long', 'scores': {'hook': 8, 'clarity': 8, 'standalone': 8}},
            {'start': 'garbage', 'end': '01:00'},
        ],
        'chapters': [{'start': '00:00', 'title': 'Intro'}, {'start': '00:30', 'title': 'too close to intro'}, {'start': '02:00', 'title': 'Next'}],
    }

    def test_parses_fenced_json_and_scores(self):
        cands = parse_candidate_answer('```json\n' + json.dumps(self.PAYLOAD) + '\n```')
        self.assertEqual([c['title'] for c in cands], ['A', 'B overlaps A', 'too short', 'too long'])
        self.assertEqual(cands[0]['score'], 8.1)  # 0.4*9 + 0.3*8 + 0.3*7
        self.assertEqual(cands[2]['scores'], {'hook': 5.0, 'clarity': 5.0, 'standalone': 5.0})

    def test_accepts_dict_and_rejects_junk(self):
        self.assertEqual(len(parse_candidate_answer(self.PAYLOAD)), 4)
        self.assertEqual(parse_candidate_answer('no json here'), [])
        self.assertEqual(parse_candidate_answer(None), [])

    def test_validate_dedupes_trims_and_ranks(self):
        sents = sentences(150)
        kept = validate_candidates(parse_candidate_answer(self.PAYLOAD), 750_000, 20_000, 90_000, 10, sents)
        self.assertEqual([c['title'] for c in kept], ['A', 'too long'])
        self.assertLessEqual(kept[1]['end_ms'] - kept[1]['start_ms'], 90_000)
        self.assertEqual(kept[1]['end_ms'] % 5000, 0)  # trimmed back to a sentence end
        assign_ids(kept)
        self.assertEqual([c['id'] for c in kept], ['c01', 'c02'])

    def test_chapters_merge(self):
        merged = merge_chapters(parse_chapters(self.PAYLOAD), 600_000)
        self.assertEqual([c['title'] for c in merged], ['Intro', 'Next'])
        self.assertEqual(merged[0]['end_ms'], 120_000)
        self.assertEqual(merged[-1]['end_ms'], 600_000)


class SnappingTests(unittest.TestCase):
    def test_sentence_snap(self):
        self.assertEqual(snap_to_sentences(12_300, 61_200, sentences(20)), (10_000, 60_000))
        self.assertEqual(snap_to_sentences(1, 2, []), (1, 2))

    def test_word_snap_pads_into_silence_only(self):
        ws = words('this is um a test of the captions')
        start, end = snap_to_word_boundaries(1050, 3700, ws)
        self.assertEqual(start, 850)  # 150 ms lead-in, no previous word
        self.assertEqual(end, ws[6]['end_ms'] + 100)  # gap to the next word is 100 ms

    def test_locate_span_finds_the_candidate_text(self):
        ws = words("more. That's what I'm saying. It took me getting COVID before I gave Apple TV a chance, and the rest")
        span = locate_span(ws, "That's what I'm saying. It took me getting COVID before I gave Apple TV a chance.")
        self.assertEqual(span, (ws[1]['start_ms'], ws[16]['end_ms']))
        self.assertIsNone(locate_span(ws, 'completely unrelated words here about nothing'))
        self.assertIsNone(locate_span(ws, 'hi'))


class TimelineTests(unittest.TestCase):
    def test_filler_cuts_and_caption_mapping(self):
        ws = words('this is um a test of the captions')
        clip = words_in_range(ws, 850, 4000)
        cuts = filler_cuts(clip, 3150)
        self.assertEqual(len(cuts), 1)
        keep = keep_segments(cuts, 3150)
        timeline = TimelineMap(keep)
        mapped = map_words_to_output(clip, timeline)
        self.assertNotIn('um', [w['word'] for w in mapped])
        self.assertEqual(timeline.total_ms, sum(e - s for s, e in keep))
        groups = group_words(mapped)
        ass = build_ass(groups, 'vertical')
        self.assertIn('PlayResX: 1080', ass)
        self.assertIn('\\k', ass)
        self.assertTrue(build_srt(groups).startswith('1\n00:00:00,'))
        self.assertTrue(build_vtt(groups).startswith('WEBVTT'))

    def test_keep_segments_merges_and_clamps(self):
        self.assertEqual(keep_segments([(100, 300), (200, 500), (900, 2000)], 1000), [(0, 100), (500, 900)])
        self.assertEqual(keep_segments([], 1000), [(0, 1000)])


class GeometryTests(unittest.TestCase):
    def test_dims(self):
        self.assertEqual(dims('vertical', 1920), (1080, 1920))
        self.assertEqual(dims('wide', 1920), (1920, 1080))
        self.assertEqual(dims('vertical', 960), (540, 960))
        with self.assertRaises(ValueError):
            dims('square', 1000)


if __name__ == '__main__':
    unittest.main()
