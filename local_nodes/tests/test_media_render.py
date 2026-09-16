"""
media_render tests.

The first half is the renderer's library (moved out of podcast_common/media.py
with the node): the ffmpeg graph strings, the resumable part split, the spec
hash, the output->source range mapping, the ffmetadata chapters and the
caption restyling — every assertion value unchanged, they are the regression
truth for what the renderer produces.

The second half drives the NODE through generic specs — spec normalisation,
the report, the cache short-circuit, and (when ffmpeg is reachable) two real
renders over synthetic material: a clip spec and a programme spec, checked for
the same things the clip and studio paths were always checked for.

No engine and no account store: the store is a small in-memory fake.
"""

from __future__ import annotations
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from local_nodes.media_render.render_lib import (  # noqa: E402
    BLEEP_DB,
    EPISODE_PART_MS,
    LOUDNESS_TARGET_LUFS,
    TRUE_PEAK_DBTP,
    aspect_dims,
    capped_dims,
    caption_layout_for,
    chapters_payload,
    colour_dialogue,
    episode_audio_graph,
    episode_part_graph,
    ffmetadata_chapters,
    ffmpeg_exe,
    loudnorm_filter,
    parse_aspect,
    plan_episode_parts,
    range_to_keep,
    reframe_chain,
    restyle_ass,
    shift_groups,
    spec_hash,
)
from local_nodes.podcast_common.captions import build_ass  # noqa: E402


KEEP = [(0, 10_000), (15_000, 20_000)]


class EpisodeAudioGraphTest(unittest.TestCase):
    def test_mutes_and_bleeps_are_applied_on_the_source_timeline(self):
        """Silencing has to happen before the trims, or a cut would move it."""
        graph = episode_audio_graph(KEEP, mutes=[(2_000, 2_500)], bleeps=[(17_000, 17_600)])
        head = graph.split(';')[0]
        self.assertTrue(head.startswith('[0:a]'))
        self.assertIn("volume=enable='between(t,2.000,2.500)':volume=0", head)
        # the speech under a bleep is zeroed too — the tone replaces it
        self.assertIn("volume=enable='between(t,17.000,17.600)':volume=0", head)
        self.assertLess(graph.index('volume=enable'), graph.index('atrim'))

    def test_bleep_is_a_1khz_sine_at_minus_14_db_gated_to_its_range(self):
        graph = episode_audio_graph(KEEP, bleeps=[(17_000, 17_600)])
        self.assertIn('sine=frequency=1000:sample_rate=48000:duration=17.600', graph)
        self.assertIn(f'volume={BLEEP_DB}dB', graph)
        # `enable` bypasses the filter, so volume=0 sits OUTSIDE the bleep window
        self.assertIn("volume=enable='not(between(t,17.000,17.600))':volume=0:eval=frame[tone]", graph)
        self.assertIn('[speech_src][tone]amix=inputs=2:duration=first:dropout_transition=0:normalize=0', graph)

    def test_no_bleep_means_no_tone_generator(self):
        graph = episode_audio_graph(KEEP)
        self.assertNotIn('sine=', graph)
        self.assertNotIn('[tone]', graph)

    def test_keep_list_is_trimmed_and_concatenated_never_crossfaded(self):
        graph = episode_audio_graph(KEEP)
        self.assertIn('[k0]atrim=start=0.000:end=10.000', graph)
        self.assertIn('[k1]atrim=start=15.000:end=20.000', graph)
        self.assertIn('[a0][a1]concat=n=2:v=0:a=1[cat]', graph)
        self.assertNotIn('xfade', graph)
        self.assertNotIn('acrossfade', graph)

    def test_a_single_keep_segment_skips_the_split_and_the_concat(self):
        graph = episode_audio_graph([(0, 5_000)])
        self.assertNotIn('asplit', graph.split('afade')[0])
        self.assertNotIn('concat', graph)
        self.assertTrue(graph.endswith('[pre]'))

    def test_clean_up_stages_follow_the_spec_flags(self):
        full = episode_audio_graph(KEEP, noise_reduction=True, high_pass=True, compression=True)
        self.assertIn('afftdn=nr=10:nf=-40,highpass=f=80,acompressor=', full)
        none = episode_audio_graph(KEEP, noise_reduction=False, high_pass=False, compression=False)
        for stage in ('afftdn', 'highpass', 'acompressor'):
            self.assertNotIn(stage, none)
        rough = episode_audio_graph(KEEP, noise_reduction=False, high_pass=True, compression=False)
        self.assertIn('highpass=f=80[clean]', rough)
        self.assertNotIn('afftdn', rough)

    def test_music_is_ducked_by_a_sidechain_fed_from_the_speech(self):
        graph = episode_audio_graph(KEEP, music={'gain_db': -22, 'duck_db': -12, 'fade_ms': 1500})
        self.assertIn('asplit=2[spk][sc]', graph)          # one copy plays, one drives the duck
        self.assertIn('volume=-22.0dB', graph)
        self.assertIn('afade=t=in:d=1.500', graph)
        self.assertIn('[mus][sc]sidechaincompress=threshold=0.03:ratio=8.0:attack=20:release=400[duck]', graph)
        self.assertIn('[spk][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]', graph)
        # the bed is trimmed to the OUTPUT length (15 s of keep), not the source length
        self.assertIn('atrim=end=15.000', graph)

    def test_duck_depth_scales_the_compression_ratio(self):
        gentle = episode_audio_graph(KEEP, music={'gain_db': -20, 'duck_db': -6, 'fade_ms': 500})
        self.assertIn('ratio=4.0', gentle)
        hard = episode_audio_graph(KEEP, music={'gain_db': -20, 'duck_db': -24, 'fade_ms': 500})
        self.assertIn('ratio=16.0', hard)

    def test_programme_fades_close_at_the_end_of_the_output(self):
        graph = episode_audio_graph(KEEP, fade_in_ms=500, fade_out_ms=2000)
        self.assertIn('afade=t=in:d=0.500,afade=t=out:st=13.000:d=2.000[pre]', graph)

    def test_empty_keep_is_refused(self):
        with self.assertRaises(ValueError):
            episode_audio_graph([])


class MasteringGraphTest(unittest.TestCase):
    """The loudness pass belongs on the finished programme, not on the body."""

    STATS = {'input_i': '-23.4', 'input_tp': '-4.1', 'input_lra': '6.2', 'input_thresh': '-33.9',
             'target_offset': '0.3'}

    def test_the_body_pass_never_masters_on_its_own(self):
        """episode_audio_graph ends at [pre] — no loudnorm anywhere inside it."""
        graph = episode_audio_graph(KEEP, mutes=[(2_000, 2_500)], music={'gain_db': -22})
        self.assertNotIn('loudnorm', graph)
        self.assertTrue(graph.endswith('[pre]'))

    def test_the_first_pass_only_measures(self):
        first = loudnorm_filter(-16)
        self.assertEqual(first, f'loudnorm=I=-16.0:TP={TRUE_PEAK_DBTP}:LRA=11.0')
        self.assertNotIn('measured_I', first)
        self.assertEqual(loudnorm_filter(), f'loudnorm=I={LOUDNESS_TARGET_LUFS}:TP={TRUE_PEAK_DBTP}:LRA=11.0')

    def test_the_second_pass_carries_the_measurement_and_goes_linear(self):
        second = loudnorm_filter(-16, self.STATS)
        self.assertIn('measured_I=-23.4', second)
        self.assertIn('measured_TP=-4.1', second)
        self.assertIn('measured_LRA=6.2', second)
        self.assertIn('measured_thresh=-33.9', second)
        self.assertIn('offset=0.3', second)
        self.assertTrue(second.endswith(':linear=true'))

    def test_an_incomplete_measurement_falls_back_to_the_plain_filter(self):
        self.assertEqual(loudnorm_filter(-16, {'input_i': '-20'}), loudnorm_filter(-16))
        self.assertEqual(loudnorm_filter(-16, None), loudnorm_filter(-16))

    def test_a_target_from_the_edit_file_reaches_the_filter(self):
        self.assertIn('I=-14.0', loudnorm_filter(-14))


