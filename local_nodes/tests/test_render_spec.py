"""
The translation into the generic render spec — the document media_render is
handed for a clip and for a whole edited episode.

The values asserted here are the ones the app has always produced (file names,
geometry, keep lists, caption timing, chapter offsets); only the shape they
travel in is new:
    python3 -m unittest discover -s local_nodes/tests -v
"""

from __future__ import annotations
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from local_nodes.podcast_common import studio  # noqa: E402
from local_nodes.podcast_common.media import spec_hash  # noqa: E402
from local_nodes.podcast_common.render_spec import (  # noqa: E402
    SPEC_KIND,
    clip_framing,
    clip_render_spec,
    is_render_spec,
    preview_cache_key,
    shift_caption_lines,
    studio_preview_name,
    studio_render_spec,
)

PREVIEW = {'mode': 'preview', 'size': 960, 'layouts': 'vertical', 'fps': 30, 'crf': 23,
           'preset': 'veryfast', 'captions': True, 'sidecars': False}
EXPORT = {'mode': 'export', 'size': 1920, 'layouts': 'vertical,wide', 'fps': 30, 'crf': 20,
          'preset': 'veryfast', 'captions': True, 'sidecars': True}


def words(spec: str, start_ms: int = 0, word_ms: int = 300, gap_ms: int = 100) -> list[dict]:
    out, t = [], start_ms
    for text in spec.split():
        out.append({'word': text, 'start_ms': t, 'end_ms': t + word_ms})
        t += word_ms + gap_ms
    return out


def plan(**over) -> dict:
    """A prepared clip plan: 60 s into the recording, 10 s long, one 1 s cut at 4 s."""
    base = {
        'schema_version': 2, 'project': 'projects/ep1', 'episode_id': 'ep1',
        'source': 'projects/ep1/source/ep.mp4', 'clip_id': 'c03', 'candidate': 'c03',
        'request_id': None, 'version': None, 'title': 'A good moment',
        'start_ms': 60_000, 'end_ms': 70_000, 'duration_ms': 10_000, 'rendered_duration_ms': 9_000,
        'words': words('this is the clip we are keeping', start_ms=0),
        'keep': [[0, 4000], [5000, 10_000]], 'mutes': [[7000, 7200]],
        'fit': {'mode': 'natural', 'met': True},
        'media': {'width': 1920, 'height': 1080, 'fps': 30, 'duration_ms': 3_600_000, 'has_video': True},
        'options': {'captions': True, 'caption_preset': 'classic', 'caption_style': None, 'aspect': '9:16',
                    'brand': None, 'assets': {}, 'layouts': '', 'layout_mode': 'auto', 'subject': None,
                    'focus': None},
    }
    options = {**base['options'], **(over.pop('options', None) or {})}
    return {**base, **over, 'options': options}


