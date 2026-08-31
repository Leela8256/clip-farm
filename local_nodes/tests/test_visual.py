"""
Smart Visual Director logic (no engine, no ffmpeg):
    python3 -m unittest discover -s local_nodes/tests -v
"""

from __future__ import annotations
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from local_nodes.podcast_common.visual import (  # noqa: E402
    DWELL_MS,
    MAX_PAN_PER_S,
    activity,
    build_layout,
    build_tracks,
    crop_path,
    crop_size,
    face_safe,
    faces_from_persons,
    people_from_samples,
    plan_segments,
    screen_share_faces,
    smooth_speakers,
    speaker_per_bin,
    speech_bins,
)

W, H = 1280, 720


def face(x, y, w, h, mouth_dy=0.55, mouth_dx=0.0):
    """A BlazeFace-style detection dict in source pixels."""
    nose = (x + w / 2, y + h * 0.5)
    return {
        'label': 'face', 'score': 0.9,
        'box': {'x1': x, 'y1': y, 'x2': x + w, 'y2': y + h},
        'centroid': {'x': x + w / 2, 'y': y + h / 2},
        'landmarks': [
            {'name': 'right_eye', 'x': x + w * 0.3, 'y': y + h * 0.35},
            {'name': 'left_eye', 'x': x + w * 0.7, 'y': y + h * 0.35},
            {'name': 'nose_tip', 'x': nose[0], 'y': nose[1]},
            {'name': 'mouth_center', 'x': nose[0] + mouth_dx * h, 'y': nose[1] + mouth_dy * h},
        ],
    }


def frames_for(seconds: float, faces_at, sample_ms=200):
    """faces_at(t_ms) -> list of faces; sampled every 200 ms."""
    out = []
    t = 0
    while t < seconds * 1000:
        out.append({'t_ms': t, 'faces': faces_at(t)})
        t += sample_ms
    return out