class EpisodePartsTest(unittest.TestCase):
    def test_a_long_keep_segment_is_split_inside_itself(self):
        parts = plan_episode_parts([(0, 700_000), (800_000, 830_000)])
        self.assertEqual([p['n'] for p in parts], [1, 2, 3])
        self.assertEqual(parts[0]['keep'], [[0, 300_000]])
        self.assertEqual(parts[1]['keep'], [[300_000, 600_000]])
        self.assertEqual(parts[2]['keep'], [[600_000, 700_000], [800_000, 830_000]])

    def test_output_times_are_contiguous_and_total_the_keep_length(self):
        keep = [(0, 412_000), (500_000, 913_500), (1_000_000, 1_004_000)]
        parts = plan_episode_parts(keep)
        total = sum(e - s for s, e in keep)
        self.assertEqual(parts[0]['out_start_ms'], 0)
        self.assertEqual(parts[-1]['out_end_ms'], total)
        for a, b in zip(parts, parts[1:]):
            self.assertEqual(a['out_end_ms'], b['out_start_ms'])
        self.assertEqual(sum(p['duration_ms'] for p in parts), total)
        # nothing is lost or duplicated: the slices rebuild the keep list
        flat = [tuple(x) for p in parts for x in p['keep']]
        merged: list[list[int]] = []
        for s, e in flat:
            if merged and merged[-1][1] == s:
                merged[-1][1] = e
            else:
                merged.append([s, e])
        self.assertEqual([tuple(m) for m in merged], keep)

    def test_a_short_tail_is_folded_into_the_previous_part(self):
        parts = plan_episode_parts([(0, 305_000)])
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0]['duration_ms'], 305_000)

    def test_short_episodes_are_one_part(self):
        parts = plan_episode_parts([(0, 60_000)], part_ms=EPISODE_PART_MS)
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0]['keep'], [[0, 60_000]])
        self.assertEqual(plan_episode_parts([]), [])


class SpecHashTest(unittest.TestCase):
    BASE = {'version': 4, 'source': 'projects/ep/source/a.mp4', 'keep': [[0, 1000]], 'mutes': [],
            'audio': {'master': True}, 'visual': {'aspect_ratio': '16:9'}}

    def test_range_and_quality_do_not_change_the_hash(self):
        """A range preview must not invalidate the export's finished parts."""
        a = spec_hash({**self.BASE, 'range': None, 'quality': 'full'})
        b = spec_hash({**self.BASE, 'range': [0, 30_000], 'quality': 'rough'})
        self.assertEqual(a, b)

    def test_volatile_timestamps_do_not_change_the_hash(self):
        a = spec_hash({**self.BASE, 'prepared_at': 1.0, 'warnings': []})
        b = spec_hash({**self.BASE, 'prepared_at': 2.0, 'warnings': ['the logo file was skipped']})
        self.assertEqual(a, b)

    def test_an_edit_changes_the_hash(self):
        a = spec_hash(self.BASE)
        self.assertNotEqual(a, spec_hash({**self.BASE, 'keep': [[0, 900]]}))
        self.assertNotEqual(a, spec_hash({**self.BASE, 'visual': {'aspect_ratio': '9:16'}}))
        self.assertEqual(len(a), 16)


class RangeMappingTest(unittest.TestCase):
    # two kept pieces: source 0-10s -> output 0-10s, source 15-20s -> output 10-15s
    MAP = [[0, 10_000, 0], [15_000, 20_000, 10_000]]

    def test_a_window_inside_one_piece_maps_straight_back(self):
        self.assertEqual(range_to_keep(self.MAP, 2_000, 5_000), [(2_000, 5_000)])

    def test_a_window_across_a_cut_becomes_two_source_slices(self):
        self.assertEqual(range_to_keep(self.MAP, 9_000, 11_000), [(9_000, 10_000), (15_000, 16_000)])

    def test_a_window_in_the_tail_maps_past_the_cut(self):
        self.assertEqual(range_to_keep(self.MAP, 12_000, 15_000), [(17_000, 20_000)])

    def test_empty_and_inverted_windows_give_nothing(self):
        self.assertEqual(range_to_keep(self.MAP, 5_000, 5_000), [])
        self.assertEqual(range_to_keep(self.MAP, 8_000, 4_000), [])
        self.assertEqual(range_to_keep([], 0, 1_000), [])

    def test_captions_shift_onto_a_part_timeline_and_drop_what_falls_outside(self):
        groups = [
            [{'word': 'one', 'start_ms': 500, 'end_ms': 900}],
            [{'word': 'two', 'start_ms': 5_000, 'end_ms': 5_400}],
            [{'word': 'three', 'start_ms': 11_000, 'end_ms': 11_500}],
        ]
        shifted = shift_groups(groups, 4_000, 5_000)
        self.assertEqual([g[0]['word'] for g in shifted], ['two'])
        self.assertEqual(shifted[0][0]['start_ms'], 1_000)
        self.assertEqual(shifted[0][0]['end_ms'], 1_400)
        # a lead-in (intro + title card) shifts every line later
        later = shift_groups(groups, -3_000)
        self.assertEqual(later[0][0]['start_ms'], 3_500)