class ClipSpecTests(unittest.TestCase):
    def spec(self, encode=None, **over):
        return clip_render_spec(plan(**over), encode=encode or PREVIEW,
                                write_to='projects/ep1/previews', report_to='projects/ep1/previews/c03.json',
                                status_to='projects/ep1/status.json')

    def test_one_timebase_the_recordings(self):
        spec = self.spec()
        self.assertTrue(is_render_spec(spec))
        self.assertEqual(spec['kind'], SPEC_KIND)
        self.assertEqual(spec['source'], 'projects/ep1/source/ep.mp4')
        # the plan's clip-relative lists, moved onto the recording
        self.assertEqual(spec['keep'], [[60_000, 64_000], [65_000, 70_000]])
        self.assertEqual(spec['mutes'], [[67_000, 67_200]])
        self.assertEqual(spec['subtitles']['words'][0]['s'], 60_000)
        self.assertTrue(spec['subtitles']['map_through_keep'])
        self.assertEqual(spec['framing_offset_ms'], 60_000)

    def test_the_preview_names_its_first_pass_after_the_clip(self):
        outputs = self.spec()['outputs']
        self.assertEqual([o['file'] for o in outputs], ['c03.mp4'])
        self.assertEqual(outputs[0]['name'], 'vertical')
        self.assertEqual((outputs[0]['width'], outputs[0]['height']), (540, 960))
        self.assertEqual((outputs[0]['crf'], outputs[0]['preset'], outputs[0]['fps_max']), (23, 'veryfast', 30))
        self.assertTrue(outputs[0]['framing'])              # only the upright pass follows a plan
        self.assertEqual(self.spec()['thumbnail']['file'], 'c03.jpg')
        self.assertEqual(self.spec()['write_to'], 'projects/ep1/previews')

    def test_the_export_writes_every_pass_with_its_layout(self):
        spec = self.spec(encode=EXPORT)
        outputs = spec['outputs']
        self.assertEqual([o['file'] for o in outputs], ['c03_vertical.mp4', 'c03_wide.mp4'])
        self.assertEqual([(o['width'], o['height']) for o in outputs], [(1080, 1920), (1920, 1080)])
        self.assertEqual([o['framing'] for o in outputs], [True, False])
        self.assertEqual([o['caption_layout'] for o in outputs], ['vertical', 'wide'])
        self.assertTrue(spec['subtitles']['sidecars'])
        self.assertEqual(spec['subtitles']['files'], {'srt': 'c03.srt', 'vtt': 'c03.vtt'})

    def test_a_feed_shape_reshapes_the_upright_pass_only(self):
        for aspect, size in (('4:5', (1080, 1350)), ('1:1', (1080, 1080)), ('9:16', (1080, 1920))):
            outputs = self.spec(encode=EXPORT, options={'aspect': aspect, 'layouts': 'vertical'})['outputs']
            self.assertEqual((outputs[0]['width'], outputs[0]['height']), size)
            self.assertEqual(outputs[0]['caption_layout'], 'vertical' if aspect == '9:16' else aspect)

    def test_captions_off_still_leaves_the_words_for_the_sidecars(self):
        spec = self.spec(encode=EXPORT, options={'caption_preset': 'off'})
        self.assertFalse(spec['subtitles']['enabled'])
        self.assertFalse(spec['outputs'][0]['captions'])
        self.assertTrue(spec['subtitles']['sidecars'])
        self.assertTrue(spec['subtitles']['words'])
        self.assertEqual(spec['meta']['caption_preset'], 'off')

    def test_an_audio_only_recording_renders_one_mp3(self):
        spec = self.spec(media={'width': 0, 'height': 0, 'fps': 0, 'duration_ms': 600_000, 'has_video': False})
        self.assertEqual([o['file'] for o in spec['outputs']], ['c03.mp3'])
        self.assertEqual(spec['outputs'][0]['container'], 'mp3')
        self.assertIsNone(spec['thumbnail'])

    def test_the_clip_is_always_cleaned_and_mastered(self):
        audio = self.spec()['audio']
        self.assertEqual((audio['denoise'], audio['highpass'], audio['compress'], audio['master']),
                         (True, True, True, True))
        self.assertEqual((audio['loudness_lufs'], audio['true_peak']), (-16.0, -1.0))

    def test_a_brand_logo_becomes_one_overlay(self):
        spec = self.spec(options={'assets': {'logo': {'path': 'brand/logo.png', 'corner': 'tr', 'height': 0.1}}})
        self.assertEqual(spec['overlays'], [{'image': 'brand/logo.png', 'corner': 'tr', 'height': 0.1}])
        self.assertEqual(self.spec()['overlays'], [])

    def test_the_report_gets_the_apps_own_words_back(self):
        meta = self.spec()['meta']
        self.assertEqual(meta['clip_id'], 'c03')
        self.assertEqual(meta['mode'], 'preview')
        self.assertEqual(meta['title'], 'A good moment')
        self.assertEqual((meta['start_ms'], meta['end_ms'], meta['source_duration_ms']), (60_000, 70_000, 10_000))
        self.assertEqual(meta['layouts'], ['vertical'])
        self.assertEqual(meta['aspect'], '9:16')

    def test_the_framing_block_keeps_the_clips_own_clock(self):
        framing = clip_framing(plan(options={'layout_mode': 'stacked_two', 'subject': 'p2'}),
                               write_to='projects/ep1/analysis/clips/c03',
                               thumbnails_to='projects/ep1/analysis/clips/c03',
                               status_to='projects/ep1/status.json')
        self.assertEqual(framing['source_offset_ms'], 60_000)
        self.assertEqual(framing['duration_ms'], 10_000)
        self.assertEqual(framing['words'][0]['start_ms'], 0)      # clip time, not recording time
        self.assertEqual(framing['layout'], 'stacked_two')
        self.assertEqual(framing['subject'], 'p2')
        self.assertEqual(framing['echo'], {'clip_id': 'c03'})
        self.assertEqual(framing['write_to'], 'projects/ep1/analysis/clips/c03')

    def test_the_framing_plan_arrives_under_its_own_key(self):
        spec = self.spec()
        self.assertIn('framing_plan', spec)                       # the framing node merges into this key
        self.assertIsNone(spec['framing_plan'])


