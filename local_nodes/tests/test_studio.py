"""
Unit tests for the whole-episode editing studio (no engine, no ffmpeg):
    python3 -m unittest discover -s local_nodes/tests -v
"""

from __future__ import annotations
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from local_nodes.podcast_common import studio  # noqa: E402
from local_nodes.podcast_common.media import keep_segments  # noqa: E402


def words(spec: str, start_ms: int = 0, word_ms: int = 300, gap_ms: int = 100, confidence: float = 0.9) -> list[dict]:
    """'one two three' → evenly spaced words starting at start_ms."""
    out, t = [], start_ms
    for text in spec.split():
        out.append({'word': text, 'start_ms': t, 'end_ms': t + word_ms, 'probability': confidence})
        t += word_ms + gap_ms
    return out


def edits(operations: list[dict], **extra) -> dict:
    return {'schema_version': 1, 'version': 4, 'operations': operations, **extra}


class OperationTests(unittest.TestCase):
    def test_disabled_ops_are_kept_but_never_applied(self):
        ops = studio.normalize_operations(edits([
            {'id': 'e001', 'type': 'cut', 'start_ms': 1000, 'end_ms': 2000, 'enabled': True},
            {'id': 'e002', 'type': 'cut', 'start_ms': 4000, 'end_ms': 5000, 'enabled': False},
        ]), 10_000)
        self.assertEqual(ops['cuts'], [(1000, 2000)])
        self.assertEqual(ops['applied'], 1)
        self.assertEqual(ops['version'], 4)

    def test_ranges_are_clamped_and_overlapping_cuts_merged(self):
        ops = studio.normalize_operations(edits([
            {'id': 'e1', 'type': 'cut', 'start_ms': -500, 'end_ms': 2000},
            {'id': 'e2', 'type': 'cut', 'start_ms': 1500, 'end_ms': 3000},
            {'id': 'e3', 'type': 'cut', 'start_ms': 9500, 'end_ms': 99_000},
            {'id': 'e4', 'type': 'cut', 'start_ms': 20_000, 'end_ms': 30_000},
        ]), 10_000)
        self.assertEqual(ops['cuts'], [(0, 3000), (9500, 10_000)])
        self.assertTrue(any('outside the recording' in w for w in ops['warnings']))

    def test_mutes_and_bleeps_stay_separate(self):
        ops = studio.normalize_operations(edits([
            {'id': 'e1', 'type': 'mute', 'start_ms': 100, 'end_ms': 200},
            {'id': 'e2', 'type': 'bleep', 'start_ms': 300, 'end_ms': 400},
            {'id': 'e3', 'type': 'wobble', 'start_ms': 500, 'end_ms': 600},
        ]), 10_000)
        self.assertEqual(ops['mutes'], [(100, 200)])
        self.assertEqual(ops['bleeps'], [(300, 400)])
        self.assertEqual(ops['cuts'], [])
        self.assertTrue(any('unknown kind' in w for w in ops['warnings']))

    def test_a_foreign_schema_version_is_refused(self):
        ops = studio.normalize_operations({'schema_version': 7, 'operations': [
            {'type': 'cut', 'start_ms': 0, 'end_ms': 1000}]}, 10_000)
        self.assertEqual(ops['cuts'], [])
        self.assertTrue(ops['warnings'])

    def test_cut_edges_snap_outward_to_the_word_gap(self):
        spoken = words('one two three four')          # 0-300, 400-700, 800-1100, 1200-1500
        ops = studio.normalize_operations(edits([
            {'type': 'cut', 'start_ms': 380, 'end_ms': 1150},                     # both edges within 120 ms
        ]), 5000, spoken)
        self.assertEqual(ops['cuts'], [(300, 1200)])

    def test_edges_further_than_the_tolerance_are_left_alone(self):
        spoken = words('one two three four')
        ops = studio.normalize_operations(edits([
            {'type': 'cut', 'start_ms': 600, 'end_ms': 1000},
        ]), 5000, spoken)
        self.assertEqual(ops['cuts'], [(600, 1000)])