class PartGraphTest(unittest.TestCase):
    def test_every_piece_gets_square_pixels_before_the_concat(self):
        graph = episode_part_graph([(60_000, 70_000), (80_000, 85_000)], 1920, 1080, 30, base_ms=60_000)
        self.assertEqual(graph.count('setsar=1'), 3)          # two pieces + the reframe
        self.assertIn('[v0][v1]concat=n=2:v=1:a=0[joined]', graph)
        for i in range(2):
            self.assertIn(f'setsar=1[v{i}]', graph)
        self.assertNotIn('xfade', graph)

    def test_trims_are_relative_to_the_parts_own_seek(self):
        """The part is decoded with -ss at its first keep start."""
        graph = episode_part_graph([(60_000, 70_000), (80_000, 85_000)], 1280, 720, 30, base_ms=60_000)
        self.assertIn('[b0]trim=start=0.000:end=10.000', graph)
        self.assertIn('[b1]trim=start=20.000:end=25.000', graph)

    def test_fit_on_blur_letterboxes_over_a_blurred_copy(self):
        graph = episode_part_graph([(0, 5_000)], 1080, 1920, 30, fit='fit', background='blur')
        self.assertIn('gblur=sigma=30', graph)
        self.assertIn('scale=1080:1920:force_original_aspect_ratio=decrease[rf_fgo]', graph)
        self.assertIn('overlay=(W-w)/2:(H-h)/2,setsar=1[rf_out]', graph)

    def test_fit_on_a_colour_pads_instead_of_blurring(self):
        graph = episode_part_graph([(0, 5_000)], 1080, 1080, 30, fit='fit', background='#101820')
        self.assertNotIn('gblur', graph)
        self.assertIn('pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=0x101820,setsar=1', graph)

    def test_fill_crops_to_cover(self):
        chain = reframe_chain(1080, 1920, 'fill', 'blur')
        self.assertEqual(len(chain), 1)
        self.assertIn('force_original_aspect_ratio=increase,crop=1080:1920,setsar=1', chain[0])

    def test_logo_then_captions_then_pixel_format(self):
        graph = episode_part_graph([(0, 5_000)], 1920, 1080, 30, ass_path='/tmp/c.ass',
                                   logo={'corner': 'br', 'height': 0.12, 'opacity': 0.8})
        self.assertIn('[1:v]scale=-1:130,format=rgba,colorchannelmixer=aa=0.800[lg]', graph)
        self.assertIn('[rf_out][lg]overlay=W-w-43:H-h-43:format=auto:shortest=1[logoed]', graph)
        self.assertLess(graph.index('[logoed]'), graph.index('subtitles'))
        self.assertTrue(graph.endswith('format=yuv420p[vout]'))

    def test_a_part_with_no_frame_sized_slice_is_refused(self):
        with self.assertRaises(ValueError):
            episode_part_graph([(0, 10)], 1920, 1080, 30)


class AspectTest(unittest.TestCase):
    def test_1080p_is_measured_on_the_short_edge(self):
        self.assertEqual(aspect_dims('16:9'), (1920, 1080))
        self.assertEqual(aspect_dims('9:16'), (1080, 1920))
        self.assertEqual(aspect_dims('1:1'), (1080, 1080))
        self.assertEqual(aspect_dims('4:5'), (1080, 1350))

    def test_previews_cap_the_long_edge(self):
        self.assertEqual(capped_dims('16:9', 640), (640, 360))
        self.assertEqual(capped_dims('9:16', 640), (360, 640))
        self.assertEqual(capped_dims('16:9', 1280), (1280, 720))

    def test_unknown_aspects_fall_back_to_wide(self):
        self.assertEqual(parse_aspect(None), (16, 9))
        self.assertEqual(parse_aspect('nonsense'), (16, 9))
        self.assertEqual(parse_aspect('2:3'), (2, 3))

    def test_caption_geometry_follows_the_frame(self):
        self.assertEqual(caption_layout_for(1080, 1920), 'vertical')
        self.assertEqual(caption_layout_for(1920, 1080), 'wide')
        self.assertEqual(caption_layout_for(1080, 1080), 'wide')


class ChaptersTest(unittest.TestCase):
    MARKS = [{'title': 'Intro', 'out_ms': 0}, {'title': 'The interview', 'out_ms': 60_000}]

    def test_ffmetadata_header_and_timebase(self):
        text = ffmetadata_chapters(self.MARKS, 120_000, 'Episode 12')
        self.assertTrue(text.startswith(';FFMETADATA1\n'))
        self.assertIn('title=Episode 12', text)
        self.assertEqual(text.count('[CHAPTER]'), 2)
        self.assertEqual(text.count('TIMEBASE=1/1000'), 2)

    def test_each_chapter_ends_where_the_next_begins_and_the_last_at_the_end(self):
        text = ffmetadata_chapters(self.MARKS, 120_000)
        starts = [int(m) for m in re.findall(r'^START=(\d+)$', text, re.M)]
        ends = [int(m) for m in re.findall(r'^END=(\d+)$', text, re.M)]
        self.assertEqual(starts, [0, 60_000])
        self.assertEqual(ends, [60_000, 120_000])

    def test_marks_are_sorted_and_specials_escaped(self):
        text = ffmetadata_chapters([{'title': 'B=2', 'out_ms': 5_000}, {'title': 'A', 'out_ms': 0}], 10_000)
        self.assertLess(text.index('title=A'), text.index(r'title=B\=2'))

    def test_chapters_json_carries_ends_and_labels(self):
        payload = chapters_payload(self.MARKS, 3_723_000)
        self.assertEqual(payload['schema_version'], 1)
        self.assertEqual(payload['chapters'][0], {'title': 'Intro', 'start_ms': 0, 'end_ms': 60_000,
                                                  'start': '00:00:00'})
        self.assertEqual(payload['chapters'][-1]['end_ms'], 3_723_000)
        self.assertEqual(payload['chapters'][-1]['start'], '00:01:00')


class CaptionStyleTest(unittest.TestCase):
    GROUPS = [[{'word': 'hello', 'start_ms': 0, 'end_ms': 400, 'speaker': 's1'},
               {'word': 'there', 'start_ms': 400, 'end_ms': 900, 'speaker': 's1'}],
              [{'word': 'again', 'start_ms': 1_200, 'end_ms': 1_600, 'speaker': 's2'}]]

    def test_karaoke_off_strips_the_word_timings(self):
        ass = build_ass(self.GROUPS, 'wide', 'classic')
        self.assertIn(r'{\k', ass)
        plain = restyle_ass(ass, {'karaoke': False})
        self.assertNotIn(r'{\k', plain)
        self.assertEqual(plain.count('Dialogue:'), 2)

    def test_font_size_colour_and_position_reach_the_style_line(self):
        ass = restyle_ass(build_ass(self.GROUPS, 'wide', 'classic'),
                          {'font': 'Inter', 'size': 72, 'color': '#FF4D2E', 'position': 'top'})
        style = next(line for line in ass.splitlines() if line.startswith('Style: Default,'))
        fields = style.split(',')
        self.assertEqual(fields[1], 'Inter')
        self.assertEqual(fields[2], '72')
        self.assertEqual(fields[3], '&H002E4DFF')      # ASS colours are &HAABBGGRR
        self.assertEqual(fields[18], '8')              # top alignment

    def test_per_speaker_colours_override_each_line(self):
        ass = build_ass(self.GROUPS, 'wide', 'classic')
        coloured = colour_dialogue(ass, ['#FF4D2E', '#2E7DFF'])
        lines = [line for line in coloured.splitlines() if line.startswith('Dialogue:')]
        self.assertIn(r'{\c&H002E4DFF}', lines[0])
        self.assertIn(r'{\c&HFF7D2E}', lines[1].replace('&H00FF7D2E', '&HFF7D2E'))

    def test_an_empty_style_leaves_the_script_alone(self):
        ass = build_ass(self.GROUPS, 'vertical', 'classic')
        self.assertEqual(restyle_ass(ass, {}).strip(), ass.strip())


def _ffmpeg_available() -> bool:
    exe = ffmpeg_exe()
    return bool(shutil.which(exe) or os.path.exists(exe))


