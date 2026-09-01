"""
Prompt Director logic (no engine needed):
    python3 -m unittest discover -s local_nodes/tests -v
"""

from __future__ import annotations
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from local_nodes.podcast_common.spec import normalize_spec, duration_window, describe_spec  # noqa: E402
from local_nodes.podcast_common.constraints import (  # noqa: E402
    check_constraints,
    director_score,
    find_profanity,
    parse_director_answer,
    request_compliance,
    select_candidates,
)
from local_nodes.podcast_common.editing import (  # noqa: E402
    cut_ranges,
    fit_duration,
    filler_cut_safety,
    mute_ranges,
    plan_cuts,
    rendered_ms,
    silence_cut_safety,
)


def sentences(count: int, length_ms: int = 5000, text: str = 'Sentence number {i} about the startup.') -> list[dict]:
    return [{'id': i, 'text': text.format(i=i), 'start_ms': i * length_ms, 'end_ms': (i + 1) * length_ms} for i in range(count)]


def words(text: str, start_ms: int = 0, step_ms: int = 400, length_ms: int = 300, probability: float = 0.9) -> list[dict]:
    return [{'word': w, 'start_ms': start_ms + i * step_ms, 'end_ms': start_ms + i * step_ms + length_ms, 'probability': probability}
            for i, w in enumerate(text.split())]


class SpecTests(unittest.TestCase):
    def test_example_prompt_spec(self):
        spec = normalize_spec({
            'count': 3, 'target_duration_seconds': 42, 'duration_mode': 'natural', 'speaker': 'Sarah',
            'topic': 'why the startup failed', 'hook': 'surprising statement', 'ending': 'complete takeaway',
            'remove_fillers': True, 'exclude': ['profanity'], 'aspect_ratio': '9:16', 'caption_preset': 'yellow-bold',
        })
        self.assertEqual(spec['count'], 3)
        self.assertEqual(spec['duration'], {'target_seconds': 42, 'min_seconds': None, 'max_seconds': None, 'mode': 'natural'})
        self.assertEqual(spec['speakers'], ['Sarah'])
        self.assertEqual(spec['subjects'], ['why the startup failed'])
        self.assertEqual(spec['exclude_content'], ['profanity'])
        self.assertEqual(spec['filler_policy'], 'smart')
        self.assertEqual(spec['caption_preset'], 'yellow-bold')
        self.assertEqual(spec['aspect_ratio'], '9:16')
        self.assertTrue(any('Speaker' in w for w in spec['warnings']))

    def test_contradictions_become_warnings(self):
        spec = normalize_spec({'count': 99, 'min_duration_seconds': 60, 'max_duration_seconds': 30, 'duration_mode': 'exactly',
                               'aspect_ratio': 'square', 'fillers': 'obliterate', 'exclude': ['politics']})
        self.assertEqual(spec['count'], 20)
        self.assertEqual(spec['duration']['mode'], 'strict')
        self.assertEqual((spec['duration']['min_seconds'], spec['duration']['max_seconds']), (30, 60))
        self.assertEqual(spec['aspect_ratio'], '1:1')
        self.assertEqual(spec['filler_policy'], 'smart')
        self.assertEqual(spec['exclude_subjects'], ['politics'])
        joined = ' '.join(spec['warnings'])
        for needle in ('clamped', 'swapped', 'Strict', 'filler policy', 'excluded subject'):
            self.assertIn(needle, joined)

    def test_units_and_defaults(self):
        spec = normalize_spec({'duration': {'target': '1.5 minutes', 'mode': 'max'}})
        self.assertEqual(spec['duration']['target_seconds'], 90)
        self.assertEqual(spec['duration']['mode'], 'maximum')
        self.assertEqual(spec['duration']['max_seconds'], 90)
        self.assertEqual(normalize_spec(None)['count'], 3)
        self.assertEqual(normalize_spec('garbage')['duration']['target_seconds'], 45)

    def test_duration_windows(self):
        natural = duration_window(normalize_spec({'target_duration_seconds': 42}))
        self.assertEqual((natural['min_ms'], natural['max_ms'], natural['tolerance_ms']), (25_200, 63_000, 3000))
        bounded = duration_window(normalize_spec({'target_duration_seconds': 42, 'min_duration_seconds': 30, 'max_duration_seconds': 50}))
        self.assertEqual((bounded['min_ms'], bounded['max_ms']), (30_000, 50_000))
        strict = duration_window(normalize_spec({'target_duration_seconds': 42, 'duration_mode': 'strict'}))
        self.assertEqual((strict['min_ms'], strict['max_ms'], strict['tolerance_ms']), (35_700, 63_000, 1000))
        maximum = duration_window(normalize_spec({'target_duration_seconds': 42, 'duration_mode': 'maximum'}))
        self.assertEqual((maximum['min_ms'], maximum['max_ms'], maximum['tolerance_ms']), (21_000, 54_600, 0))
        self.assertIn('42s natural', describe_spec(normalize_spec({'target_duration_seconds': 42})))