class ShortenSilenceTests(unittest.TestCase):
    def test_the_middle_goes_and_the_target_survives(self):
        cut = studio.shorten_silence_cut(840_100, 843_400, 600)
        self.assertEqual(cut, (840_400, 843_100))
        silence_left = (cut[0] - 840_100) + (843_400 - cut[1])
        self.assertEqual(silence_left, 600)

    def test_never_leaves_less_than_150_ms_a_side(self):
        cut = studio.shorten_silence_cut(0, 2000, 0)
        self.assertEqual(cut, (150, 1850))

    def test_a_silence_already_short_enough_is_untouched(self):
        self.assertIsNone(studio.shorten_silence_cut(1000, 1500, 600))

    def test_the_operation_becomes_a_plain_cut(self):
        ops = studio.normalize_operations(edits([
            {'id': 'e4', 'type': 'shorten_silence', 'start_ms': 840_100, 'end_ms': 843_400, 'target_ms': 600},
        ]), 900_000)
        self.assertEqual(ops['cuts'], [(840_400, 843_100)])


class TimelineMapTests(unittest.TestCase):
    def setUp(self):
        self.keep = keep_segments([(2000, 4000)], 10_000, min_keep_ms=studio.MIN_PIECE_MS)
        self.map = studio.timeline_map(self.keep)

    def test_source_and_output_agree(self):
        self.assertEqual(self.keep, [(0, 2000), (4000, 10_000)])
        self.assertEqual(self.map.total_ms, 8000)
        self.assertEqual(self.map.to_output(1000), 1000)
        self.assertEqual(self.map.to_output(5000), 3000)
        self.assertIsNone(self.map.to_output(3000))

    def test_map_segments_carry_the_output_offset(self):
        self.assertEqual(studio.map_segments(self.map), [[0, 2000, 0], [4000, 10_000, 2000]])

    def test_captions_are_mapped_through_the_cuts(self):
        spoken = (words('hello there friend', start_ms=0)
                  + words('cut me away please', start_ms=2200)
                  + words('welcome back everyone', start_ms=4200))
        groups = studio.caption_groups(spoken, self.map)
        text = ' '.join(g['text'] for g in groups)
        self.assertIn('hello there friend', text)
        self.assertIn('welcome back everyone', text)
        self.assertNotIn('cut me away', text)
        for group in groups:
            self.assertLessEqual(group['end_ms'], self.map.total_ms)

    def test_caption_groups_carry_the_speaker(self):
        spoken = words('one two three', start_ms=0) + words('four five six', start_ms=5000)
        groups = studio.caption_groups(spoken, self.map, [[0, 2000, 's1'], [4000, 10_000, 's2']])
        self.assertEqual(groups[0]['speaker'], 's1')
        self.assertEqual(groups[-1]['speaker'], 's2')


class ChapterTests(unittest.TestCase):
    def test_chapters_move_and_a_fully_cut_one_disappears(self):
        keep = keep_segments([(2500, 5400)], 10_000, min_keep_ms=studio.MIN_PIECE_MS)
        chapters, warnings = studio.map_chapters(
            [{'id': 'sec01', 'title': 'Intro', 'start_ms': 0},
             {'id': 'sec02', 'title': 'Gone', 'start_ms': 3000},
             {'id': 'sec03', 'title': 'After', 'start_ms': 5400}],
            studio.timeline_map(keep), 10_000)
        self.assertEqual([c['title'] for c in chapters], ['Intro', 'After'])
        self.assertEqual([c['out_ms'] for c in chapters], [0, 2500])
        self.assertTrue(any('Gone' in w for w in warnings))

    def test_a_chapter_whose_start_is_cut_moves_to_its_first_surviving_moment(self):
        keep = keep_segments([(3000, 4000)], 10_000, min_keep_ms=studio.MIN_PIECE_MS)
        chapters, _ = studio.map_chapters([{'title': 'Middle', 'start_ms': 3200}], studio.timeline_map(keep), 10_000)
        self.assertEqual(chapters[0]['out_ms'], 3000)