@unittest.skipUnless(_ffmpeg_available(), 'no ffmpeg binary reachable')
@unittest.skipIf(os.environ.get('PODCAST_SKIP_FFMPEG'), 'ffmpeg smoke test disabled')
class EpisodeSmokeTest(unittest.TestCase):
    """One real render over a six second synthetic source (a few seconds of work)."""

    @staticmethod
    def _duration_ms(path: Path) -> int:
        out = subprocess.run([ffmpeg_exe(), '-hide_banner', '-i', str(path)], capture_output=True, text=True).stderr
        m = re.search(r'Duration:\s*(\d+):(\d+):(\d+\.\d+)', out)
        assert m, out[-400:]
        return int((int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))) * 1000)

    def test_cuts_mutes_and_bleeps_render_and_mux(self):
        from local_nodes.media_render.render_lib import (
            concat_parts, mux_episode, render_episode_audio, render_episode_part,
        )

        work = Path(tempfile.mkdtemp(prefix='studio_smoke_'))
        try:
            source = work / 'source.mp4'
            subprocess.run(
                [ffmpeg_exe(), '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i',
                 'testsrc2=size=640x360:rate=15:duration=6', '-f', 'lavfi', '-i',
                 'sine=frequency=440:sample_rate=48000:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast',
                 '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', str(source)],
                check=True, capture_output=True, text=True,
            )
            keep = [(0, 2_000), (3_000, 6_000)]        # one second cut out of the middle
            audio = render_episode_audio(source, keep, work / 'body.wav', mutes=[(500, 800)],
                                         bleeps=[(4_000, 4_400)], noise_reduction=False, compression=False,
                                         master=False, channels=1)
            self.assertTrue(audio.exists() and audio.stat().st_size > 40_000)
            part = render_episode_part(source, keep, work / 'part-001.mp4', 320, 180, fps=15, crf=32,
                                       preset='ultrafast', fit='fit', background='#000000')
            joined = concat_parts([part], work / 'video.mp4', work)
            final = mux_episode(joined, audio, work / 'episode.mp4')
            self.assertAlmostEqual(self._duration_ms(final), 5_000, delta=400)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def test_a_loud_intro_cannot_push_the_finished_file_off_target(self):
        """
        The defect this guards: mastering the body alone and bolting the intro
        and outro on afterwards. Here the added clips are 25 dB louder than the
        episode body, so a body-only master would leave the finished mp4 far
        above -16 LUFS. Mastering the assembled programme lands it anyway.
        """
        from local_nodes.media_render.render_lib import (
            assemble_episode_audio, master_wav, measure_loudness, mux_episode,
        )

        work = Path(tempfile.mkdtemp(prefix='studio_master_'))
        try:
            def tone(name: str, seconds: float, hz: int, volume: str) -> Path:
                path = work / name
                subprocess.run(
                    [ffmpeg_exe(), '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i',
                     f'sine=frequency={hz}:sample_rate=48000:duration={seconds}',
                     '-af', f'volume={volume}', '-ac', '2', '-c:a', 'pcm_s16le', str(path)],
                    check=True, capture_output=True, text=True)
                return path

            # ffmpeg's sine generator sits near -22 LUFS, so the levels are set
            # from there: the stings land around -4 LUFS, the body around -29
            intro = tone('intro.wav', 3, 440, '18dB')         # a brand sting at full level
            body = tone('body.wav', 6, 220, '-7dB')           # the quiet episode itself
            outro = tone('outro.wav', 3, 660, '18dB')
            programme = assemble_episode_audio(
                [{'path': str(intro)}, {'silence_ms': 1_000}, {'path': str(body)},
                 {'silence_ms': 1_000}, {'path': str(outro)}],
                work / 'programme.wav')

            raw = measure_loudness(programme)
            self.assertIsNotNone(raw)
            self.assertGreater(raw['integrated_lufs'], LOUDNESS_TARGET_LUFS + 1.0)   # the problem is real

            mastered = master_wav(programme, work / 'mastered.wav', loudness_lufs=LOUDNESS_TARGET_LUFS)
            picture = work / 'picture.mp4'
            subprocess.run(
                [ffmpeg_exe(), '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i',
                 'testsrc2=size=320x180:rate=15:duration=14', '-c:v', 'libx264', '-preset', 'ultrafast',
                 '-pix_fmt', 'yuv420p', str(picture)], check=True, capture_output=True, text=True)
            final = mux_episode(picture, mastered, work / 'episode.mp4')

            measured = measure_loudness(final)
            self.assertIsNotNone(measured)
            self.assertAlmostEqual(measured['integrated_lufs'], LOUDNESS_TARGET_LUFS, delta=1.0)
            self.assertLessEqual(measured['true_peak_dbtp'], TRUE_PEAK_DBTP + 0.2)
        finally:
            shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- the node
#
# Driving IInstance needs the engine's own names (rocketlib, ai.common.schema)
# and its account store; both are stubbed so the node's whole contract can be
# exercised without an engine.


def _install_engine_stubs() -> None:
    """
    Stand in for the engine's own modules. The stubs are tolerant on purpose —
    an attribute nobody defined comes back as a dummy — so that whichever test
    module happens to install them first, every other node's tests still find
    the names they import.
    """
    import types

    def stub(name: str, **attrs) -> types.ModuleType:
        module = sys.modules.get(name)
        if module is None:
            module = types.ModuleType(name)
            sys.modules[name] = module
        for key, value in attrs.items():
            if not hasattr(module, key):
                setattr(module, key, value)
        if '__getattr__' not in module.__dict__:
            module.__getattr__ = lambda missing: type(missing, (), {})       # noqa: E731
        return module

    class Answer:
        def __init__(self, expectJson: bool = False):   # noqa: N803 — the engine's spelling
            self.expectJson = expectJson
            self.payload = None

        def setAnswer(self, payload):                   # noqa: N802 — the engine's spelling
            self.payload = payload

    rocketlib = stub('rocketlib', IInstanceBase=object, IGlobalBase=object, Entry=object, OPEN_MODE=None,
                     debug=lambda *a, **k: None, warning=lambda *a, **k: None)
    rocketlib.engine = stub('rocketlib.engine', monitorSSE=None)
    ai = stub('ai')
    ai.common = stub('ai.common')
    ai.common.schema = stub('ai.common.schema', Answer=Answer, Question=object)


_install_engine_stubs()

import json  # noqa: E402
import types  # noqa: E402

import local_nodes.media_render.IInstance as node_module  # noqa: E402
from local_nodes.media_render import plan as plan_lib  # noqa: E402
from local_nodes.media_render import report as report_lib  # noqa: E402
from local_nodes.podcast_common import cache as cache_lib  # noqa: E402


class FakeStore:
    """The engine's account file store, in memory."""

    def __init__(self, files: dict | None = None):
        self.files: dict[str, bytes] = dict(files or {})

    # --- the async surface podcast_common.store drives
    async def open_read(self, path):
        if path not in self.files:
            raise FileNotFoundError(path)
        return {'handle': path, 'size': len(self.files[path])}

    async def read_chunk(self, handle, offset, size):
        return self.files[handle][offset:offset + size]

    async def close_read(self, handle):
        return None

    async def open_write(self, path):
        self.files[path] = b''
        return path

    async def write_chunk(self, handle, data):
        self.files[handle] += data

    async def close_write(self, handle):
        return None

    async def stat(self, path):
        if path in self.files:
            return {'exists': True, 'size': len(self.files[path]), 'type': 'file', 'modified': 1}
        return {'exists': False}

    async def list_dir(self, path):
        return {'entries': []}

    # --- test conveniences
    def put(self, path: str, local: Path) -> None:
        self.files[path] = Path(local).read_bytes()

    def json(self, path: str):
        return json.loads(self.files[path].decode('utf-8'))

    def text(self, path: str) -> str:
        return self.files[path].decode('utf-8')