def edits(operations: list[dict], **extra) -> dict:
    return {'schema_version': 1, 'version': 4, 'operations': operations, **extra}


def prepared(extra_aspects=None, **over) -> dict:
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
                      {'id': 'sec03', 'title': 'Back', 'start_ms': 3800}],
            assets={'intro': {'path': 'projects/ep12/assets/intro.mp4'},
                    'outro': {'path': 'projects/ep12/assets/outro.mp4'},
                    'music': {'path': 'projects/ep12/assets/bed.mp3', 'gain_db': -20},
                    'logo': {'path': 'projects/ep12/assets/logo.png', 'corner': 'tr'},
                    'title_card': {'text': 'Episode 12', 'seconds': 3}},
            title='Episode 12', extra_aspects=list(extra_aspects or [])),
        words=spoken, quality='rough', mode='preview')
    payload.update(over)
    return studio.build_prepared(**payload)


class StudioSpecTests(unittest.TestCase):
    def spec(self, *, mode='preview', quality='rough', size=None, range_text=None, **over):
        doc = prepared(mode=mode, quality=quality, size=size, range_text=range_text, **over)
        rng = doc.get('range')
        tier = studio.render_tier(mode=doc['mode'], quality=doc['quality'], has_range=bool(rng),
                                  aspect=(doc['visual'] or {}).get('aspect_ratio'), media=doc['media'],
                                  audio=doc['audio'], size=doc.get('size'))
        version = doc['version']
        if mode == 'export':
            write_to = f'projects/ep12/exports/studio/v{version}'
            report_to = f'{write_to}/report.json'
        else:
            write_to = 'projects/ep12/previews/studio'
            report_to = f'{write_to}/{studio_preview_name(version, rng)}.json'
        return doc, studio_render_spec(doc, tier=tier, write_to=write_to, report_to=report_to,
                                       status_to='projects/ep12/status.json')

    def test_the_edit_survives_the_translation(self):
        doc, spec = self.spec()
        self.assertEqual(spec['keep'], doc['keep'])
        self.assertEqual(spec['keep'], [[0, 2000], [4000, 10_000]])
        self.assertEqual(spec['mutes'], [[5000, 5200]])
        self.assertEqual(spec['bleeps'], [[6000, 6300]])
        self.assertFalse(spec['subtitles']['map_through_keep'])   # already on the output timeline
        text = ' '.join(g['text'] for g in spec['subtitles']['groups'])
        self.assertIn('welcome to the show', text)
        self.assertNotIn('this bit is cut', text)

    def test_the_quick_preview_is_one_file_and_no_mastering(self):
        _, spec = self.spec()
        self.assertEqual([o['file'] for o in spec['outputs']], ['standard-v4.mp4'])
        self.assertEqual((spec['outputs'][0]['crf'], spec['outputs'][0]['preset']), (22, 'veryfast'))
        self.assertEqual((spec['outputs'][0]['width'], spec['outputs'][0]['height']), (1280, 720))
        self.assertFalse(spec['audio']['master'])                 # the standard tier says so, and says so out loud
        self.assertIsNone(spec['music'])                          # …and leaves the music to the full passes
        self.assertEqual(spec['meta']['quality'], 'standard')
        self.assertFalse(spec['subtitles']['sidecars'])
        self.assertEqual(spec['chapters'], [])
        self.assertIsNone(spec['chunking']['resume_key'])

    def test_a_range_preview_renders_only_the_slices_behind_the_window(self):
        _, spec = self.spec(range_text='1000-3000')
        self.assertEqual(spec['keep'], [[1000, 2000], [4000, 5000]])
        self.assertEqual([o['file'] for o in spec['outputs']], ['range-v4.mp4'])
        self.assertEqual((spec['outputs'][0]['crf'], spec['outputs'][0]['preset']), (19, 'veryfast'))
        self.assertTrue(spec['audio']['master'])                  # the range pass runs the full chain
        self.assertIsNotNone(spec['music'])
        self.assertEqual(spec['meta']['range'], [1000, 3000])
        self.assertEqual(spec['meta']['preview_output_start_ms'], 1000)
        # the captions come with the window, starting at its own zero
        self.assertTrue(all(g['start_ms'] >= 0 for g in spec['subtitles']['groups']))
        self.assertEqual(spec['cards'], [])                       # a range is a check, not a deliverable

    def test_the_export_writes_the_whole_set(self):
        doc, spec = self.spec(mode='export', quality='export', extra_aspects=['9:16'])
        self.assertEqual([o['name'] for o in spec['outputs']], ['episode', 'episode_9x16', 'mp3', 'wav'])
        self.assertEqual([o['file'] for o in spec['outputs']],
                         ['episode.mp4', 'episode-9x16.mp4', 'episode.mp3', 'episode.wav'])
        self.assertEqual((spec['outputs'][0]['width'], spec['outputs'][0]['height']), (1920, 1080))
        self.assertEqual(spec['outputs'][0]['crf'], 20)
        self.assertEqual(spec['outputs'][1]['transcode_from'], 'episode')
        self.assertEqual(spec['write_to'], 'projects/ep12/exports/studio/v4')
        self.assertEqual(spec['report_to'], 'projects/ep12/exports/studio/v4/report.json')
        self.assertTrue(spec['subtitles']['sidecars'])
        self.assertEqual(spec['subtitles']['files'], {'srt': 'captions.srt', 'vtt': 'captions.vtt'})
        self.assertTrue(spec['chapter_files'])
        self.assertEqual([c['out_ms'] for c in spec['chapters']], [0, 2000])
        self.assertEqual(spec['chunking'], {'part_ms': 300_000, 'resume_key': spec_hash(doc),
                                            'parts_to': 'projects/ep12/exports/studio/v4/parts'})

    def test_the_lead_in_is_ordered_and_only_on_the_full_passes(self):
        _, spec = self.spec(mode='export', quality='export')
        self.assertEqual([(c['source'], c['at']) for c in spec['concat']],
                         [('projects/ep12/assets/intro.mp4', 'start'), ('projects/ep12/assets/outro.mp4', 'end')])
        self.assertEqual([(c['text'], c['seconds'], c['at']) for c in spec['cards']],
                         [('Episode 12', 3.0, 'start')])
        self.assertEqual(spec['music'], {'source': 'projects/ep12/assets/bed.mp3', 'gain_db': -20})
        self.assertEqual(spec['overlays'], [{'image': 'projects/ep12/assets/logo.png', 'corner': 'tr'}])

    def test_an_audio_only_episode_exports_audio(self):
        _, spec = self.spec(mode='export', quality='export',
                            media={'duration_ms': 10_000, 'has_video': False})
        self.assertEqual([o['file'] for o in spec['outputs']],
                         ['episode-audio.mp3', 'episode.mp3', 'episode.wav'])
        self.assertFalse(spec['outputs'][0]['captions'])

    def test_a_preview_is_cached_by_edit_tier_and_window(self):
        doc, spec = self.spec()
        self.assertEqual(spec['cache_key'], preview_cache_key(doc, {'tier': 'standard'}, None))
        self.assertEqual(spec['meta']['spec_hash'], spec_hash(doc))
        _, ranged = self.spec(range_text='1000-3000')
        self.assertNotEqual(ranged['cache_key'], spec['cache_key'])   # a different window is a different file
        _, exported = self.spec(mode='export', quality='export')
        self.assertIsNone(exported['cache_key'])                      # an export is never served from a cache

    def test_the_audio_settings_come_from_the_edit_and_the_tier(self):
        _, spec = self.spec(mode='export', quality='export',
                            edits=edits([], audio={'master': False, 'noise_reduction': False}))
        self.assertFalse(spec['audio']['denoise'])
        self.assertTrue(spec['audio']['highpass'])
        self.assertFalse(spec['audio']['master'])
        self.assertEqual(spec['audio']['loudness_lufs'], -16)
        self.assertEqual(spec['audio']['channels'], 2)


class CaptionShiftTests(unittest.TestCase):
    LINES = [{'start_ms': 0, 'end_ms': 1000, 'text': 'one', 'words': [{'w': 'one', 's': 0, 'e': 1000}]},
             {'start_ms': 2000, 'end_ms': 3000, 'text': 'two', 'words': [{'w': 'two', 's': 2000, 'e': 3000}]}]

    def test_lines_move_onto_the_windows_own_clock(self):
        moved = shift_caption_lines(self.LINES, 2000)
        self.assertEqual([(g['start_ms'], g['end_ms'], g['text']) for g in moved], [(0, 1000, 'two')])
        self.assertEqual(moved[0]['words'], [{'w': 'two', 's': 0, 'e': 1000}])

    def test_a_window_clips_what_hangs_over_its_edges(self):
        moved = shift_caption_lines(self.LINES, 500, window_ms=1000)
        self.assertEqual([(g['start_ms'], g['end_ms']) for g in moved], [(0, 500)])
        self.assertEqual(shift_caption_lines([], 0), [])


if __name__ == '__main__':
    unittest.main()