class SuggestionTests(unittest.TestCase):
    def episode(self):
        return (words('so um this is the show', start_ms=2000)
                + words('i think i think we should start', start_ms=12_000)
                + words('this is damn good', start_ms=20_000)
                + words('we are done here', start_ms=50_000))

    def test_levels_are_nested(self):
        doc = studio.build_suggestions(self.episode(), silences=[(8000, 11_000), (18_000, 19_000)],
                                       quiet=[(30_000, 32_000)], low_confidence=[(23_000, 23_600)],
                                       sentences=[], duration_ms=60_000)
        modes = doc['modes']
        self.assertTrue(set(modes['natural']) <= set(modes['balanced']) <= set(modes['tight']))
        self.assertEqual(set(modes['tight']), {s['id'] for s in doc['suggestions']})
        for s in doc['suggestions']:
            self.assertIn(s['level'], studio.LEVELS)
            self.assertIn(s['action'], ('cut', 'mute', 'bleep', 'shorten_silence'))
            self.assertLess(s['start_ms'], s['end_ms'])

    def test_every_kind_is_found(self):
        doc = studio.build_suggestions(self.episode(), silences=[(8000, 11_000)], quiet=[(30_000, 32_000)],
                                       low_confidence=[(23_000, 23_600)],
                                       sentences=[{'start_ms': 34_000, 'end_ms': 38_000, 'text': 'We are going to talk about editing today.'},
                                                  {'start_ms': 44_000, 'end_ms': 48_000, 'text': 'We are going to talk about editing today!'}],
                                       duration_ms=60_000)
        kinds = {s['kind'] for s in doc['suggestions']}
        self.assertIn('filler', kinds)          # "um"
        self.assertIn('pause', kinds)           # the 3 s silence
        self.assertIn('false_start', kinds)     # "i think i think"
        self.assertIn('repeat', kinds)          # the sentence said twice
        self.assertIn('profanity', kinds)       # "damn" → bleep
        self.assertIn('quiet', kinds)
        self.assertIn('low_confidence', kinds)
        self.assertIn('dead_air_start', kinds)  # 2 s before the first word
        self.assertIn('dead_air_end', kinds)

    def test_ids_follow_the_documented_shape(self):
        doc = studio.build_suggestions(self.episode(), silences=[(8000, 11_000)], quiet=[(30_000, 32_000)],
                                       low_confidence=[(23_000, 23_600)], duration_ms=60_000)
        by_kind = {s['kind']: s['id'] for s in doc['suggestions']}
        self.assertEqual(by_kind['filler'], 'f001')
        self.assertEqual(by_kind['pause'], 'p001')
        self.assertEqual(by_kind['false_start'], 'fs01')
        self.assertEqual(by_kind['profanity'], 'pr01')
        self.assertEqual(by_kind['quiet'], 'q01')
        self.assertEqual(by_kind['low_confidence'], 'lc01')
        self.assertEqual(by_kind['dead_air_start'], 'd01')

    def test_suggestions_never_overlap_and_ids_are_stable(self):
        first = studio.build_suggestions(self.episode(), silences=[(8000, 11_000)], duration_ms=60_000)
        second = studio.build_suggestions(self.episode(), silences=[(8000, 11_000)], duration_ms=60_000)
        self.assertEqual([s['id'] for s in first['suggestions']], [s['id'] for s in second['suggestions']])
        spans = [(s['start_ms'], s['end_ms']) for s in first['suggestions']]
        for i, span in enumerate(spans):
            self.assertFalse(studio.overlaps(span, spans[:i]))

    def test_selecting_a_level_returns_the_nested_set(self):
        doc = studio.build_suggestions(self.episode(), silences=[(8000, 11_000)], duration_ms=60_000)
        natural = {s['id'] for s in studio.suggestions_for_level(doc, 'natural')}
        tight = {s['id'] for s in studio.suggestions_for_level(doc, 'tight')}
        self.assertTrue(natural <= tight)
        self.assertEqual(natural, set(doc['modes']['natural']))