class FakeInstance:
    pipeId = 7

    def __init__(self):
        self.answers: list = []
        self.texts: list[str] = []

    def hasListener(self, lane: str) -> bool:
        return True

    def writeAnswers(self, answer):
        self.answers.append(answer.payload)

    def writeText(self, text):
        self.texts.append(text)


def run_node(spec: dict, store: FakeStore, config: dict | None = None) -> dict:
    """One pass of the node over one spec, as the engine would run it."""
    node = node_module.IInstance.__new__(node_module.IInstance)
    node.IGlobal = types.SimpleNamespace(config={**plan_lib.DEFAULTS, **(config or {})})
    node.instance = FakeInstance()
    node.open(None)
    node.writeText(json.dumps(spec))
    original = node_module.get_store
    node_module.get_store = lambda: store
    try:
        node.closing()
    finally:
        node_module.get_store = original
    return node.instance.answers[-1]


class SpecTest(unittest.TestCase):
    """The spec is the contract: what the node reads out of one JSON document."""

    SPEC = {'source': 'media/in.mp4', 'keep': [[0, 10_000], [15_000, 20_000]],
            'outputs': [{'key': 'vertical', 'name': 'clip1', 'layout': 'vertical', 'long_edge': 1920}],
            'write_to': 'out'}

    def test_an_output_takes_its_geometry_from_its_layout_and_long_edge(self):
        out = plan_lib.normalize_outputs(self.SPEC)[0]
        self.assertEqual((out['width'], out['height']), (1080, 1920))
        self.assertEqual((out['file'], out['key'], out['container']), ('clip1.mp4', 'vertical', 'mp4'))
        self.assertEqual(out['caption_layout'], 'vertical')
        self.assertTrue(out['framing'])                      # portrait: a framing plan drives it
        wide = plan_lib.normalize_outputs({**self.SPEC, 'outputs': [{'key': 'wide', 'layout': 'wide',
                                                                    'long_edge': 1920}]})[0]
        self.assertEqual((wide['width'], wide['height']), (1920, 1080))
        self.assertFalse(wide['framing'])                    # wide is letterboxed as it always was
        self.assertEqual(wide['caption_layout'], 'wide')

    def test_the_feed_shapes_and_explicit_sizes_both_work(self):
        for layout, expected in (('4:5', (1080, 1350)), ('1:1', (1080, 1080))):
            out = plan_lib.normalize_outputs({**self.SPEC, 'outputs': [{'key': layout, 'layout': layout,
                                                                        'long_edge': 1920}]})[0]
            self.assertEqual((out['width'], out['height']), expected)
            self.assertEqual(out['caption_layout'], layout)
        exact = plan_lib.normalize_outputs({**self.SPEC, 'outputs': [{'key': 'episode', 'width': 1280,
                                                                      'height': 720}]})[0]
        self.assertEqual((exact['width'], exact['height'], exact['caption_layout']), (1280, 720, 'wide'))

    def test_the_node_config_only_fills_what_the_output_left_out(self):
        config = {'fps': 24, 'crf': 28, 'preset': 'ultrafast', 'long_edge': 960}
        out = plan_lib.normalize_outputs(self.SPEC, {**plan_lib.DEFAULTS, **config})[0]
        self.assertEqual((out['fps'], out['crf'], out['preset']), (24, 28, 'ultrafast'))
        stated = plan_lib.normalize_outputs(
            {**self.SPEC, 'outputs': [{'key': 'v', 'layout': 'vertical', 'fps_max': 30, 'crf': 19,
                                       'preset': 'fast'}]}, {**plan_lib.DEFAULTS, **config})[0]
        self.assertEqual((stated['fps'], stated['crf'], stated['preset']), (30, 19, 'fast'))
        self.assertEqual((stated['width'], stated['height']), (540, 960))     # long edge from the config

    def test_audio_outputs_and_duplicate_keys(self):
        outs = plan_lib.normalize_outputs({**self.SPEC, 'outputs': [
            {'key': 'episode', 'name': 'episode', 'width': 640, 'height': 360},
            {'key': 'mp3', 'name': 'episode', 'container': 'mp3', 'from': 'programme_audio'}]})
        self.assertEqual([o['video'] for o in outs], [True, False])
        self.assertEqual(outs[1]['file'], 'episode.mp3')
        with self.assertRaises(ValueError):
            plan_lib.normalize_outputs({**self.SPEC, 'outputs': [{'key': 'a'}, {'key': 'a'}]})
        with self.assertRaises(ValueError):
            plan_lib.normalize_outputs({**self.SPEC, 'outputs': []})
        with self.assertRaises(ValueError):
            plan_lib.normalize_outputs({**self.SPEC, 'outputs': [{'key': 'a', 'container': 'ogg'}]})

    def test_a_source_without_a_picture_keeps_only_the_audio_outputs(self):
        outs = plan_lib.normalize_outputs({**self.SPEC, 'outputs': [
            {'key': 'vertical', 'layout': 'vertical'}, {'key': 'audio', 'container': 'mp3'}]}, None, False)
        self.assertEqual([o['key'] for o in outs], ['audio'])

    def test_a_window_renders_only_the_source_behind_it(self):
        plan = plan_lib.resolve_keep({**self.SPEC, 'map': [[0, 10_000, 0], [15_000, 20_000, 10_000]],
                                      'window': [9_000, 11_000]})
        self.assertEqual(plan['keep'], [(9_000, 10_000), (15_000, 16_000)])
        self.assertEqual(plan['offset_ms'], 9_000)
        self.assertEqual(plan['body_ms'], 2_000)
        self.assertEqual(plan['full_keep'], [(0, 10_000), (15_000, 20_000)])
        with self.assertRaises(ValueError):
            plan_lib.resolve_keep({**self.SPEC, 'window': [10_000, 10_000]})
        with self.assertRaises(ValueError):
            plan_lib.resolve_keep({'source': 'x', 'outputs': []})

    def test_keep_defaults_to_the_whole_source_range(self):
        plan = plan_lib.resolve_keep({'source': 'x', 'source_range': [4_000, 9_000]})
        self.assertEqual(plan['keep'], [(0, 5_000)])
        self.assertEqual(plan['source_range'], [4_000, 9_000])

    def test_the_pipeline_follows_the_shape_of_the_spec(self):
        self.assertEqual(plan_lib.choose_pipeline(self.SPEC), 'clip')
        for key, value in (('chunking', {'part_ms': 300_000}), ('bleeps', [[1, 2]]),
                           ('music', {'source': 'm.mp3'}), ('cards', [{'text': 'hi'}]),
                           ('concat', [{'source': 'i.mp4'}]), ('chapters', [{'title': 'One', 'out_ms': 0}])):
            self.assertEqual(plan_lib.choose_pipeline({**self.SPEC, key: value}), 'programme', key)
        self.assertEqual(plan_lib.choose_pipeline({**self.SPEC, 'pipeline': 'programme'}), 'programme')
        self.assertEqual(plan_lib.choose_pipeline({**self.SPEC, 'bleeps': [[1, 2]], 'pipeline': 'clip'}), 'clip')

    def test_words_are_mapped_through_the_keep_list_and_grouped(self):
        words = [{'w': 'one', 's': 500, 'e': 900}, {'w': 'cut', 's': 11_000, 'e': 11_400},
                 {'w': 'two', 's': 16_000, 'e': 16_400}]
        caps = plan_lib.caption_plan({**self.SPEC, 'subtitles': {'words': words}},
                                     [(0, 10_000), (15_000, 20_000)])
        said = [w['word'] for group in caps['groups'] for w in group]
        self.assertEqual(said, ['one', 'two'])               # the word inside the cut is gone
        self.assertEqual(caps['groups'][0][0]['start_ms'], 500)
        self.assertEqual([w['start_ms'] for g in caps['groups'] for w in g][-1], 11_000)
        self.assertTrue(caps['enabled'])

    def test_caption_lines_can_arrive_ready_made_on_the_output_timeline(self):
        subs = {'groups': [{'start_ms': 0, 'end_ms': 900, 'speaker': 's1',
                            'words': [{'w': 'hello', 's': 0, 'e': 400}, {'w': 'there', 's': 400, 'e': 900}]}],
                'style': {'preset': 'clean'}}
        caps = plan_lib.caption_plan({**self.SPEC, 'subtitles': subs}, [(0, 10_000)])
        self.assertEqual([w['word'] for w in caps['groups'][0]], ['hello', 'there'])
        self.assertEqual([w['speaker'] for w in caps['groups'][0]], ['s1', 's1'])
        self.assertEqual(caps['style']['preset'], 'minimal')      # `clean` is the minimal look
        off = plan_lib.caption_plan({**self.SPEC, 'subtitles': {**subs, 'style': {'preset': 'off'}}}, None)
        self.assertFalse(off['enabled'])

    def test_the_cache_key_is_the_callers_or_the_spec_hash(self):
        self.assertEqual(plan_lib.cache_key_for({**self.SPEC, 'cache_key': 'abc123'}), 'abc123')
        a = plan_lib.cache_key_for({**self.SPEC, 'window': [0, 1000], 'quality': 'range',
                                    'prepared_at': 1.0, 'warnings': []})
        b = plan_lib.cache_key_for({**self.SPEC, 'window': None, 'quality': 'standard',
                                    'prepared_at': 2.0, 'warnings': ['skipped']})
        self.assertEqual(a, b)
        self.assertEqual(len(a), 16)
        self.assertNotEqual(a, plan_lib.cache_key_for({**self.SPEC, 'keep': [[0, 900]]}))

    def test_a_plan_of_full_frames_does_not_reframe(self):
        flat = {'segments': [{'layout': 'full_frame', 'start_ms': 0, 'end_ms': 5_000}]}
        self.assertFalse(plan_lib.reframes(flat))
        self.assertTrue(plan_lib.reframes({'segments': [{'layout': 'solo_follow'}]}))
        self.assertIsNotNone(plan_lib.framing_plan({'framing_plan': flat}))
        self.assertIsNotNone(plan_lib.framing_plan({'layout': flat}))       # the schema-1 name
        summary = plan_lib.framing_summary({**flat, 'metrics': {'people': 2}}, False)
        self.assertEqual(summary['metrics'], {'people': 2})
        self.assertFalse(summary['applied'])
        self.assertEqual(len(summary['segments']), 1)


