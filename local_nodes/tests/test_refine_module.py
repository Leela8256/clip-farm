import unittest

from local_nodes.podcast_common.refine import refine_analysis, refine_direct


def sentences_for(count=20, span_ms=5000):
    return [{'id': i, 'text': f'Sentence {i} says something meaningful here.',
             'start_ms': i * span_ms, 'end_ms': (i + 1) * span_ms} for i in range(count)]


class RefineModuleTest(unittest.TestCase):
    def test_analysis_produces_the_node_documents(self):
        sentences = sentences_for()
        payload = {'candidates': [
            {'start': '00:05', 'end': '00:45', 'title': 'A strong point', 'hook': 'hooky',
             'reason': 'clear', 'quote': 'Sentence 1', 'scores': {'hook': 9, 'clarity': 8, 'standalone': 8}},
        ], 'chapters': [{'start': '00:00', 'title': 'Opening'}]}
        doc, chapters_doc, summary = refine_analysis(
            [payload], sentences=sentences, duration_ms=100_000, episode_id='ep1',
            goal='test', want=5, min_ms=20_000, max_ms=90_000, now=123.0)
        self.assertEqual(doc['schema_version'], 1)
        self.assertEqual(doc['episode_id'], 'ep1')
        self.assertEqual(doc['generated'], 123.0)
        self.assertEqual(doc['parts'], 1)
        self.assertEqual(len(doc['candidates']), 1)
        cand = doc['candidates'][0]
        self.assertEqual(cand['id'], 'c01')
        self.assertIn('sentence_ids', cand)
        self.assertIn('proposed', cand)                       # pre-snap positions kept
        self.assertEqual(chapters_doc['schema_version'], 1)
        self.assertEqual(summary['proposed'], 1)

    def test_direct_writes_the_request_update_shape(self):
        sentences = sentences_for()
        request = {'prompt': 'clips about points', 'spec': {'count': 1, 'target_duration_seconds': 40}}
        payload = {'candidates': [
            {'start_ms': 5000, 'end_ms': 45000, 'title': 'On point', 'hook': 'h', 'reason': 'r',
             'quote': 'Sentence 1', 'scores': {'prompt_match': 9, 'hook': 8, 'standalone': 8, 'clarity': 8, 'energy': 7}},
        ]}
        update, summary = refine_direct([payload], request=request, request_id='r01',
                                        sentences=sentences, duration_ms=100_000, now=456.0)
        self.assertEqual(update['status'], 'done')
        self.assertEqual(update['answered_at'], 456.0)
        self.assertEqual(update['candidates'][0]['id'], 'r01c01')
        self.assertIn('compliance', update)
        self.assertIn('rejected', update)
        self.assertEqual(summary['proposed'], 1)

    def test_llm_error_with_no_candidates_raises(self):
        with self.assertRaises(RuntimeError):
            refine_direct(['**LLM error** upstream failed'], request={'spec': {}}, request_id='r02',
                          sentences=sentences_for(), duration_ms=100_000)