class RangeAndWordTests(unittest.TestCase):
    def test_word_rows_round_trip(self):
        spoken = words('a b c', confidence=0.812)
        rows = studio.compact_words(spoken)
        self.assertEqual(sorted(rows[0]), ['c', 'e', 's', 'w'])
        self.assertEqual(studio.expand_words(rows), spoken)

    def test_range_is_parsed_and_clamped(self):
        self.assertEqual(studio.parse_range('1000-5000', 4000)[0], [1000, 4000])
        self.assertIsNone(studio.parse_range('nonsense', 4000)[0])
        self.assertIsNone(studio.parse_range(None, 4000)[0])
        self.assertIsNone(studio.parse_range('1000-1100', 4000)[0])

    def test_silences_from_words(self):
        spoken = words('one two', start_ms=1000) + words('three', start_ms=5000)
        found = studio.silences_from_words(spoken, 8000)
        self.assertIn((0, 1000), found)
        self.assertIn((1700, 5000), found)
        self.assertIn((5300, 8000), found)

    def test_silences_are_carved_around_speech(self):
        spoken = words('one two', start_ms=1000) + words('three', start_ms=5000)
        found = studio.speech_free_silences([(500, 6000)], spoken)
        self.assertEqual(found, [(1700, 5000), (5300, 6000)])   # 500-1000 is too short to keep

    def test_subtract_ranges(self):
        self.assertEqual(studio.subtract_ranges([(0, 1000)], [(200, 400)]), [(0, 200), (400, 1000)])
        self.assertEqual(studio.subtract_ranges([(0, 1000)], [(0, 1000)]), [])
        self.assertEqual(studio.subtract_ranges([(0, 1000)], []), [(0, 1000)])

    def test_low_confidence_runs(self):
        spoken = words('clear words here', confidence=0.95) + words('mumble mumble', start_ms=3000, confidence=0.2)
        self.assertEqual(studio.low_confidence_ranges(spoken), [(3000, 3700)])

    def test_quiet_ranges_skip_silence(self):
        peaks = [0.9] * 10 + [0.05] * 20 + [0.9] * 10 + [0.0] * 20
        found = studio.quiet_ranges(peaks, silences=[(4000, 6000)])
        self.assertEqual(found, [(1000, 3000)])