class ReportTest(unittest.TestCase):
    """What the report may claim, and when a finished render is reused instead."""

    CHECK = {'duration_ms': 60_000, 'has_audio': True, 'has_video': True, 'width': 1920, 'height': 1080}
    ON_TARGET = {'integrated_lufs': -16.2, 'true_peak_dbtp': -1.4, 'loudness_range_lu': 7.0}

    def report(self, **over):
        payload = dict(kind='studio', mode='export', quality='export', check=self.CHECK,
                       measured=self.ON_TARGET, measurements={'episode': self.ON_TARGET}, target_lufs=-16,
                       mastered=True, total_ms=60_000, body_ms=54_000, lead_ms=4_000, tail_ms=2_000,
                       files={'episode': 'x.mp4'}, version=3, title='Episode 12', fps=30,
                       chapters=[{'title': 'Intro', 'out_ms': 4_000}, {'title': 'Guest', 'out_ms': 20_000}],
                       cache_key='abc123', warnings=[], seconds=12.0)
        payload.update(over)
        return report_lib.build_render_report(**payload)

    def test_schema_two_shape(self):
        report = self.report()
        self.assertEqual(report['schema_version'], 2)
        self.assertTrue(report['has_audio'] and report['has_video'])
        self.assertEqual([c['title'] for c in report['chapters']], ['Intro', 'Guest'])
        self.assertEqual(report['chapters'][0], {'title': 'Intro', 'out_ms': 4_000})
        self.assertEqual(report['chapter_count'], 2)
        self.assertEqual(report['clock'], {'mode': 'export', 'quality': 'export', 'range': None,
                                           'preview_output_start_ms': 0})
        self.assertEqual(sorted(report['loudness']), ['integrated_lufs', 'loudness_ok', 'loudness_range_lu',
                                                      'target_lufs', 'true_peak_dbtp'])
        self.assertEqual(report['measurements']['episode']['integrated_lufs'], -16.2)
        self.assertEqual(report['validation']['expected_duration_ms'], 60_000)
        self.assertTrue(report['validation']['duration_ok'])
        self.assertTrue(report['validation']['streams_ok'])
        self.assertTrue(report['validation']['loudness_ok'])
        self.assertEqual(report['warnings'], [])
        self.assertEqual(report['cache_key'], report['spec_hash'])

    def test_a_file_inside_tolerance_passes(self):
        for integrated, peak in ((-16.0, -1.0), (-17.0, -1.1), (-15.0, -0.8)):
            block = report_lib.loudness_block({'integrated_lufs': integrated, 'true_peak_dbtp': peak,
                                               'loudness_range_lu': 6.0}, -16)
            self.assertTrue(block['loudness_ok'], (integrated, peak))

    def test_out_of_tolerance_fails_with_a_warning(self):
        loud = self.report(measured={'integrated_lufs': -12.4, 'true_peak_dbtp': -1.2, 'loudness_range_lu': 8.0})
        self.assertFalse(loud['loudness']['loudness_ok'])
        self.assertFalse(loud['validation']['loudness_ok'])
        self.assertTrue(any('louder' in w for w in loud['warnings']))
        peaky = self.report(measured={'integrated_lufs': -16.0, 'true_peak_dbtp': -0.4, 'loudness_range_lu': 8.0})
        self.assertFalse(peaky['loudness']['loudness_ok'])
        self.assertTrue(any('dBTP' in w for w in peaky['warnings']))

    def test_an_unmastered_preview_says_so_instead_of_claiming_a_verdict(self):
        rough = self.report(mode='preview', quality='standard', mastered=False, measurements={},
                            measured=None)
        self.assertIsNone(rough['loudness']['loudness_ok'])
        self.assertTrue(rough['unmastered_preview'])
        self.assertIsNone(rough['loudness_target_lufs'])
        self.assertEqual(rough['clock']['mode'], 'rough_preview')

    def test_a_short_file_is_reported_as_a_warning(self):
        short = self.report(check={**self.CHECK, 'duration_ms': 57_000})
        self.assertFalse(short['validation']['duration_ok'])
        self.assertEqual(short['validation']['delta_ms'], -3_000)
        self.assertTrue(any('off the planned length' in w for w in short['warnings']))

    def test_the_source_window_is_reported_when_there_is_one(self):
        clip = self.report(source_range=[12_000, 42_000])
        self.assertEqual((clip['start_ms'], clip['end_ms'], clip['source_duration_ms']), (12_000, 42_000, 30_000))

    # --- the cache short-circuit (the same rules the studio preview always used)
    REPORT = {'cache_key': 'abc123', 'quality': {'tier': 'standard'}, 'range': None}

    def test_the_same_spec_at_the_same_tier_is_a_hit(self):
        self.assertTrue(report_lib.cache_hit(self.REPORT, 'abc123', 'standard'))
        self.assertTrue(report_lib.cache_hit({'spec_hash': 'abc123', 'quality': {'tier': 'standard'}},
                                             'abc123', 'standard'))

    def test_a_different_spec_tier_or_window_is_a_miss(self):
        self.assertFalse(report_lib.cache_hit(self.REPORT, 'def456', 'standard'))
        self.assertFalse(report_lib.cache_hit(self.REPORT, 'abc123', 'range'))
        self.assertFalse(report_lib.cache_hit(self.REPORT, 'abc123', 'standard', window=[0, 5_000]))

    def test_a_window_render_matches_only_its_own_window(self):
        report = {'cache_key': 'abc123', 'quality': {'tier': 'range'}, 'range': [1_000, 9_000]}
        self.assertTrue(report_lib.cache_hit(report, 'abc123', 'range', window=[1_000, 9_000]))
        self.assertFalse(report_lib.cache_hit(report, 'abc123', 'range', window=[1_000, 8_000]))
        self.assertFalse(report_lib.cache_hit(report, 'abc123', 'range'))

    def test_a_report_from_before_the_quality_block_is_never_reused(self):
        self.assertFalse(report_lib.cache_hit({'cache_key': 'abc123', 'quality': 'rough'}, 'abc123', 'standard'))
        self.assertFalse(report_lib.cache_hit(None, 'abc123', 'standard'))
        self.assertFalse(report_lib.cache_hit(self.REPORT, '', 'standard'))


