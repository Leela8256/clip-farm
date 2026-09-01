"""
Clip Farm phase tests: the preview tiers, the preview cache, the delivery
shapes a clip can take, the brand snapshot's precedence and the report's
quality block. All plan-level — no engine, no store, no ffmpeg.
"""

from __future__ import annotations
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from local_nodes.podcast_common import studio  # noqa: E402
from local_nodes.podcast_common.media import (  # noqa: E402
    build_video_filter,
    dims,
    export_short_edge,
    preview_dims,
    quality_block,
)
from local_nodes.podcast_common.spec import RENDERABLE_ASPECTS  # noqa: E402

HD = {'width': 1920, 'height': 1080, 'fps': 29.97, 'duration_ms': 600_000, 'has_video': True}
SMALL = {'width': 640, 'height': 360, 'fps': 24, 'duration_ms': 600_000, 'has_video': True}
FOUR_K = {'width': 3840, 'height': 2160, 'fps': 60, 'duration_ms': 600_000, 'has_video': True}


class PreviewTierTest(unittest.TestCase):
    def standard(self, media=None, **kw):
        return studio.render_tier(mode='preview', quality='standard', has_range=False,
                                  aspect='16:9', media=media or HD, **kw)

    def test_the_standard_tier_is_a_watchable_whole_episode_without_mastering(self):
        tier = self.standard()
        self.assertEqual((tier['tier'], tier['width'], tier['height']), ('standard', 1280, 720))
        self.assertEqual((tier['crf'], tier['preset']), (22, 'veryfast'))
        self.assertEqual(tier['channels'], 2)
        self.assertEqual(tier['fps'], 30)
        self.assertFalse(tier['master'])              # honest: the report says mastered: false
        self.assertFalse(tier['music'])
        self.assertTrue(tier['cards'])                # cuts + captions + logo + cards
        self.assertEqual(tier['clean'], (True, True, True))

    def test_the_range_tier_runs_the_whole_chain_at_full_size(self):
        tier = studio.render_tier(mode='preview', quality='range', has_range=True, aspect='16:9', media=FOUR_K)
        self.assertEqual((tier['tier'], tier['width'], tier['height']), ('range', 1920, 1080))
        self.assertEqual((tier['crf'], tier['preset']), (19, 'veryfast'))
        self.assertTrue(tier['master'])
        self.assertTrue(tier['music'])
        self.assertEqual(tier['channels'], 2)

    def test_a_range_always_wins_over_the_quality_word_it_arrived_with(self):
        legacy = studio.render_tier(mode='preview', quality='full', has_range=True, aspect='16:9', media=HD)
        self.assertEqual(legacy['tier'], 'range')
        self.assertEqual(legacy['quality'], 'range')     # the canonical name reaches the report
        rough = studio.render_tier(mode='preview', quality='rough', has_range=False, aspect='16:9', media=HD)
        self.assertEqual((rough['tier'], rough['quality']), ('standard', 'standard'))

    def test_nothing_is_ever_upscaled(self):
        self.assertEqual((self.standard(SMALL)['width'], self.standard(SMALL)['height']), (640, 360))
        ranged = studio.render_tier(mode='preview', quality='range', has_range=True, aspect='16:9', media=SMALL)
        self.assertEqual((ranged['width'], ranged['height']), (640, 360))
        self.assertFalse(quality_block('standard', {'width': 640, 'height': 360}, crf=22, preset='veryfast',
                                       channels=2, source_width=640, source_height=360)['upscaled'])

    def test_the_frame_rate_follows_the_source_up_to_thirty(self):
        self.assertEqual(self.standard()['fps'], 30)                      # 29.97 -> 30
        self.assertEqual(self.standard(FOUR_K)['fps'], 30)                # 60 is capped
        self.assertEqual(self.standard(SMALL)['fps'], 24)                 # 24 stays 24
        self.assertEqual(self.standard({'width': 1920, 'height': 1080})['fps'], 30)   # unknown -> 30

    def test_export_size_is_720_1080_or_the_source(self):
        for size, expected in ((None, (1920, 1080)), (720, (1280, 720)), ('1080', (1920, 1080))):
            with self.subTest(size=size):
                tier = studio.render_tier(mode='export', quality='export', aspect='16:9', media=HD, size=size)
                self.assertEqual((tier['width'], tier['height']), expected)
                self.assertEqual((tier['tier'], tier['crf'], tier['preset']), ('export', 20, 'veryfast'))
        source = studio.render_tier(mode='export', aspect='16:9', media=FOUR_K, size='source')
        self.assertEqual((source['width'], source['height']), (3840, 2160))
        self.assertEqual(export_short_edge('nonsense', 1920, 1080), 1080)

    def test_a_portrait_episode_preview_keeps_its_shape(self):
        tier = studio.render_tier(mode='preview', quality='standard', has_range=False, aspect='9:16', media=HD)
        self.assertEqual((tier['width'], tier['height']), (720, 1280))
        self.assertLessEqual(max(tier['width'], tier['height']), 1280)

    def test_mastering_can_still_be_switched_off_by_the_producer(self):
        tier = studio.render_tier(mode='export', aspect='16:9', media=HD, audio={'master': False,
                                                                                'noise_reduction': False})
        self.assertFalse(tier['master'])
        self.assertEqual(tier['clean'], (False, True, True))


