"""
The media_io contract, with no application anywhere in sight: option parsing,
the piece hand-off and the reference the node forwards.

The node package imports the engine's rocketlib, so the library half is loaded
straight from its file — these tests exercise the contract, not the wiring:
    python3 -m unittest discover -s local_nodes/tests -v
"""

from __future__ import annotations
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


media_lib = _load('media_io_media_lib', ROOT / 'local_nodes/media_io/media_lib.py')

from local_nodes.podcast_common.reference import (  # noqa: E402
    media_reference,
    piece_offsets,
    pieces_block,
    ref_project,
)


def pieces(*spans: tuple[int, int]) -> list[dict]:
    """split_audio's output shape: index, offset and measured length per piece."""
    return [{'index': i, 'path': Path(f'piece{i:04d}.wav'), 'offset_ms': a, 'duration_ms': b - a}
            for i, (a, b) in enumerate(spans)]


class OptionTests(unittest.TestCase):
    def test_piece_length_stays_inside_one_transcriber_buffer(self):
        self.assertEqual(media_lib.clamp_piece_seconds(45), 45)
        self.assertEqual(media_lib.clamp_piece_seconds(600), 58)      # never a whole buffer or more
        self.assertEqual(media_lib.clamp_piece_seconds(1), 10)
        self.assertEqual(media_lib.clamp_piece_seconds('30'), 30)     # context values arrive as text
        self.assertEqual(media_lib.clamp_piece_seconds('nonsense'), 45)

    def test_ranges_and_ordinals_are_read_or_ignored(self):
        self.assertEqual(media_lib.parse_range('1000-4000'), (1000, 4000))
        self.assertEqual(media_lib.parse_range('1000..4000'), (1000, 4000))
        self.assertIsNone(media_lib.parse_range('-500-4000'))   # a minus is a separator, not a sign
        self.assertIsNone(media_lib.parse_range('4000-1000'))
        self.assertIsNone(media_lib.parse_range('banana'))
        self.assertIsNone(media_lib.parse_range(None))
        self.assertEqual(media_lib.parse_ordinals('0,1, 4'), {0, 1, 4})
        self.assertEqual(media_lib.parse_ordinals('2;3'), {2, 3})
        self.assertEqual(media_lib.parse_ordinals('x,5'), {5})
        self.assertEqual(media_lib.parse_ordinals(''), set())

    def test_piece_names_sort_in_stream_order(self):
        names = [media_lib.piece_name(i) for i in (0, 9, 10, 100)]
        self.assertEqual(names, ['piece0000.wav', 'piece0009.wav', 'piece0010.wav', 'piece0100.wav'])
        self.assertEqual(sorted(names), names)

    def test_probe_payload_answers_the_questions_it_promises(self):
        payload = media_lib.probe_payload(
            {'duration_ms': 61_000, 'width': 1920, 'height': 1080, 'fps': 30.0, 'has_video': True,
             'has_audio': True, 'size_bytes': 4096}, 'library/talk.mp4')
        for key in ('duration_ms', 'width', 'height', 'fps', 'has_video', 'has_audio', 'size'):
            self.assertIn(key, payload)
        self.assertEqual(payload['size'], 4096)
        self.assertEqual(payload['source'], 'library/talk.mp4')


class ReferenceTests(unittest.TestCase):
    MEDIA = {'duration_ms': 100_000, 'width': 1280, 'height': 720, 'fps': 25.0,
             'has_video': True, 'has_audio': True, 'size_bytes': 10}

    def ref(self, **over):
        payload = dict(source='library/talk.mp4', mode='transcribe_feed', media=self.MEDIA,
                       context={'source': 'library/talk.mp4', 'project': 'projects/ep1'},
                       streamed=pieces((0, 45_000), (45_000, 90_000), (90_000, 100_000)),
                       piece_seconds=45, pieces_total=3)
        payload.update(over)
        return media_lib.build_reference(**payload)

    def test_pieces_are_the_intervals_that_were_streamed_in_stream_order(self):
        ref = self.ref()
        self.assertEqual(ref['pieces'], [[0, 45_000], [45_000, 90_000], [90_000, 100_000]])
        self.assertEqual(ref['piece_indices'], [0, 1, 2])
        self.assertEqual(ref['pieces_total'], 3)
        self.assertEqual(ref['kind'], 'media_io_reference')

    def test_a_resumed_run_only_carries_what_it_streamed(self):
        streamed = pieces((0, 45_000), (45_000, 90_000), (90_000, 100_000))[2:]
        ref = self.ref(streamed=streamed, skipped={0, 1}, pieces_total=3)
        self.assertEqual(ref['pieces'], [[90_000, 100_000]])
        self.assertEqual(ref['piece_indices'], [2])
        self.assertEqual(ref['skipped'], [0, 1])
        # stream 0 of THIS run is piece 2 of the recording
        offsets, indices, _ = piece_offsets(ref)
        self.assertEqual((offsets[0], indices[0]), (90_000, 2))

    def test_a_timestamp_is_placed_by_its_stream_index(self):
        ref = self.ref()
        offsets, indices, piece_ms = piece_offsets(ref)
        # "sentence 1.2 s into the stream the transcriber was fed" for each piece
        self.assertEqual([offsets[k] + 1200 for k in (0, 1, 2)], [1200, 46_200, 91_200])
        self.assertEqual(indices, [0, 1, 2])
        self.assertEqual(piece_ms, 45_000)

    def test_measured_offsets_beat_the_nominal_grid(self):
        # ffmpeg cuts on frame boundaries: piece 1 is 44.98 s, not 45 s
        ref = self.ref(streamed=pieces((0, 44_980), (44_980, 89_950)), pieces_total=2)
        offsets, _, _ = piece_offsets(ref)
        self.assertEqual(offsets, [0, 44_980])

    def test_the_callers_context_and_question_come_back(self):
        ref = self.ref(question='find the best moments')
        self.assertEqual(ref_project(ref), 'projects/ep1')
        self.assertEqual(ref['context']['source'], 'library/talk.mp4')
        self.assertEqual(ref['question'], 'find the best moments')
        self.assertEqual(ref_project({'context': {}}), '')

    def test_the_reference_survives_the_text_lane(self):
        import json

        parsed = media_reference(json.dumps(self.ref()))
        self.assertEqual(parsed['source'], 'library/talk.mp4')
        self.assertIsNone(media_reference('not json'))
        self.assertIsNone(media_reference(json.dumps([1, 2, 3])))
        self.assertIsNone(media_reference(json.dumps({'no': 'source'})))

    def test_the_transcript_record_keeps_its_old_shape(self):
        block = pieces_block(self.ref(streamed=pieces((0, 45_000), (45_000, 90_000))[1:],
                                      skipped={0}, pieces_total=2))
        self.assertEqual(block, {'seconds': 45, 'total': 2, 'count': 1, 'resumed': 1,
                                 'indices': [1], 'offsets_ms': [45_000], 'durations_ms': [45_000]})

    def test_a_detect_copy_reference_says_what_the_copy_is(self):
        ref = media_lib.build_reference(source='library/talk.mp4', mode='detect_copy', media=self.MEDIA,
                                        detect={'width': 640, 'fps': 10, 'source_width': 1280,
                                                'source_height': 720})
        self.assertEqual(ref['detect']['width'], 640)
        self.assertEqual(ref['pieces'], [])
        # a consumer scales detections back to source pixels with these two
        self.assertEqual(ref['detect']['source_width'] / ref['detect']['width'], 2.0)


if __name__ == '__main__':
    unittest.main()