class ConstraintTests(unittest.TestCase):
    ANSWER = {'candidates': [
        {'start': '00:10', 'end': '00:50', 'title': 'Why we failed', 'hook': 'We were wrong about everything.',
         'speaker': 'Sarah', 'speaker_evidence': 'introduced as Sarah', 'topic_found': True, 'complete_ending': True,
         'scores': {'prompt_match': 9, 'hook': 8, 'standalone': 8, 'clarity': 7, 'energy': 6}},
        {'start': '00:15', 'end': '00:55', 'title': 'Overlaps the first', 'speaker': 'Sarah', 'topic_found': True,
         'scores': {'prompt_match': 8, 'hook': 7, 'standalone': 7, 'clarity': 7, 'energy': 7}},
        {'start': '02:00', 'end': '02:40', 'title': 'Wrong speaker', 'speaker': 'Tom', 'topic_found': True, 'complete_ending': True,
         'scores': {'prompt_match': 9, 'hook': 9, 'standalone': 9, 'clarity': 9, 'energy': 9}},
        {'start': '03:00', 'end': '03:40', 'title': 'Off topic', 'speaker': 'Sarah', 'topic_found': False,
         'scores': {'prompt_match': 2, 'hook': 9, 'standalone': 9, 'clarity': 9, 'energy': 9}},
        {'start': '04:00', 'end': '04:10', 'title': 'Too short', 'speaker': 'Sarah', 'topic_found': True,
         'scores': {'prompt_match': 9, 'hook': 9, 'standalone': 9, 'clarity': 9, 'energy': 9}},
        {'start': '05:00', 'end': '05:40', 'title': 'Unverified speaker', 'topic_found': True, 'complete_ending': True,
         'scores': {'prompt_match': 7, 'hook': 7, 'standalone': 7, 'clarity': 7, 'energy': 7}},
    ]}

    def test_parse_director_answer(self):
        cands = parse_director_answer(self.ANSWER)
        self.assertEqual(len(cands), 6)
        self.assertEqual(cands[0]['speaker'], 'Sarah')
        self.assertIs(cands[0]['topic_found'], True)
        self.assertIsNone(cands[1]['complete_ending'])
        self.assertEqual(cands[0]['scores']['prompt_match'], 9.0)

    def test_hard_constraints_then_ranking(self):
        spec = normalize_spec({'count': 3, 'target_duration_seconds': 40, 'speaker': 'Sarah', 'topic': 'why the startup failed'})
        window = duration_window(spec)
        sents = sentences(80)
        kept, rejected = select_candidates(parse_director_answer(self.ANSWER), spec, window, sents, 400_000)
        self.assertEqual([c['title'] for c in kept], ['Why we failed', 'Unverified speaker'])
        reasons = {c['title']: c['rejected_for'][0] for c in rejected}
        self.assertIn('overlaps', reasons['Overlaps the first'])
        self.assertIn('speaker is Tom', reasons['Wrong speaker'])
        self.assertIn('subject not covered', reasons['Off topic'])
        self.assertIn('outside', reasons['Too short'])
        self.assertIsNone(kept[1]['compliance']['speaker_match'])
        self.assertTrue(kept[1]['compliance']['warnings'])
        report = request_compliance(kept, rejected, spec, window)
        self.assertEqual((report['requested'], report['delivered'], report['rejected']), (3, 2, 4))
        self.assertTrue(any('Only 2 of the 3' in w for w in report['warnings']))

    def test_profanity_and_duration_penalty(self):
        self.assertEqual(find_profanity("That's bullshit, honestly. Damn."), ['bullshit', 'damn'])
        self.assertEqual(find_profanity('a classy sentence'), [])
        spec = normalize_spec({'target_duration_seconds': 40, 'exclude': ['swearing']})
        window = duration_window(spec)
        cand = {'start_ms': 0, 'end_ms': 40_000, 'scores': {'prompt_match': 8, 'hook': 8, 'standalone': 8, 'clarity': 8, 'energy': 8}}
        verdict = check_constraints(cand, spec, window, 'This is bullshit.')
        self.assertFalse(verdict['ok'])
        self.assertTrue(verdict['profanity_found'])
        self.assertEqual(director_score(cand, window), 8.0)
        long_cand = {**cand, 'end_ms': 52_000}
        self.assertLess(director_score(long_cand, window), 8.0)