class PreviewCacheTest(unittest.TestCase):
    REPORT = {'spec_hash': 'abc123', 'quality': {'tier': 'standard'}, 'range': None}

    def test_the_same_edit_at_the_same_tier_is_a_hit(self):
        self.assertTrue(studio.preview_cache_hit(self.REPORT, 'abc123', 'standard'))

    def test_an_edited_episode_a_different_tier_or_another_range_is_a_miss(self):
        self.assertFalse(studio.preview_cache_hit(self.REPORT, 'def456', 'standard'))
        self.assertFalse(studio.preview_cache_hit(self.REPORT, 'abc123', 'range'))
        self.assertFalse(studio.preview_cache_hit(self.REPORT, 'abc123', 'standard', rng=[0, 5_000]))

    def test_a_range_preview_matches_only_its_own_window(self):
        report = {'spec_hash': 'abc123', 'quality': {'tier': 'range'}, 'range': [1_000, 9_000]}
        self.assertTrue(studio.preview_cache_hit(report, 'abc123', 'range', rng=[1_000, 9_000]))
        self.assertFalse(studio.preview_cache_hit(report, 'abc123', 'range', rng=[1_000, 8_000]))
        self.assertFalse(studio.preview_cache_hit(report, 'abc123', 'range'))

    def test_a_report_from_before_the_quality_block_is_never_reused(self):
        self.assertFalse(studio.preview_cache_hit({'spec_hash': 'abc123', 'quality': 'rough'}, 'abc123', 'standard'))
        self.assertFalse(studio.preview_cache_hit(None, 'abc123', 'standard'))
        self.assertFalse(studio.preview_cache_hit(self.REPORT, '', 'standard'))


class ClipShapeTest(unittest.TestCase):
    def test_the_feed_formats_render_at_the_portrait_width(self):
        self.assertEqual(dims('vertical', 1920), (1080, 1920))
        self.assertEqual(dims('4:5', 1920), (1080, 1350))
        self.assertEqual(dims('1:1', 1920), (1080, 1080))
        self.assertEqual(dims('wide', 1920), (1920, 1080))

    def test_a_preview_scales_proportionally(self):
        self.assertEqual(dims('vertical', 960), (540, 960))
        self.assertEqual(dims('4:5', 960), (540, 674))
        self.assertEqual(dims('1:1', 960), (540, 540))

    def test_the_aspect_names_and_the_layout_names_agree(self):
        self.assertEqual(dims('9:16', 1920), dims('vertical', 1920))
        self.assertEqual(dims('16:9', 1920), dims('wide', 1920))
        with self.assertRaises(ValueError):
            dims('3:4', 1920)

    def test_every_renderable_aspect_maps_to_a_render_pass(self):
        self.assertEqual(RENDERABLE_ASPECTS, {'9:16': 'vertical', '4:5': 'vertical',
                                              '1:1': 'vertical', '16:9': 'wide'})

    def test_preview_dims_fits_the_box_and_the_source(self):
        self.assertEqual(preview_dims('16:9', 1280, 1280, 1920, 1080), (1280, 720))
        self.assertEqual(preview_dims('9:16', 1920, 1080, 1920, 1080), (608, 1080))
        self.assertEqual(preview_dims('16:9', 1280, 1280, 0, 0), (1280, 720))     # unknown source: trust the cap