class NodeContractTest(unittest.TestCase):
    """The node itself, over the fake store — no ffmpeg needed for these."""

    SPEC = {'source': 'projects/ep1/source/a.mp4', 'keep': [[0, 5_000]],
            'outputs': [{'key': 'vertical', 'name': 'clip1', 'layout': 'vertical', 'long_edge': 320}],
            'write_to': 'projects/ep1/previews', 'report_to': 'projects/ep1/previews/clip1.json',
            'status_to': 'projects/ep1/status.json', 'meta': {'clip_id': 'clip1', 'kind': 'clip'}}

    def test_a_finished_render_of_the_same_spec_is_handed_back_instead_of_made_again(self):
        done = {'schema_version': 2, 'cache_key': 'abc123', 'quality': {'tier': 'clip-preview'},
                'range': None, 'files': {'vertical': 'projects/ep1/previews/clip1.mp4'}, 'duration_ms': 5_000}
        store = FakeStore({'projects/ep1/previews/clip1.mp4': b'already rendered',
                           'projects/ep1/previews/clip1.json': json.dumps(done).encode()})
        # the source is NOT in the store: any real render would fail here
        answer = run_node({**self.SPEC, 'cache_key': 'abc123',
                           'outputs': [{**self.SPEC['outputs'][0], 'tier': 'clip-preview'}]}, store)
        self.assertTrue(answer['cached'])
        self.assertEqual(answer['duration_ms'], 5_000)
        self.assertEqual(answer['clip_id'], 'clip1')            # the caller's meta comes back
        self.assertEqual(store.json('projects/ep1/status.json')['stage'], 'rendered')
        self.assertEqual(store.json('projects/ep1/status.json')['node'], 'media_render')

    def test_a_cache_key_is_needed_before_anything_is_reused(self):
        done = {'cache_key': 'abc123', 'quality': {'tier': 'clip-preview'}, 'range': None, 'files': {}}
        store = FakeStore({'projects/ep1/previews/clip1.mp4': b'x',
                           'projects/ep1/previews/clip1.json': json.dumps(done).encode()})
        answer = run_node(self.SPEC, store)                     # no cache_key, no cache: it tries to render
        self.assertIn('error', answer)
        self.assertEqual(answer['clip_id'], 'clip1')
        self.assertEqual(store.json('projects/ep1/status.json')['stage'], 'error')

    def test_a_spec_that_cannot_be_rendered_comes_back_as_an_error_not_a_crash(self):
        store = FakeStore()
        for broken in ({**self.SPEC, 'keep': []}, {**self.SPEC, 'write_to': ''}):
            answer = run_node(broken, store)
            self.assertIn('error', answer)
        self.assertIsNone(run_node({'source': 'x'}, store).get('files'))

    def test_only_a_spec_is_accepted_off_the_text_lane(self):
        node = node_module.IInstance.__new__(node_module.IInstance)
        node.instance = FakeInstance()
        node.open(None)
        node.writeText('not json')
        node.writeText(json.dumps({'project': 'projects/ep1', 'words': 4}))     # a neighbour's payload
        self.assertIsNone(node._spec)
        node.writeText(json.dumps(self.SPEC))
        self.assertEqual(node._spec['source'], self.SPEC['source'])


def _has_filter(name: str) -> bool:
    """Whether this ffmpeg build carries a filter (burn-in needs libass)."""
    try:
        out = subprocess.run([ffmpeg_exe(), '-hide_banner', '-filters'], capture_output=True, text=True).stdout
    except OSError:
        return False
    return any(line.split()[1:2] == [name] for line in (out or '').splitlines() if line.strip())


BURN_IN = _has_filter('subtitles')          # False on a build without libass