class PreparedSpecTests(unittest.TestCase):
    def spec(self, **over):
        spoken = (words('welcome to the show', start_ms=0)
                  + words('this bit is cut away', start_ms=2200)
                  + words('and we are back again', start_ms=4200))
        payload = dict(
            project='projects/ep12', episode_id='ep12', source='projects/ep12/source/ep.mp4',
            media={'width': 1920, 'height': 1080, 'fps': 30, 'duration_ms': 10_000, 'has_video': True},
            edits=edits(
                [{'id': 'e001', 'type': 'cut', 'start_ms': 2000, 'end_ms': 4000, 'enabled': True},
                 {'id': 'e002', 'type': 'mute', 'start_ms': 5000, 'end_ms': 5200, 'enabled': True},
                 {'id': 'e003', 'type': 'bleep', 'start_ms': 6000, 'end_ms': 6300, 'enabled': True}],
                sections=[{'id': 'sec01', 'title': 'Intro', 'start_ms': 0},
                          {'id': 'sec02', 'title': 'Cut away', 'start_ms': 2500},
                          {'id': 'sec03', 'title': 'Back', 'start_ms': 3800}],
                speakers={'s1': {'name': 'Ada', 'color': '#FF4D2E'}},
                assets={'intro': {'path': 'projects/ep12/assets/intro.mp4'},
                        'logo': {'path': 'projects/ep12/assets/missing.png'},
                        'title_card': {'text': 'Episode 12', 'seconds': 3}},
                title='Episode 12'),
            words=spoken, quality='rough', mode='preview',
            asset_exists=lambda path: 'missing' not in path,
        )
        payload.update(over)
        return studio.build_prepared(**payload)

    def test_keep_map_and_output_duration(self):
        spec = self.spec()
        self.assertEqual(spec['keep'], [[0, 2000], [4000, 10_000]])
        self.assertEqual(spec['output_duration_ms'], 8000)
        self.assertEqual(spec['map'], [[0, 2000, 0], [4000, 10_000, 2000]])
        self.assertEqual(spec['mutes'], [[5000, 5200]])
        self.assertEqual(spec['bleeps'], [[6000, 6300]])
        self.assertEqual(spec['schema_version'], 1)
        self.assertTrue(spec['studio'])

    def test_captions_and_chapters_land_on_the_output_timeline(self):
        spec = self.spec()
        text = ' '.join(g['text'] for g in spec['captions']['groups'])
        self.assertIn('welcome to the show', text)
        self.assertNotIn('this bit is cut', text)
        self.assertEqual([c['title'] for c in spec['chapters']], ['Intro', 'Back'])
        self.assertEqual([c['out_ms'] for c in spec['chapters']], [0, 2000])
        self.assertEqual(spec['captions']['speaker_colors'], {'s1': '#FF4D2E'})

    def test_missing_assets_are_dropped_with_a_warning(self):
        spec = self.spec()
        self.assertIn('intro', spec['assets'])
        self.assertIn('title_card', spec['assets'])
        self.assertNotIn('logo', spec['assets'])
        self.assertTrue(any('logo' in w for w in spec['warnings']))

    def test_version_and_quality_pass_through(self):
        self.assertEqual(self.spec()['version'], 4)                     # from the edit file
        self.assertEqual(self.spec(version=9)['version'], 9)            # the question wins
        self.assertEqual(self.spec(version='9')['version'], 9)          # context values arrive as text
        self.assertEqual(self.spec(version='nonsense')['version'], 4)   # unreadable → the saved version
        self.assertEqual(self.spec(quality='full')['quality'], 'full')
        self.assertEqual(self.spec(range_text='1000-3000')['range'], [1000, 3000])
        self.assertIsNone(self.spec()['range'])

    def test_defaults_fill_in_for_an_empty_edit_file(self):
        spec = self.spec(edits={})
        self.assertEqual(spec['keep'], [[0, 10_000]])
        self.assertEqual(spec['output_duration_ms'], 10_000)
        self.assertEqual(spec['audio']['loudness_lufs'], -16)
        self.assertEqual(spec['visual']['aspect_ratio'], '16:9')
        self.assertEqual(spec['visual']['caption_style']['preset'], 'clean')
        self.assertEqual(spec['version'], 1)

    def test_edit_settings_override_the_defaults(self):
        spec = self.spec(edits=edits([], audio={'master': False}, visual={'aspect_ratio': '9:16', 'captions': False,
                                                                          'caption_style': {'karaoke': True}},
                                     extra_aspects=['1:1']))
        self.assertFalse(spec['audio']['master'])
        self.assertTrue(spec['audio']['high_pass'])
        self.assertEqual(spec['visual']['aspect_ratio'], '9:16')
        self.assertTrue(spec['visual']['caption_style']['karaoke'])
        self.assertEqual(spec['visual']['caption_style']['position'], 'bottom')
        self.assertFalse(spec['captions']['enabled'])
        self.assertEqual(spec['extra_aspects'], ['1:1'])


class DocumentTests(unittest.TestCase):
    def test_timeline_document(self):
        doc = studio.timeline_doc(episode_id='ep12', duration_ms=10_000, model='small',
                                  words=words('one two three'), silences=[(4000, 5000), (4500, 6000)],
                                  quiet=[], low_confidence=[], sentence_count=3, language='en')
        self.assertEqual(doc['schema_version'], 1)
        self.assertEqual(doc['silences'], [[4000, 6000]])
        self.assertEqual(len(doc['words']), 3)
        self.assertEqual(doc['sentence_count'], 3)

    def test_waveform_document(self):
        doc = studio.waveform_doc([0.1, 0.5, 1.0], 300)
        self.assertEqual(doc['per_second'], 10)
        self.assertEqual(doc['peaks'], [0.1, 0.5, 1.0])
        self.assertEqual(doc['duration_ms'], 300)


if __name__ == '__main__':
    unittest.main()