class ClipGraphTest(unittest.TestCase):
    """The brand logo really reaches ffmpeg — and a clip without one is untouched."""

    def test_a_clip_without_a_brand_has_no_overlay_stage(self):
        graph = build_video_filter([(0, 5_000)], 'vertical', 1080, 1920, 30, None)
        self.assertNotIn('[logoed]', graph)
        self.assertTrue(graph.endswith('[framed]format=yuv420p[vout]'))

    def test_the_logo_sits_between_the_reframe_and_the_captions(self):
        graph = build_video_filter([(0, 5_000)], '4:5', 1080, 1350, 30, 'c.ass',
                                   logo={'corner': 'br', 'height': 0.1, 'opacity': 0.8}, logo_input=2)
        self.assertIn('[2:v]scale=-1:135', graph)
        self.assertIn('[framed][lg]overlay=W-w-54:H-h-54', graph)
        self.assertIn("[logoed]subtitles='c.ass'[captioned]", graph)

    def test_the_feed_shapes_are_blur_padded_like_the_portrait_one(self):
        for shape in ('vertical', '4:5', '1:1'):
            with self.subTest(shape=shape):
                self.assertIn('gblur', build_video_filter([(0, 5_000)], shape, 1080, 1080, 30, None))
        self.assertNotIn('gblur', build_video_filter([(0, 5_000)], 'wide', 1920, 1080, 30, None))


class QualityBlockTest(unittest.TestCase):
    PROBE = {'width': 1280, 'height': 720, 'fps': 30.0, 'video_codec': 'h264', 'audio_channels': 2}

    def test_the_block_reports_what_was_measured(self):
        block = quality_block('standard', self.PROBE, crf=22, preset='veryfast', channels=2,
                              source_width=1920, source_height=1080)
        self.assertEqual(block, {'tier': 'standard', 'width': 1280, 'height': 720, 'fps': 30.0,
                                 'video_codec': 'h264', 'crf': 22, 'preset': 'veryfast', 'audio_channels': 2,
                                 'source_width': 1920, 'source_height': 1080, 'upscaled': False})

    def test_the_planned_size_fills_in_when_the_probe_says_nothing(self):
        block = quality_block('clip-preview', {}, crf=23, preset='veryfast', channels=2,
                              source_width=1920, source_height=1080, fps=30, width=540, height=960)
        self.assertEqual((block['width'], block['height'], block['fps']), (540, 960, 30.0))
        self.assertEqual(block['video_codec'], 'h264')
        self.assertFalse(block['upscaled'])

    def test_an_output_bigger_than_the_recording_is_admitted(self):
        block = quality_block('export', {'width': 1920, 'height': 1080}, crf=20, preset='veryfast',
                              channels=2, source_width=640, source_height=360)
        self.assertTrue(block['upscaled'])