def talking(t_ms, period=400):
    """Mouth opens and closes: the jitter signal of a talker."""
    return 0.5 + (0.12 if (t_ms // period) % 2 else -0.12)


class TrackingTests(unittest.TestCase):
    def test_two_static_people_become_two_tracks(self):
        frames = frames_for(10, lambda t: [face(200, 200, 160, 200), face(900, 220, 150, 190)])
        tracks = build_tracks(frames, W, H)
        self.assertEqual([t['id'] for t in tracks], ['p1', 'p2'])
        self.assertEqual(tracks[0]['coverage'], 1.0)
        self.assertAlmostEqual(tracks[0]['mean_center'][0], (200 + 80) / W, places=3)
        self.assertEqual(len(tracks[0]['frames']), 50)

    def test_noise_and_gaps(self):
        def faces(t):
            out = [face(200 + (t // 200) * 2, 200, 160, 200)]  # slowly drifting person, one missed frame
            if t == 3000:
                return []
            if t == 4000:
                out.append(face(1000, 500, 40, 40))  # a one-frame false positive
            return out

        tracks = build_tracks(frames_for(8, faces), W, H)
        self.assertEqual(len(tracks), 1)
        self.assertEqual(len(tracks[0]['frames']), 39)  # 40 samples minus the missed one

    def test_empty(self):
        self.assertEqual(build_tracks([], W, H), [])
        self.assertEqual(build_tracks(frames_for(2, lambda t: []), W, H), [])

    def test_relink_after_a_gap_and_merge_duplicates(self):
        def faces(t):
            if 2000 <= t < 3200:  # a 1.2 s detection gap (head turned away)
                return []
            return [face(500, 200, 160, 200)]

        tracks = build_tracks(frames_for(8, faces), W, H)
        self.assertEqual(len(tracks), 1)
        self.assertEqual(len(tracks[0]['frames']), 34)
        # a long gap (beyond RELINK_MS) still yields one person when the boxes coincide in space
        def faces2(t):
            return [] if 2000 <= t < 5000 else [face(500, 200, 160, 200)]

        tracks = build_tracks(frames_for(8, faces2), W, H)
        self.assertEqual(len(tracks), 1)

    def test_big_face_is_not_a_violation_in_a_full_height_window(self):
        # a 640x360 source with a face 200 px tall: a full-height 9:16 window is 202 px wide
        track = build_tracks(frames_for(4, lambda t: [face(260, 60, 150, 200)]), 640, 360)[0]
        win_w, win_h = crop_size('solo_follow', 'a', 640, 360, 1080, 1920, 200)
        self.assertEqual((win_w, win_h), (202, 360))
        path = crop_path(track, 0, 4000, win_w, win_h, 640, 360)
        violations, checked = face_safe(track, path, win_w, win_h)
        self.assertEqual(violations, 0)
        plan = build_layout(frames_for(4, lambda t: [face(260, 60, 150, 200)]), [], 4000, width=640, height=360)
        p = plan['paths'][0]
        self.assertAlmostEqual(p['w'] / p['h'], 1080 / 1920, places=2)  # zoom-out never distorts


class TalkingTests(unittest.TestCase):
    def test_activity_and_speaker_attribution(self):
        frames = frames_for(6, lambda t: [face(200, 200, 160, 200, mouth_dy=talking(t)), face(900, 220, 150, 190, mouth_dy=0.55)])
        tracks = build_tracks(frames, W, H)
        act = activity(tracks, 6000)
        self.assertGreater(act['p1'][2], act['p2'][2] * 3)
        speech = speech_bins([{'start_ms': 0, 'end_ms': 6000}], 6000)
        per_bin = speaker_per_bin(tracks, act, speech)
        self.assertTrue(all(tid == 'p1' for tid, _ in per_bin))
        intervals = smooth_speakers(per_bin)
        self.assertEqual(len(intervals), 1)
        self.assertEqual((intervals[0]['track'], intervals[0]['start_ms'], intervals[0]['end_ms']), ('p1', 0, 6000))

    def test_silence_and_ties_are_unsure(self):
        frames = frames_for(4, lambda t: [face(200, 200, 160, 200, mouth_dy=talking(t)), face(900, 220, 150, 190, mouth_dy=talking(t))])
        tracks = build_tracks(frames, W, H)
        act = activity(tracks, 4000)
        no_speech = speech_bins([], 4000)
        self.assertTrue(all(tid is None for tid, _ in speaker_per_bin(tracks, act, no_speech)))
        speech = speech_bins([{'start_ms': 0, 'end_ms': 4000}], 4000)
        self.assertTrue(all(tid is None for tid, _ in speaker_per_bin(tracks, act, speech)))  # both jitter equally
        self.assertEqual(speech_bins([{'start_ms': 900, 'end_ms': 1100}], 2000), [False, True, True, False])


class PlanningTests(unittest.TestCase):
    def test_single_person_solo_and_no_face_full_frame(self):
        tracks = build_tracks(frames_for(5, lambda t: [face(500, 200, 160, 200)]), W, H)
        segs = plan_segments(tracks, [], 5000, width=W, height=H)
        self.assertEqual(segs, [{'start_ms': 0, 'end_ms': 5000, 'layout': 'solo_follow', 'subjects': ['p1'], 'reason': 'one person on screen'}])
        self.assertEqual(plan_segments([], [], 5000, width=W, height=H)[0]['layout'], 'full_frame')

    def test_two_people_stacked_unless_a_confident_talker_holds(self):
        tracks = build_tracks(frames_for(12, lambda t: [face(200, 200, 160, 200), face(900, 220, 150, 190)]), W, H)
        segs = plan_segments(tracks, [], 12_000, width=W, height=H)
        self.assertEqual([s['layout'] for s in segs], ['stacked_two'])
        speaking = [{'start_ms': 3000, 'end_ms': 9000, 'track': 'p2', 'confidence': 0.9}]
        segs = plan_segments(tracks, speaking, 12_000, width=W, height=H)
        self.assertEqual([(s['layout'], s['subjects']) for s in segs],
                         [('stacked_two', ['p1', 'p2']), ('solo_follow', ['p2']), ('stacked_two', ['p1', 'p2'])])
        for s in segs:
            self.assertGreaterEqual(s['end_ms'] - s['start_ms'], DWELL_MS)
        # a short burst of confidence does not flip the layout
        segs = plan_segments(tracks, [{'start_ms': 3000, 'end_ms': 4000, 'track': 'p2', 'confidence': 0.9}], 12_000, width=W, height=H)
        self.assertEqual([s['layout'] for s in segs], ['stacked_two'])

    def test_overrides(self):
        tracks = build_tracks(frames_for(5, lambda t: [face(200, 200, 160, 200), face(900, 220, 150, 190)]), W, H)
        self.assertEqual(plan_segments(tracks, [], 5000, width=W, height=H, subject='p2')[0]['subjects'], ['p2'])
        self.assertEqual(plan_segments(tracks, [], 5000, width=W, height=H, mode='full_frame')[0]['layout'], 'full_frame')
        self.assertEqual(plan_segments(tracks, [], 5000, width=W, height=H, mode='solo_follow')[0]['subjects'], ['p1'])

    def test_screen_share_detection(self):
        webcam = build_tracks(frames_for(5, lambda t: [face(1100, 560, 70, 80)]), W, H)
        self.assertTrue(screen_share_faces(webcam, W, H))
        self.assertEqual(plan_segments(webcam, [], 5000, width=W, height=H)[0]['layout'], 'screen_share')
        big = build_tracks(frames_for(5, lambda t: [face(500, 200, 200, 240)]), W, H)
        self.assertFalse(screen_share_faces(big, W, H))


class CropTests(unittest.TestCase):
    def test_crop_size_respects_aspect_and_source(self):
        w, h = crop_size('solo_follow', 'a', W, H, 1080, 1920, 200)
        self.assertEqual((w, h), (404, 720))
        w, h = crop_size('stacked_two', 'a', W, H, 1080, 1920, 200)
        self.assertAlmostEqual(w / h, 1080 / 960, places=2)
        self.assertEqual(h, 700)                                       # a panel is a head-and-shoulders shot (3.5 heads)
        w, h = crop_size('stacked_two', 'a', W, H, 1080, 1920, 150)   # people further away → tighter panels
        self.assertEqual(h, 524)
        self.assertLess(w, W // 2)                                     # two neighbours no longer share both panels
        w, h = crop_size('solo_follow', 'a', W, H, 1080, 1920, 60)  # small face → tighter window
        self.assertLess(h, 720)
        self.assertGreaterEqual(h, 300)

    def test_window_size_follows_the_face_within_the_segment(self):
        from local_nodes.podcast_common.visual import segment_face_h
        # one track: a close-up for 4 s (face 240 px), then a group shot (face 110 px)
        frames = [[t, 600, 100, 185, 240, 0.0, 0.0] for t in range(0, 4000, 200)] + [[t, 300, 200, 85, 110, 0.0, 0.0] for t in range(4000, 8000, 200)]
        track = {'id': 'p1', 'frames': frames, 'mean_face_h': 175 / H, 'coverage': 1.0}
        self.assertEqual(segment_face_h(track, 0, 4000, H), 240)
        self.assertEqual(segment_face_h(track, 4000, 8000, H), 110)
        self.assertAlmostEqual(segment_face_h(track, 9000, 9500, H), 175, places=6)   # no samples → clip-wide mean
        self.assertLess(crop_size('stacked_two', 'a', W, H, 1080, 1920, 110)[1], crop_size('stacked_two', 'a', W, H, 1080, 1920, 240)[1])

    def test_no_margin_is_owed_at_the_source_edge(self):
        # a 640x360 interview shot with the hair touching the top of the picture:
        # the full-height window cannot move up, so the top margin is not a cut
        track = build_tracks(frames_for(4, lambda t: [face(250, -6, 120, 156)]), 640, 360)[0]
        win_w, win_h = crop_size('solo_follow', 'a', 640, 360, 1080, 1920, 156)
        self.assertEqual(win_h, 360)
        path = crop_path(track, 0, 4000, win_w, win_h, 640, 360)
        self.assertEqual(face_safe(track, path, win_w, win_h, 640, 360)[0], 0)
        # ...but a face pushed against a window edge that could still move is one
        pushed = [[t, max(0, x - 60), y] for t, x, y in path]
        self.assertGreater(face_safe(track, pushed, win_w, win_h, 640, 360)[0], 0)

    def test_crop_path_is_smooth_and_face_safe(self):
        def faces(t):
            x = 200 + (t // 200) * 12  # walks right at 60 px/s
            return [face(x, 200, 160, 200)]

        track = build_tracks(frames_for(6, faces), W, H)[0]
        win_w, win_h = crop_size('solo_follow', 'a', W, H, 1080, 1920, 200)
        path = crop_path(track, 0, 6000, win_w, win_h, W, H)
        self.assertEqual(path[0][0], 0)
        self.assertGreaterEqual(path[-1][0], 6000)
        for a, b in zip(path, path[1:]):
            self.assertLessEqual(abs(b[1] - a[1]), MAX_PAN_PER_S * win_w * 0.2 + 1)
            self.assertTrue(0 <= b[1] <= W - win_w and 0 <= b[2] <= H - win_h)
        violations, checked = face_safe(track, path, win_w, win_h)
        self.assertGreater(checked, 20)
        self.assertLess(violations / checked, 0.2)

    def test_build_layout_end_to_end(self):
        def faces(t):
            return [face(200, 200, 160, 200, mouth_dy=talking(t)), face(900, 220, 150, 190)]

        frames = frames_for(10, faces)
        words = [{'word': 'x', 'start_ms': i * 500, 'end_ms': i * 500 + 400} for i in range(20)]
        plan = build_layout(frames, words, 10_000, width=W, height=H)
        self.assertEqual(plan['metrics']['people'], 2)
        self.assertEqual(plan['metrics']['faces_detected_pct'], 100)
        self.assertTrue(plan['speaking'] and plan['speaking'][0]['track'] == 'p1')
        self.assertIn(plan['segments'][0]['layout'], ('solo_follow', 'stacked_two'))
        self.assertTrue(plan['paths'])
        self.assertTrue(plan['metrics']['smooth'])
        self.assertEqual(plan['metrics']['speaker_visible_pct'], 100)
        forced = build_layout(frames, words, 10_000, width=W, height=H, mode='fixed_crop', focus={'x': 0.1, 'y': 0.0, 'w': 0.5, 'h': 1.0})
        self.assertEqual(forced['segments'][0]['layout'], 'fixed_crop')
        self.assertEqual(forced['paths'][0]['w'], 640)


class PoseConversionTests(unittest.TestCase):
    def person(self, cx, eye_y, eye_gap, nose_dy=12, score=0.9):
        kp = lambda name, x, y: {'name': name, 'x': x, 'y': y, 'score': score}  # noqa: E731
        return {'label': 'person', 'box': {'x1': cx - 100, 'y1': eye_y - 60, 'x2': cx + 100, 'y2': eye_y + 400},
                'keypoints': [kp('nose', cx, eye_y + nose_dy), kp('left_eye', cx - eye_gap / 2, eye_y), kp('right_eye', cx + eye_gap / 2, eye_y),
                              kp('left_ear', cx - eye_gap, eye_y + 3), kp('right_ear', cx + eye_gap, eye_y + 3),
                              kp('left_shoulder', cx - 90, eye_y + 150), kp('right_shoulder', cx + 90, eye_y + 150)]}

    def test_face_from_keypoints(self):
        faces = faces_from_persons([self.person(640, 200, 46)])
        self.assertEqual(len(faces), 1)
        f = faces[0]
        self.assertAlmostEqual(f['box']['x2'] - f['box']['x1'], 100, delta=1)   # eye gap 46 → face ~100 wide
        self.assertAlmostEqual(f['box']['y2'] - f['box']['y1'], 130, delta=2)
        self.assertEqual({kp['name'] for kp in f['landmarks']} >= {'eye_mid', 'nose_tip', 'left_eye', 'right_eye'}, True)
        self.assertIn('body', f)
        # a person without a visible face is skipped; BlazeFace records pass through
        headless = {'label': 'person', 'box': {'x1': 0, 'y1': 0, 'x2': 50, 'y2': 100}, 'keypoints': [{'name': 'left_shoulder', 'x': 1, 'y': 1, 'score': 0.9}]}
        self.assertEqual(faces_from_persons([headless]), [])
        self.assertEqual(len(faces_from_persons([face(0, 0, 10, 10)])), 1)

    def test_profile_head_is_sized_from_the_ear(self):
        # a head turned to the side: one eye, the nose in front, one ear behind —
        # the eye gap is gone, so the ear must size the head and the box must
        # reach from the nose back past the ear (not hug the front of the face)
        kp = lambda name, x, y: {'name': name, 'x': x, 'y': y, 'score': 0.9}  # noqa: E731
        profile = {'label': 'person', 'box': {'x1': 650, 'y1': 100, 'x2': 900, 'y2': 700},
                   'keypoints': [kp('nose', 800, 212), kp('left_eye', 790, 200), kp('left_ear', 730, 205),
                                 kp('right_eye', 0, 0) | {'score': 0.1}, kp('right_ear', 0, 0) | {'score': 0.1},
                                 kp('left_shoulder', 710, 350), kp('right_shoulder', 890, 350)]}
        f = faces_from_persons([profile])[0]
        w = f['box']['x2'] - f['box']['x1']
        self.assertAlmostEqual(w, 96, delta=1)                       # eye→ear 60 px × 1.6
        self.assertAlmostEqual((f['box']['x1'] + f['box']['x2']) / 2, 765, delta=1)  # between the nose and the ear
        self.assertLess(f['box']['x1'], 730)                         # behind the ear
        self.assertGreater(f['box']['x2'], 800)                      # in front of the nose

    def test_head_motion_drives_activity_without_a_mouth(self):
        def persons(t):
            nod = 12 + (6 if (t // 400) % 2 else -6)
            return faces_from_persons([self.person(300, 200, 46, nose_dy=nod), self.person(900, 200, 46, nose_dy=12)])

        frames = frames_for(6, persons)
        tracks = build_tracks(frames, W, H)
        self.assertEqual(len(tracks), 2)
        act = activity(tracks, 6000)
        self.assertGreater(act['p1'][3], act['p2'][3] * 3)
        speech = speech_bins([{'start_ms': 0, 'end_ms': 6000}], 6000)
        self.assertTrue(all(tid == 'p1' for tid, _ in speaker_per_bin(tracks, act, speech)))


class EpisodeScanTests(unittest.TestCase):
    def test_people_cluster_by_position(self):
        def faces(t):
            out = [face(200 + (t % 4000) / 400, 200, 160, 200)]
            if 10_000 <= t < 40_000:
                out.append(face(900, 220, 150, 190))
            return out

        frames = frames_for(60, faces, sample_ms=2000)
        people = people_from_samples(frames, W, H, 2000)
        self.assertEqual([p['id'] for p in people], ['p1', 'p2'])
        self.assertEqual(people[0]['coverage'], 1.0)
        self.assertEqual(people[1]['timeline'], [[10_000, 40_000]])
        self.assertEqual(len(people[1]['best_box']), 4)


if __name__ == '__main__':
    unittest.main()


class SubjectOverrideTest(unittest.TestCase):
    def test_subject_is_followed_only_while_on_screen(self):
        from local_nodes.podcast_common.visual import plan_segments
        W, H = 1280, 720
        # p1 on screen for the whole 10 s, p2 only in the second half
        p1 = {'id': 'p1', 'coverage': 1.0, 'mean_center': [0.3, 0.4], 'mean_face_h': 0.25,
              'frames': [[t, 300, 200, 120, 160, 0.0, 0.0] for t in range(0, 10000, 200)]}
        p2 = {'id': 'p2', 'coverage': 0.5, 'mean_center': [0.7, 0.4], 'mean_face_h': 0.25,
              'frames': [[t, 800, 200, 120, 160, 0.0, 0.0] for t in range(5000, 10000, 200)]}
        segs = plan_segments([p1, p2], [], 10000, width=W, height=H, subject='p2')
        self.assertEqual([(s['layout'], s['subjects']) for s in segs], [('solo_follow', ['p1']), ('solo_follow', ['p2'])])
        self.assertEqual(segs[1]['reason'], 'follow the chosen person')
        self.assertLessEqual(abs(segs[1]['start_ms'] - 5000), 1000)
        # an unknown subject falls back to the automatic plan
        auto = plan_segments([p1, p2], [], 10000, width=W, height=H, subject='p9')
        self.assertEqual([s['layout'] for s in auto], ['solo_follow', 'stacked_two'])

    def test_every_layout_holds_for_the_dwell_time(self):
        from local_nodes.podcast_common.visual import DWELL_MS, plan_segments
        W, H = 1280, 720
        # a three-way grid where the third and fourth person flicker in and out
        # in alternation: the stacked pair must not flip every second
        p1 = {'id': 'p1', 'coverage': 1.0, 'mean_center': [0.5, 0.4], 'mean_face_h': 0.25,
              'frames': [[t, 580, 200, 120, 160, 0.0, 0.0] for t in range(0, 20000, 200)]}
        p3 = {'id': 'p3', 'coverage': 0.5, 'mean_center': [0.2, 0.4], 'mean_face_h': 0.25,
              'frames': [[t, 100, 200, 120, 160, 0.0, 0.0] for t in range(0, 20000, 200) if (t // 1000) % 2 == 0]}
        p4 = {'id': 'p4', 'coverage': 0.5, 'mean_center': [0.8, 0.4], 'mean_face_h': 0.25,
              'frames': [[t, 1000, 200, 120, 160, 0.0, 0.0] for t in range(0, 20000, 200) if (t // 1000) % 2 == 1]}
        segs = plan_segments([p1, p3, p4], [], 20000, width=W, height=H)
        self.assertTrue(all(s['end_ms'] - s['start_ms'] >= DWELL_MS for s in segs), [(s['start_ms'], s['end_ms']) for s in segs])
        self.assertEqual(segs[0]['start_ms'], 0)
        self.assertEqual(segs[-1]['end_ms'], 20000)
        for a, b in zip(segs, segs[1:]):
            self.assertEqual(a['end_ms'], b['start_ms'])


class LayoutGraphTest(unittest.TestCase):
    def test_every_piece_gets_square_pixels_before_concat(self):
        """Crop windows of different aspects give scale different SARs; concat
        refuses mismatching inputs — each piece must be forced to SAR 1."""
        import tempfile
        from local_nodes.podcast_common.media import build_layout_graph, layout_pieces
        segments = [
            {'start_ms': 0, 'end_ms': 8500, 'layout': 'solo_follow', 'subjects': ['p1']},
            {'start_ms': 8500, 'end_ms': 18000, 'layout': 'stacked_two', 'subjects': ['p1', 'p2']},
            {'start_ms': 18000, 'end_ms': 20000, 'layout': 'full_frame', 'subjects': []},
        ]
        layout = {
            'canvas': {'width': 540, 'height': 960},
            'segments': segments,
            'paths': [
                {'segment': 0, 'subject': 'p1', 'panel': 'a', 'w': 322, 'h': 572, 'keyframes': [[0, 680, 42], [8500, 690, 40]]},
                {'segment': 1, 'subject': 'p1', 'panel': 'a', 'w': 430, 'h': 382, 'keyframes': [[8500, 722, 65]]},
                {'segment': 1, 'subject': 'p2', 'panel': 'b', 'w': 364, 'h': 324, 'keyframes': [[8500, 501, 50]]},
            ],
        }
        pieces = layout_pieces([(0, 20000)], segments)
        with tempfile.TemporaryDirectory() as work:
            graph = build_layout_graph(pieces, layout, 1280, 720, 30, None, Path(work))
        self.assertEqual(len(pieces), 3)
        self.assertEqual(graph.count('setsar=1'), 3)
        self.assertIn('[u0][u1][u2]concat=n=3:v=1:a=0[joined]', graph)
        # the setsar sits between each piece and the concat, never before a crop
        for i in range(3):
            self.assertIn(f'[v{i}]setsar=1[u{i}]', graph)