class CutPlanningTests(unittest.TestCase):
    def test_smart_policy_cuts_safe_fillers_and_mutes_tight_ones(self):
        ws = words('so um we shipped it. And uh then nothing happened')
        # make the second filler sit tight between its neighbours (no natural pause)
        ws[6]['start_ms'] = ws[5]['end_ms'] + 20
        ws[6]['end_ms'] = ws[6]['start_ms'] + 200
        ws[7]['start_ms'] = ws[6]['end_ms'] + 20
        cuts = plan_cuts(ws, [], 4000, filler_policy='smart', silence_policy='keep')
        by_word = {c['word']: c for c in cuts}
        self.assertEqual(by_word['um']['action'], 'cut')
        self.assertEqual(by_word['uh']['action'], 'mute')
        self.assertIn('natural pause', by_word['uh']['reason'])
        self.assertEqual(len(cut_ranges(cuts)), 1)
        self.assertEqual(len(mute_ranges(cuts)), 1)

    def test_policies_and_restore(self):
        ws = words('this is um a test')
        self.assertEqual(plan_cuts(ws, [], 2000, filler_policy='keep', silence_policy='keep'), [])
        cut = plan_cuts(ws, [], 2000, filler_policy='cut', silence_policy='keep')[0]
        self.assertEqual((cut['id'], cut['action']), ('f01', 'cut'))
        restored = plan_cuts(ws, [], 2000, filler_policy='cut', silence_policy='keep', disabled={'f01'})[0]
        self.assertFalse(restored['enabled'])
        self.assertEqual(cut_ranges([restored]), [])

    def test_filler_safety_rules(self):
        um = {'word': 'um', 'start_ms': 1000, 'end_ms': 1200, 'probability': 0.3}
        self.assertEqual(filler_cut_safety(um, None, None), (False, 'probably not a filler'))
        long_um = {'word': 'um', 'start_ms': 1000, 'end_ms': 3000, 'probability': 0.9}
        self.assertFalse(filler_cut_safety(long_um, None, None)[0])
        ok = {'word': 'um', 'start_ms': 1000, 'end_ms': 1200, 'probability': 0.9}
        prev = {'word': 'done.', 'start_ms': 500, 'end_ms': 990}
        nxt = {'word': 'So', 'start_ms': 1210, 'end_ms': 1500}
        self.assertTrue(filler_cut_safety(ok, prev, nxt)[0])  # sentence boundary makes the tight join fine
        levels = {1000: -20.0, 1200: -40.0}
        self.assertIn('loudness', filler_cut_safety(ok, None, None, levels)[1])

    def test_silence_safety_and_plan(self):
        ws = words('one two three', step_ms=2000)
        silences = [(400, 1900), (2400, 3900)]
        cuts = plan_cuts(ws, silences, 6000, filler_policy='keep', silence_policy='tighten')
        self.assertEqual([c['action'] for c in cuts], ['cut', 'cut'])
        self.assertFalse(silence_cut_safety(200, 400, ws)[0])  # overlaps the first word