class BrandSnapshotTest(unittest.TestCase):
    BRAND = {
        'id': 'brand-1', 'revision': 3, 'hash': 'deadbeef',
        'resolved': {
            'logo': {'path': 'brand-templates/b1/assets/logo.png', 'corner': 'br', 'height': 0.12, 'rogue': 'x'},
            'intro': {'path': 'brand-templates/b1/assets/intro.mp4'},
            'music': {'path': 'brand-templates/b1/assets/bed.mp3', 'gain_db': -18},
            'captions': {'preset': 'yellow-bold', 'case': 'upper'},
            'nonsense': {'path': 'x'},
        },
    }

    def test_the_snapshot_is_validated_and_stripped(self):
        brand = studio.normalize_brand(self.BRAND)
        self.assertEqual(brand['id'], 'brand-1')
        self.assertEqual(brand['revision'], 3)
        self.assertEqual(brand['hash'], 'deadbeef')
        self.assertNotIn('rogue', brand['resolved']['logo'])
        self.assertNotIn('nonsense', brand['resolved'])
        self.assertEqual(brand['resolved']['captions']['preset'], 'yellow-bold')
        self.assertEqual(brand['resolved']['captions']['case'], 'upper')

    def test_rubbish_is_not_a_brand(self):
        for value in (None, 'brand-1', {}, {'resolved': 'nope'}):
            self.assertIsNone(studio.normalize_brand(value))

    def test_a_template_only_fills_the_slots_the_producer_left_empty(self):
        brand = studio.normalize_brand(self.BRAND)
        own = {'logo': {'path': 'projects/ep1/assets/mine.png'}}
        merged, warnings = studio.brand_assets(own, brand)
        self.assertEqual(merged['logo']['path'], 'projects/ep1/assets/mine.png')   # explicit wins
        self.assertEqual(merged['intro']['path'], 'brand-templates/b1/assets/intro.mp4')
        self.assertEqual(merged['music']['gain_db'], -18)
        self.assertEqual(warnings, [])

    def test_a_brand_file_that_is_gone_warns_instead_of_failing(self):
        brand = studio.normalize_brand(self.BRAND)
        merged, warnings = studio.brand_assets({}, brand, lambda path: 'intro' not in path)
        self.assertNotIn('intro', merged)
        self.assertIn('logo', merged)
        self.assertTrue(any('intro' in w for w in warnings))

    def test_no_brand_leaves_everything_exactly_as_it_was(self):
        own = {'logo': {'path': 'a.png'}}
        self.assertEqual(studio.brand_assets(own, None), (own, []))
        self.assertIsNone(studio.brand_caption_style(None))


class PreparedSpecBrandTest(unittest.TestCase):
    MEDIA = {'width': 1920, 'height': 1080, 'fps': 30, 'duration_ms': 60_000, 'has_video': True}
    BRAND = {'id': 'b1', 'revision': 2, 'hash': 'abc', 'resolved': {
        'logo': {'path': 'brand-templates/b1/assets/logo.png', 'corner': 'tr'},
        'outro': {'path': 'brand-templates/b1/assets/outro.mp4'},
        'captions': {'preset': 'yellow-bold', 'position': 'middle'}}}

    def prepared(self, edits):
        return studio.build_prepared(project='projects/ep1', episode_id='ep1', source='projects/ep1/source.mp4',
                                     media=self.MEDIA, edits=edits, words=[], mode='preview',
                                     asset_exists=lambda path: True, size='720')

    def test_the_brand_reaches_the_spec_and_fills_the_empty_slots(self):
        spec = self.prepared({'brand': self.BRAND})
        self.assertEqual(spec['brand']['id'], 'b1')
        self.assertEqual(spec['assets']['logo']['corner'], 'tr')
        self.assertEqual(spec['assets']['outro']['path'], 'brand-templates/b1/assets/outro.mp4')
        self.assertEqual(spec['captions']['style']['preset'], 'yellow-bold')
        self.assertEqual(spec['captions']['style']['position'], 'middle')
        self.assertEqual(spec['size'], '720')

    def test_the_producers_own_choices_beat_the_template(self):
        spec = self.prepared({'brand': self.BRAND,
                              'assets': {'logo': {'path': 'projects/ep1/assets/mine.png', 'corner': 'bl'}},
                              'visual': {'caption_style': {'preset': 'white-outline'}}})
        self.assertEqual(spec['assets']['logo']['path'], 'projects/ep1/assets/mine.png')
        self.assertEqual(spec['assets']['logo']['corner'], 'bl')
        self.assertEqual(spec['captions']['style']['preset'], 'white-outline')
        self.assertEqual(spec['captions']['style']['position'], 'middle')   # the rest still comes from the brand

    def test_an_episode_without_a_brand_is_unchanged(self):
        spec = self.prepared({})
        self.assertIsNone(spec['brand'])
        self.assertEqual(spec['assets'], {})
        self.assertEqual(spec['captions']['style']['preset'], 'clean')
        bare = studio.build_prepared(project='projects/ep1', episode_id='ep1', source='projects/ep1/source.mp4',
                                     media=self.MEDIA, edits={}, words=[], mode='preview')
        self.assertIsNone(bare['size'])
        self.assertIsNone(bare['brand'])


if __name__ == '__main__':
    unittest.main()