@unittest.skipUnless(_ffmpeg_available(), 'no ffmpeg binary reachable')
@unittest.skipIf(os.environ.get('PODCAST_SKIP_FFMPEG'), 'ffmpeg smoke test disabled')
class NodeRenderTest(unittest.TestCase):
    """
    The acceptance bar: today's clip render and today's studio render, both
    reproduced through the generic spec on synthetic material.
    """

    def setUp(self):
        self.work = Path(tempfile.mkdtemp(prefix='media_render_node_'))
        self._cache_dir = cache_lib.CACHE_DIR
        cache_lib.CACHE_DIR = self.work / 'cache'
        self.addCleanup(setattr, cache_lib, 'CACHE_DIR', self._cache_dir)
        self.addCleanup(shutil.rmtree, self.work, True)

    def _source(self, seconds: int) -> Path:
        path = self.work / f'source{seconds}.mp4'
        subprocess.run(
            [ffmpeg_exe(), '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i',
             f'testsrc2=size=320x180:rate=15:duration={seconds}', '-f', 'lavfi', '-i',
             f'sine=frequency=440:sample_rate=48000:duration={seconds}', '-c:v', 'libx264',
             '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', str(path)],
            check=True, capture_output=True, text=True)
        return path

    def test_a_clip_spec_renders_captions_sidecars_a_thumbnail_and_a_mastered_mp4(self):
        store = FakeStore()
        store.put('projects/ep1/source/a.mp4', self._source(6))
        spec = {
            'source': 'projects/ep1/source/a.mp4',
            'source_range': [0, 6_000],
            'keep': [[0, 2_000], [3_000, 6_000]],          # one second cut out of the middle
            'mutes': [[500, 800]],
            'subtitles': {'sidecars': True, 'words': [
                {'w': 'hello', 's': 200, 'e': 700}, {'w': 'gone', 's': 2_200, 'e': 2_600},
                {'w': 'world', 's': 3_200, 'e': 3_800}]},
            'outputs': [{'key': 'vertical', 'name': 'clip1', 'layout': 'vertical', 'long_edge': 320,
                         'fps_max': 15, 'crf': 32, 'preset': 'ultrafast', 'tier': 'clip-preview',
                         'captions': BURN_IN}],
            'write_to': 'projects/ep1/previews', 'report_to': 'projects/ep1/previews/clip1.json',
            'status_to': 'projects/ep1/status.json',
            'media': {'width': 320, 'height': 180, 'fps': 15, 'has_video': True},
            'meta': {'clip_id': 'clip1', 'kind': 'clip'},
        }
        report = run_node(spec, store)

        self.assertNotIn('error', report)
        self.assertEqual(sorted(report['files']), ['srt', 'thumbnail', 'vertical', 'vtt'])
        self.assertEqual(report['files']['vertical'], 'projects/ep1/previews/clip1.mp4')
        for path in ('projects/ep1/previews/clip1.mp4', 'projects/ep1/previews/clip1.srt',
                     'projects/ep1/previews/clip1.vtt', 'projects/ep1/previews/clip1.jpg'):
            self.assertGreater(len(store.files.get(path, b'')), 0, path)
        # audio and picture are cut from the same keep list: 5 s of output
        self.assertAlmostEqual(report['duration_ms'], 5_000, delta=400)
        self.assertEqual((report['quality']['width'], report['quality']['height']), (180, 320))
        self.assertEqual((report['quality']['tier'], report['quality']['crf']), ('clip-preview', 32))
        self.assertFalse(report['quality']['upscaled'])
        self.assertEqual((report['cuts'], report['muted']), (1, 1))
        self.assertEqual((report['start_ms'], report['end_ms'], report['source_duration_ms']),
                         (0, 6_000, 6_000))
        self.assertEqual(report['captions'], BURN_IN)
        self.assertEqual(report['caption_lines'] > 0, BURN_IN)
        self.assertTrue(report['mastered'])
        self.assertAlmostEqual(report['loudness']['integrated_lufs'], LOUDNESS_TARGET_LUFS, delta=1.0)
        self.assertLessEqual(report['loudness']['true_peak_dbtp'], TRUE_PEAK_DBTP + 0.2)
        self.assertEqual(report['clip_id'], 'clip1')                     # the caller's meta
        self.assertEqual(store.json('projects/ep1/previews/clip1.json')['files'], report['files'])
        # the word inside the cut never reaches the captions
        srt = store.text('projects/ep1/previews/clip1.srt')
        self.assertIn('hello', srt)
        self.assertIn('world', srt)
        self.assertNotIn('gone', srt)

    def test_a_programme_spec_renders_in_resumable_parts_and_masters_the_whole_thing(self):
        store = FakeStore()
        store.put('projects/ep1/source/a.mp4', self._source(9))
        spec = {
            'source': 'projects/ep1/source/a.mp4',
            'keep': [[0, 4_000], [5_000, 9_000]],
            'bleeps': [[6_000, 6_400]],
            'cards': [{'text': 'Episode 12', 'subtitle': 'a test', 'seconds': 1, 'at': 'start'}],
            'audio': {'denoise': False, 'compress': False, 'master': True, 'loudness_lufs': -16},
            'subtitles': {'sidecars': True, 'groups': [
                {'start_ms': 0, 'end_ms': 900, 'words': [{'w': 'hello', 's': 0, 'e': 400},
                                                         {'w': 'there', 's': 400, 'e': 900}]}]},
            'chunking': {'part_ms': 3_000},
            'chapters': [{'title': 'Opening', 'out_ms': 0}, {'title': 'The rest', 'out_ms': 4_000}],
            'outputs': [
                {'key': 'episode', 'name': 'episode', 'width': 320, 'height': 180, 'fps_max': 15,
                 'crf': 32, 'preset': 'ultrafast', 'tier': 'export', 'fit': 'fit', 'background': '#000000',
                 'captions': BURN_IN},
                {'key': 'mp3', 'name': 'episode', 'container': 'mp3', 'from': 'programme_audio'}],
            'mode': 'export', 'write_to': 'projects/ep1/exports/studio/v1',
            'report_to': 'projects/ep1/exports/studio/v1/report.json',
            'status_to': 'projects/ep1/status.json',
            'media': {'width': 320, 'height': 180, 'fps': 15, 'has_video': True},
            'title': 'Episode 12', 'version': 1, 'quality': 'export',
            'meta': {'kind': 'studio', 'aspect_ratio': '16:9'},
        }
        report = run_node(spec, store)

        self.assertNotIn('error', report)
        self.assertEqual(sorted(report['files']),
                         ['chapters_json', 'chapters_txt', 'episode', 'mp3', 'srt', 'vtt'])
        self.assertEqual(report['kind'], 'studio')
        # 1 s title card + 8 s of kept material, mastered as one programme
        self.assertEqual(report['body_duration_ms'], 8_000)
        self.assertAlmostEqual(report['lead_ms'], 1_000, delta=100)
        self.assertAlmostEqual(report['duration_ms'], report['output_duration_ms'], delta=500)
        self.assertTrue(report['validation']['duration_ok'])
        self.assertTrue(report['validation']['streams_ok'])
        self.assertTrue(report['mastered'])
        self.assertAlmostEqual(report['loudness']['integrated_lufs'], LOUDNESS_TARGET_LUFS, delta=1.0)
        self.assertLessEqual(report['loudness']['true_peak_dbtp'], TRUE_PEAK_DBTP + 0.2)
        self.assertEqual((report['cuts'], report['bleeped']), (1, 1))
        self.assertEqual([c['title'] for c in report['chapters']], ['Opening', 'The rest'])
        self.assertIn('TIMEBASE=1/1000', store.text('projects/ep1/exports/studio/v1/chapters.txt'))
        self.assertEqual(store.json('projects/ep1/exports/studio/v1/chapters.json')['schema_version'], 1)
        # the picture came out of resumable parts, recorded in a manifest
        self.assertGreater(len(report['parts']), 1)
        manifest = store.json('projects/ep1/exports/studio/v1/parts/manifest.json')
        self.assertEqual(manifest['cache_key'], report['cache_key'])
        self.assertTrue(all(p['done'] for p in manifest['parts']))
        self.assertFalse(any(p['reused'] for p in report['parts']))
        self.assertGreater(len(store.files['projects/ep1/exports/studio/v1/parts/part-001.mp4']), 0)
        self.assertGreater(len(store.files['projects/ep1/exports/studio/v1/episode.mp3']), 0)

        # a second run of the same spec picks the finished parts back up
        again = run_node(spec, store)
        self.assertTrue(all(p['reused'] for p in again['parts']))
        self.assertEqual(again['cache_key'], report['cache_key'])


if __name__ == '__main__':
    unittest.main()