class DurationFitTests(unittest.TestCase):
    def transcript(self):
        # 20 words, one every 500 ms (350 ms long); sentences end at words 5, 11 and 19
        text = 'we tried to raise money twice. nobody believed the story we told. so we shut the company down for good.'
        return words(text, step_ms=500, length_ms=350)

    def test_natural_reports_only(self):
        ws = self.transcript()
        report = fit_duration(ws, [], 10_000, target_ms=8000, mode='natural', tolerance_ms=3000)
        self.assertEqual((report['before_ms'], report['after_ms'], report['end_ms']), (10_000, 10_000, 10_000))
        self.assertTrue(report['met'])

    def test_strict_trims_to_a_sentence_end_never_mid_word(self):
        ws = self.transcript()
        report = fit_duration(ws, [], 10_000, target_ms=6000, mode='strict', tolerance_ms=1000)
        self.assertTrue(report['met'])
        self.assertIn('sentence ending', report['actions'][0])
        self.assertEqual(report['end_ms'], ws[11]['end_ms'] + 150)  # "told." + tail limited by the gap to the next word
        self.assertLessEqual(abs(report['after_ms'] - 6000), 1000)
        # no sentence end in the window: the closest word end wins, never mid-word
        report = fit_duration(ws, [], 10_000, target_ms=7000, mode='strict', tolerance_ms=1000)
        self.assertIn('the word “we”', report['actions'][0])
        self.assertEqual(report['end_ms'], ws[13]['end_ms'] + 150)

    def test_maximum_never_exceeds(self):
        ws = self.transcript()
        report = fit_duration(ws, [], 10_000, target_ms=4000, mode='maximum', tolerance_ms=0)
        self.assertTrue(report['met'])
        self.assertLessEqual(report['after_ms'], 4000)
        for w in ws:
            self.assertFalse(w['start_ms'] < report['end_ms'] < w['end_ms'], 'trim landed inside a word')

    def test_strict_gives_back_pauses_then_pads(self):
        ws = self.transcript()
        cuts = [
            {'id': 's01', 'kind': 'silence', 'word': '', 'start_ms': 3200, 'end_ms': 3450, 'action': 'cut', 'safe': True, 'reason': None, 'enabled': True},
            {'id': 's02', 'kind': 'silence', 'word': '', 'start_ms': 6700, 'end_ms': 6950, 'action': 'cut', 'safe': True, 'reason': None, 'enabled': True},
        ]
        report = fit_duration(ws, cuts, 10_000, target_ms=11_500, mode='strict', tolerance_ms=1000, room_after_ms=2000)
        self.assertEqual(report['before_ms'], 9500)
        restored = [c for c in report['cuts'] if c.get('restored_for_fit')]
        self.assertEqual(len(restored), 2)
        self.assertTrue(any('padded 1.0s' in a for a in report['actions']))
        self.assertTrue(report['met'])
        self.assertEqual(report['after_ms'], 11_000)
        self.assertEqual(report['after_ms'], rendered_ms(report['keep']))
        # a smaller shortfall is covered by the pauses alone
        report = fit_duration(ws, cuts, 10_000, target_ms=10_500, mode='strict', tolerance_ms=1000, room_after_ms=2000)
        self.assertTrue(report['met'])
        self.assertFalse(any('padded' in a for a in report['actions']))

    def test_strict_reports_when_impossible(self):
        ws = self.transcript()
        report = fit_duration(ws, [], 10_000, target_ms=20_000, mode='strict', tolerance_ms=1000, room_after_ms=0)
        self.assertFalse(report['met'])
        self.assertTrue(report['warnings'])


if __name__ == '__main__':
    unittest.main()
