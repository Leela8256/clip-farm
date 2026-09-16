"""
Smart Visual Director — pure logic over the stock detectors' output.

Input: per-frame face detections from the stock `face_detection` node (boxes +
6 BlazeFace landmarks) with the frame times from `frame_grabber`. Output: a
non-destructive layout plan for the clip —

    segments  [{start_ms, end_ms, layout, subjects, reason}]
    paths     per segment and subject, the smoothed crop window over time
    metrics   speaker visible %, layout changes, pan speed, face-safe check

Layouts: solo_follow (one subject, the crop follows them), stacked_two (two
subjects top/bottom), screen_share (content on top, the speaker below),
full_frame (the whole picture on a blurred copy of itself), fixed_crop (a
manual region), original (no reframe). The planner is conservative on purpose:
with several people and a weak "who is talking" signal it keeps both visible
(stacked) rather than guessing, so the active speaker never leaves the frame.

Who is talking is estimated from landmark motion (mouth/jaw jitter relative to
the nose, normalised by face size) gated by the clip's word timestamps — an
honest proxy until diarization arrives, and reported as such.
"""

from __future__ import annotations
import math
from typing import Any

SAMPLE_MS = 200                 # frame_grabber interval used for clips (5 fps)
MIN_TRACK_MS = 600              # shorter tracks are detector noise
MIN_TRACK_COVERAGE = 0.05       # or people who barely appear
MATCH_IOU = 0.3
MAX_MISSES = 3                  # a track survives this many missed samples
RELINK_MS = 2000                # ...and is picked up again when a face reappears nearby within this time
DUPLICATE_IOU = 0.4             # tracks that never coincide but sit on the same spot are one person
BIN_MS = 500                    # activity / speaker decision granularity
DWELL_MS = 2000                 # a layout holds at least this long
SOLO_CONFIDENCE_MS = 3000       # a confident speaker for this long earns a solo crop
ACTIVITY_MARGIN = 1.6           # the talker must beat the runner-up by this ratio
SMALL_FACE_AREA = 0.025         # faces below this share of the frame → likely a webcam overlay
CORNER_ZONE = 0.35              # ...when their centre sits in a corner region of this size
DEAD_ZONE = 0.08                # fraction of the crop width the face may drift before the crop moves
SMOOTH_ALPHA = 0.25             # exponential smoothing of the crop centre per sample
MAX_PAN_PER_S = 0.5             # crop widths per second
FACE_HEADROOM = 0.40            # face centre sits at 40% of the crop height
FACE_MARGIN = 0.25              # face-safe margin (share of face height) the planner aims for
CHECK_MARGIN = 0.10             # ...and the share the quality check insists on
LAYOUTS = ('solo_follow', 'stacked_two', 'side_by_side', 'screen_share', 'full_frame', 'fixed_crop', 'original')


# ------------------------------------------------------------------ geometry

def _box(face: dict) -> tuple[float, float, float, float]:
    b = face.get('box') or {}
    x1, y1, x2, y2 = float(b.get('x1', 0)), float(b.get('y1', 0)), float(b.get('x2', 0)), float(b.get('y2', 0))
    return x1, y1, max(0.0, x2 - x1), max(0.0, y2 - y1)


def iou(a: tuple, b: tuple) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _landmark(face: dict, name: str) -> tuple[float, float] | None:
    for kp in face.get('landmarks') or []:
        if kp.get('name') == name:
            return float(kp['x']), float(kp['y'])
    return None


KEYPOINT_MIN_SCORE = 0.3


def faces_from_persons(persons: list, min_score: float = KEYPOINT_MIN_SCORE) -> list[dict]:
    """
    Face records from the stock pose_estimation output (COCO-17 keypoints per
    person): the face box is built from the eyes/ears/nose (interpupillary
    distance ≈ 46% of the face width), the landmarks keep the names the
    activity score reads. People whose face is not visible (no nose, no eyes)
    are skipped — a back or a far body cannot be framed as a face anyway.
    BlazeFace-style records (with `landmarks`) pass through unchanged.
    """
    out: list[dict] = []
    for person in persons or []:
        if not isinstance(person, dict):
            continue
        if person.get('landmarks') and person.get('box'):
            out.append(person)
            continue
        kps = {kp.get('name'): kp for kp in person.get('keypoints') or [] if isinstance(kp, dict)}

        def pt(name: str) -> tuple[float, float] | None:
            kp = kps.get(name)
            if not kp or float(kp.get('score', 1.0)) < min_score:
                return None
            return float(kp['x']), float(kp['y'])

        nose, le, re = pt('nose'), pt('left_eye'), pt('right_eye')
        lear, rear = pt('left_ear'), pt('right_ear')
        if nose is None and (le is None or re is None):
            continue
        # the head width is the widest of the cues that are visible: the eye
        # gap (face-on), the ear gap, and in profile — where the eye gap
        # collapses to nothing — the distance from the nose or eye back to the
        # ear, which is most of the head's length
        cues: list[float] = []
        if le and re:
            eye_mid = ((le[0] + re[0]) / 2, (le[1] + re[1]) / 2)
            cues.append(math.hypot(re[0] - le[0], re[1] - le[1]) / 0.46)
        elif lear and rear:
            eye_mid = ((lear[0] + rear[0]) / 2, (lear[1] + rear[1]) / 2 - 0.02 * abs(rear[0] - lear[0]))
        else:
            eye = le or re
            eye_mid = (nose[0], eye[1]) if eye else (nose[0], nose[1] - 8)
            ls, rs = pt('left_shoulder'), pt('right_shoulder')
            if ls and rs:
                cues.append(abs(rs[0] - ls[0]) * 0.38)
            elif nose:
                cues.append(abs(nose[1] - eye_mid[1]) * 3.5)
        ears = [p for p in (lear, rear) if p]
        if lear and rear:
            cues.append(abs(rear[0] - lear[0]) * 1.05)
        front = nose or eye_mid
        for ear in ears:
            cues.append(abs(front[0] - ear[0]) * 1.25)
            near_eye = min((abs(eye[0] - ear[0]) for eye in (le, re) if eye), default=None)
            if near_eye is not None:
                cues.append(near_eye * 1.6)
        face_w = max(8.0, *cues) if cues else 8.0
        face_h = face_w * 1.3
        # centre between the front of the face and the ears: face-on they
        # coincide, in profile the head's mass sits behind the nose
        if ears:
            back_x = sum(p[0] for p in ears) / len(ears)
            cx = (front[0] + back_x) / 2
        else:
            cx = eye_mid[0] if nose is None else (eye_mid[0] + nose[0]) / 2
        top = eye_mid[1] - 0.42 * face_h
        box = {'x1': cx - face_w / 2, 'y1': top, 'x2': cx + face_w / 2, 'y2': top + face_h}
        landmarks = [{'name': 'eye_mid', 'x': eye_mid[0], 'y': eye_mid[1]}]
        if nose:
            landmarks.append({'name': 'nose_tip', 'x': nose[0], 'y': nose[1]})
        for name, p in (('left_eye', le), ('right_eye', re), ('left_ear', lear), ('right_ear', rear)):
            if p:
                landmarks.append({'name': name, 'x': p[0], 'y': p[1]})
        score = float(person.get('score') or (kps.get('nose') or {}).get('score') or 0.5)
        out.append({'label': 'face', 'score': score, 'box': box, 'centroid': {'x': cx, 'y': top + face_h / 2},
                    'landmarks': landmarks, 'body': person.get('box')})
    return out


# ------------------------------------------------------------------ tracking

def build_tracks(frames: list[dict], width: int, height: int, sample_ms: int = SAMPLE_MS) -> list[dict]:
    """
    frames: [{t_ms, faces: [face detection dicts]}] in time order, coordinates in
    source pixels. Greedy IoU matching frame to frame; a track survives one
    missed frame. Returns tracks sorted by coverage, ids p1..pN, with per-frame
    entries [t_ms, x, y, w, h, mouth_dy, mouth_dx] (mouth offsets relative to the
    nose, normalised by face height — the raw material of the talking score).
    """
    if not frames:
        return []
    active: list[dict] = []
    finished: list[dict] = []
    for frame in frames:
        t = int(frame['t_ms'])
        boxes = _dedupe_faces([(_box(f), f) for f in (frame.get('faces') or []) if _box(f)[2] > 0 and _box(f)[3] > 0])
        used = set()
        for track in active:
            best, best_iou = None, 0.0
            for i, (box, _face) in enumerate(boxes):
                if i in used:
                    continue
                score = iou(track['last_box'], box)
                if score > best_iou:
                    best, best_iou = i, score
            if best is not None and best_iou >= MATCH_IOU:
                used.add(best)
                _append(track, t, boxes[best][0], boxes[best][1])
                track['misses'] = 0
            else:
                track['misses'] += 1
        for i, (box, face) in enumerate(boxes):
            if i in used:
                continue
            # a face reappearing where a track just ended is that track again
            revived = None
            for track in finished:
                if t - track['frames'][-1][0] <= RELINK_MS and iou(track['last_box'], box) >= MATCH_IOU:
                    if revived is None or iou(track['last_box'], box) > iou(revived['last_box'], box):
                        revived = track
            if revived is not None:
                finished.remove(revived)
                _append(revived, t, box, face)
                revived['misses'] = 0
                active.append(revived)
                continue
            track = {'frames': [], 'misses': 0, 'last_box': box}
            _append(track, t, box, face)
            active.append(track)
        still = []
        for track in active:
            if track['misses'] > MAX_MISSES:
                finished.append(track)
            else:
                still.append(track)
        active = still
    finished.extend(active)
    finished = _merge_duplicates(finished)

    total_ms = max(1, int(frames[-1]['t_ms']) - int(frames[0]['t_ms']) + sample_ms)
    tracks = []
    for track in finished:
        pts = track['frames']
        span = pts[-1][0] - pts[0][0] + sample_ms
        coverage = len(pts) * sample_ms / total_ms
        tracks.append({'frames': pts, 'span_ms': span, 'coverage': round(min(1.0, coverage), 3)})
    keep = [t for t in tracks if t['span_ms'] >= MIN_TRACK_MS and t['coverage'] >= MIN_TRACK_COVERAGE]
    if not keep and tracks:
        keep = [max(tracks, key=lambda t: t['span_ms'])]
    keep.sort(key=lambda t: (-t['coverage'], t['frames'][0][0]))
    for i, track in enumerate(keep, start=1):
        xs = [p[1] + p[3] / 2 for p in track['frames']]
        ys = [p[2] + p[4] / 2 for p in track['frames']]
        hs = [p[4] for p in track['frames']]
        track['id'] = f'p{i}'
        track['mean_center'] = [round(sum(xs) / len(xs) / width, 4), round(sum(ys) / len(ys) / height, 4)]
        track['mean_face_h'] = round(sum(hs) / len(hs) / height, 4)
        track['first_ms'] = track['frames'][0][0]
        track['last_ms'] = track['frames'][-1][0]
        track['best_ms'] = max(track['frames'], key=lambda p: p[4])[0]
    return keep


def _dedupe_faces(boxes: list[tuple]) -> list[tuple]:
    """One face per spot per frame: the detector sometimes reports a body twice."""
    kept: list[tuple] = []
    for box, face in sorted(boxes, key=lambda b: -float(b[1].get('score') or 0)):
        if all(iou(box, k[0]) < 0.5 for k in kept):
            kept.append((box, face))
    return kept


def _mean_box(track: dict) -> tuple[float, float, float, float]:
    pts = track['frames']
    n = len(pts)
    return (sum(p[1] for p in pts) / n, sum(p[2] for p in pts) / n, sum(p[3] for p in pts) / n, sum(p[4] for p in pts) / n)


def _merge_duplicates(tracks: list[dict]) -> list[dict]:
    """Two tracks that never share a frame and sit on the same spot are one person."""
    merged: list[dict] = []
    for track in sorted(tracks, key=lambda t: t['frames'][0][0]):
        target = None
        for other in merged:
            times = {p[0] for p in other['frames']}
            if any(p[0] in times for p in track['frames']):
                continue
            if iou(_mean_box(other), _mean_box(track)) >= DUPLICATE_IOU:
                target = other
                break
        if target is None:
            merged.append(track)
        else:
            target['frames'] = sorted(target['frames'] + track['frames'], key=lambda p: p[0])
            target['last_box'] = max((target, track), key=lambda x: x['frames'][-1][0])['last_box']
    return merged


def _append(track: dict, t: int, box: tuple, face: dict) -> None:
    x, y, w, h = box
    nose = _landmark(face, 'nose_tip')
    mouth = _landmark(face, 'mouth_center')
    eye_mid = _landmark(face, 'eye_mid')
    if eye_mid is None:
        le, re = _landmark(face, 'left_eye'), _landmark(face, 'right_eye')
        if le and re:
            eye_mid = ((le[0] + re[0]) / 2, (le[1] + re[1]) / 2)
    if nose and mouth and h > 0:
        # mouth/jaw motion relative to the nose (BlazeFace-style landmarks)
        dy = (mouth[1] - nose[1]) / h
        dx = (mouth[0] - nose[0]) / h
    elif nose and eye_mid and h > 0:
        # head pitch/yaw proxy: the nose relative to the eyes (pose keypoints)
        dy = (nose[1] - eye_mid[1]) / h
        dx = (nose[0] - eye_mid[0]) / h
    else:
        dy = dx = None
    track['frames'].append([t, round(x, 1), round(y, 1), round(w, 1), round(h, 1), dy, dx])
    track['last_box'] = box


def _at(track: dict, t_ms: int, tolerance_ms: int = SAMPLE_MS) -> list | None:
    """The track's frame entry nearest to t (within a sample), else None."""
    best, best_d = None, tolerance_ms + 1
    for p in track['frames']:
        d = abs(p[0] - t_ms)
        if d < best_d:
            best, best_d = p, d
    return best if best_d <= tolerance_ms else None


# ------------------------------------------------------------ talking score

def speech_bins(words: list[dict], total_ms: int, bin_ms: int = BIN_MS) -> list[bool]:
    """Whether someone speaks inside each bin, from the clip's word timestamps (clip time)."""
    n = max(1, math.ceil(total_ms / bin_ms))
    bins = [False] * n
    for w in words or []:
        s, e = int(w['start_ms']), int(w['end_ms'])
        for i in range(max(0, s // bin_ms), min(n, e // bin_ms + 1)):
            bins[i] = True
    return bins


def activity(tracks: list[dict], total_ms: int, bin_ms: int = BIN_MS) -> dict[str, list[float | None]]:
    """
    Per track and bin: landmark jitter — the standard deviation of the mouth's
    offset from the nose (vertical and horizontal, in face heights) over the
    samples in the bin, plus a little box motion. None when the track is absent.
    """
    n = max(1, math.ceil(total_ms / bin_ms))
    out: dict[str, list[float | None]] = {}
    for track in tracks:
        scores: list[float | None] = [None] * n
        present = {int(p[0] // bin_ms) for p in track['frames']}
        for i in range(n):
            if i not in present:
                continue
            # a one-second window centred on the bin: at 5 fps a single bin has
            # too few samples to see the mouth move
            lo, hi = i * bin_ms - bin_ms // 2, (i + 1) * bin_ms + bin_ms // 2
            pts = [p for p in track['frames'] if lo <= p[0] < hi]
            dys = [p[5] for p in pts if p[5] is not None]
            dxs = [p[6] for p in pts if p[6] is not None]
            jitter = _std(dys) + 0.5 * _std(dxs) if len(dys) >= 2 else 0.0
            centres = [(p[1] + p[3] / 2, p[2] + p[4] / 2) for p in pts]
            motion = 0.0
            if len(centres) >= 2:
                motion = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(centres, centres[1:])) / (len(centres) - 1)
                motion /= max(1.0, sum(p[4] for p in pts) / len(pts))
            scores[i] = round(jitter * 100 + motion * 10, 3)
        out[track['id']] = scores
    return out


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1))


def speaker_per_bin(tracks: list[dict], act: dict[str, list[float | None]], speech: list[bool]) -> list[tuple[str | None, float]]:
    """
    (track id, confidence) per bin. One visible track → that track. Several →
    the most active one when it clearly leads and speech is present; otherwise
    None (unsure). Confidence is the lead ratio squashed into 0..1.
    """
    n = len(speech)
    out: list[tuple[str | None, float]] = []
    for i in range(n):
        present = [(tid, (scores[i] if i < len(scores) else None)) for tid, scores in act.items()]
        present = [(tid, s) for tid, s in present if s is not None]
        if not present:
            out.append((None, 0.0))
            continue
        if len(present) == 1:
            out.append((present[0][0], 1.0))
            continue
        present.sort(key=lambda x: -x[1])
        lead, runner = present[0][1], present[1][1]
        if speech[i] and lead > 0 and lead >= ACTIVITY_MARGIN * max(runner, 0.05):
            ratio = lead / max(runner, 0.05)
            out.append((present[0][0], round(min(1.0, (ratio - 1) / (ACTIVITY_MARGIN * 2)), 3)))
        else:
            out.append((None, 0.0))
    return out


def smooth_speakers(per_bin: list[tuple[str | None, float]], bin_ms: int = BIN_MS, hold_ms: int = 1500) -> list[dict]:
    """Merge bins into speaking intervals, holding a speaker across short unsure gaps."""
    intervals: list[dict] = []
    current: dict | None = None
    gap = 0
    for i, (tid, conf) in enumerate(per_bin):
        t0, t1 = i * bin_ms, (i + 1) * bin_ms
        if tid is None:
            if current is not None:
                gap += bin_ms
                if gap > hold_ms:
                    intervals.append(current)
                    current, gap = None, 0
            continue
        if current is not None and current['track'] == tid:
            current['end_ms'] = t1
            current['confidence'] = round((current['confidence'] + conf) / 2, 3)
            gap = 0
        else:
            if current is not None:
                intervals.append(current)
            current = {'start_ms': t0, 'end_ms': t1, 'track': tid, 'confidence': conf}
            gap = 0
    if current is not None:
        intervals.append(current)
    return intervals


# --------------------------------------------------------------- planning

def screen_share_faces(tracks: list[dict], width: int, height: int) -> bool:
    """All faces small and in a corner: a webcam overlay on shared content."""
    if not tracks:
        return False
    for track in tracks:
        cx, cy = track['mean_center']
        area = (track['mean_face_h'] * height) ** 2 / (width * height)
        in_corner = (cx < CORNER_ZONE or cx > 1 - CORNER_ZONE) and (cy < CORNER_ZONE or cy > 1 - CORNER_ZONE)
        if area > SMALL_FACE_AREA or not in_corner:
            return False
    return True


def plan_segments(
    tracks: list[dict],
    speaking: list[dict],
    total_ms: int,
    *,
    width: int,
    height: int,
    mode: str = 'auto',
    subject: str | None = None,
    bin_ms: int = BIN_MS,
    dwell_ms: int = DWELL_MS,
) -> list[dict]:
    """
    The layout timeline. Auto: no face → full_frame; screen share → screen_share
    with the (most present) face; one person → solo_follow; two or more →
    stacked_two of the two most present people, promoted to solo_follow while
    one of them is confidently speaking for SOLO_CONFIDENCE_MS. Every switch
    respects the dwell time. Overrides: subject → solo on that person; mode →
    that layout for the whole clip.
    """
    ids = [t['id'] for t in tracks]
    by_id = {t['id']: t for t in tracks}
    if mode in ('full_frame', 'original', 'fixed_crop'):
        return [{'start_ms': 0, 'end_ms': total_ms, 'layout': mode, 'subjects': [], 'reason': 'chosen by the producer'}]
    if not tracks:
        return [{'start_ms': 0, 'end_ms': total_ms, 'layout': 'full_frame', 'subjects': [], 'reason': 'no face detected'}]
    if subject and subject not in by_id:
        subject = None
    if subject and len(ids) == 1:
        return [{'start_ms': 0, 'end_ms': total_ms, 'layout': 'solo_follow', 'subjects': [subject], 'reason': 'follow the chosen person'}]
    if mode == 'solo_follow':
        lead = ids[0]
        return [{'start_ms': 0, 'end_ms': total_ms, 'layout': 'solo_follow', 'subjects': [lead], 'reason': 'solo layout chosen by the producer'}]
    if mode in ('stacked_two', 'side_by_side') and len(ids) >= 2:
        return [{'start_ms': 0, 'end_ms': total_ms, 'layout': mode, 'subjects': ids[:2], 'reason': 'two-person layout chosen by the producer'}]
    if mode == 'screen_share' or screen_share_faces(tracks, width, height):
        return [{'start_ms': 0, 'end_ms': total_ms, 'layout': 'screen_share', 'subjects': [ids[0]],
                 'reason': 'small face in a corner: shared content with a speaker overlay' if mode != 'screen_share' else 'chosen by the producer'}]
    if len(ids) == 1:
        return [{'start_ms': 0, 'end_ms': total_ms, 'layout': 'solo_follow', 'subjects': [ids[0]], 'reason': 'one person on screen'}]

    # two or more people: per moment, the people actually on screen decide —
    # stacked by default, solo while someone clearly talks, full frame when
    # nobody's face is visible (a slide, a wide shot). A chosen subject is
    # followed whenever they are on screen; the rest of the clip is planned
    # as usual so the frame is never left on an empty chair.
    coverage = {t['id']: t['coverage'] for t in tracks}
    n = max(1, math.ceil(total_ms / bin_ms))
    wish: list[tuple[str, list[str]]] = []
    for i in range(n):
        t = i * bin_ms + bin_ms // 2
        visible = [tid for tid in ids if _at(by_id[tid], t, bin_ms)]
        talker = next((s for s in speaking if s['start_ms'] <= t < s['end_ms'] and s['track'] in visible
                       and s['confidence'] >= 0.5 and s['end_ms'] - s['start_ms'] >= SOLO_CONFIDENCE_MS), None)
        weak = next((s for s in speaking if s['start_ms'] <= t < s['end_ms'] and s['track'] in visible), None)
        if subject and subject in visible:
            wish.append(('solo_follow', [subject]))
        elif talker:
            wish.append(('solo_follow', [talker['track']]))
        elif len(visible) >= 2:
            ranked = sorted(visible, key=lambda tid: -coverage[tid])
            pair = [weak['track']] + [tid for tid in ranked if tid != weak['track']][:1] if weak else ranked[:2]
            wish.append(('stacked_two', sorted(pair)))
        elif len(visible) == 1:
            wish.append(('solo_follow', visible))
        else:
            wish.append(('full_frame', []))

    segments: list[dict] = []
    current = {'start_ms': 0, 'end_ms': bin_ms, 'layout': wish[0][0], 'subjects': wish[0][1], 'reason': ''}
    pending: tuple[str, list[str]] | None = None
    pending_since = 0
    for i in range(1, n):
        t0 = i * bin_ms
        layout, subjects = wish[i]
        same = layout == current['layout'] and subjects == current['subjects']
        if same:
            current['end_ms'] = t0 + bin_ms
            pending = None
            continue
        if pending != (layout, subjects):
            pending, pending_since = (layout, subjects), t0
        held = t0 - current['start_ms']
        wanted_for = t0 + bin_ms - pending_since
        if held >= dwell_ms and wanted_for >= min(dwell_ms, 2 * bin_ms):
            # switch where the new wish began, but never cut the running
            # layout below its dwell time
            boundary = max(pending_since, current['start_ms'] + dwell_ms)
            current['end_ms'] = boundary
            segments.append(current)
            current = {'start_ms': boundary, 'end_ms': t0 + bin_ms, 'layout': layout, 'subjects': subjects, 'reason': ''}
            pending = None
        else:
            current['end_ms'] = t0 + bin_ms
    current['end_ms'] = total_ms
    if segments and total_ms - current['start_ms'] < dwell_ms:
        segments[-1]['end_ms'] = total_ms  # a last-moment switch is not worth a cut
    else:
        segments.append(current)
    merged: list[dict] = []
    for seg in segments:
        if merged and merged[-1]['layout'] == seg['layout'] and merged[-1]['subjects'] == seg['subjects']:
            merged[-1]['end_ms'] = seg['end_ms']
        else:
            merged.append(seg)
    for seg in merged:
        seg['reason'] = ('follow the chosen person' if subject and seg['subjects'] == [subject]
                         else 'one person is clearly talking' if seg['layout'] == 'solo_follow' and len(ids) > 1
                         else 'both people visible while nobody clearly leads' if seg['layout'] == 'stacked_two'
                         else 'no face on screen' if seg['layout'] == 'full_frame'
                         else 'one person on screen')
    return merged


# ---------------------------------------------------------------- crops

def segment_face_h(track: dict, start_ms: int, end_ms: int, height: int) -> float:
    """
    The face height (source pixels) to size a window for one segment: the
    median over the track's samples inside the segment — a person is close in
    their solo shot and small in the group shot, and one track can span both.
    Falls back to the track's clip-wide mean.
    """
    hs = sorted(p[4] for p in track['frames'] if start_ms <= p[0] <= end_ms and p[4] > 0)
    if not hs:
        return float(track.get('mean_face_h', 0.0)) * height
    return float(hs[len(hs) // 2])


def crop_size(layout: str, panel: str, width: int, height: int, out_w: int, out_h: int, face_h: float) -> tuple[int, int]:
    """
    The (w, h) of the source window a panel shows. Solo vertical: the full
    source height at the output aspect (or tighter when the face is small so
    the person is not lost in a wide shot). Panels of a stacked layout use the
    panel's aspect. Never larger than the source.
    """
    if layout == 'stacked_two':
        aspect = out_w / (out_h / 2)
    elif layout == 'side_by_side':
        aspect = (out_w / 2) / out_h
    elif layout == 'screen_share':
        aspect = out_w / (out_h * 0.42)
    else:
        aspect = out_w / out_h
    h = float(height)
    # size the window from the face: a solo vertical window is at most ~5 face
    # heights tall (the full source height for anyone close to the camera); a
    # panel of a stacked layout is a head-and-shoulders shot of ~3.5 face
    # heights, so neighbours in a group shot do not end up in both panels.
    # Never tighter than 45% of the source height (upscaling limits).
    if face_h > 0:
        heads = 3.5 if layout in ('stacked_two', 'side_by_side', 'screen_share') else 5.0
        h = min(h, max(face_h * heads, height * 0.45))
    w = h * aspect
    if w > width:
        w = float(width)
        h = w / aspect
    return int(w) // 2 * 2, int(h) // 2 * 2


def crop_path(track: dict, start_ms: int, end_ms: int, win_w: int, win_h: int, width: int, height: int,
              sample_ms: int = SAMPLE_MS, pan_cap: float = MAX_PAN_PER_S) -> list[list[int]]:
    """
    Keyframes [t_ms, x, y] (window top-left in source pixels) for one subject
    across a segment: the face centre exponentially smoothed with a dead zone
    and a speed limit, headroom rule applied, clamped to the frame.
    """
    pts = [p for p in track['frames'] if start_ms - sample_ms <= p[0] <= end_ms + sample_ms]
    if not pts:
        pts = [_at(track, start_ms, 10 ** 9) or track['frames'][0]]
    max_step = pan_cap * win_w * sample_ms / 1000
    # a window barely wider than the face has no room for a dead zone: track closely
    face_w = sum(p[3] for p in pts) / len(pts)
    slack = max(0.0, win_w - face_w * (1 + 2 * FACE_MARGIN))
    dead = min(DEAD_ZONE * win_w, slack / 4)
    path: list[list[int]] = []
    sx = sy = None
    t = start_ms
    while t <= end_ms:
        p = _at(track, t) or min(pts, key=lambda q: abs(q[0] - t))
        fx, fy = p[1] + p[3] / 2, p[2] + p[4] / 2
        if sx is None:
            sx, sy = fx, fy
        else:
            if abs(fx - sx) > dead:
                sx += SMOOTH_ALPHA * (fx - sx)
            if abs(fy - sy) > dead:
                sy += SMOOTH_ALPHA * (fy - sy)
            if path:
                px, py = path[-1][1] + win_w / 2, path[-1][2] + win_h * FACE_HEADROOM
                sx = px + max(-max_step, min(max_step, sx - px))
                sy = py + max(-max_step, min(max_step, sy - py))
        x = sx - win_w / 2
        y = sy - win_h * FACE_HEADROOM
        x = max(0.0, min(width - win_w, x))
        y = max(0.0, min(height - win_h, y))
        path.append([int(t), int(round(x)), int(round(y))])
        t += sample_ms
    if path[-1][0] < end_ms:
        path.append([int(end_ms), path[-1][1], path[-1][2]])
    return path


def face_safe(track: dict, path: list[list[int]], win_w: int, win_h: int,
              width: int | None = None, height: int | None = None) -> tuple[int, int]:
    """
    (samples where the face is cut or crowds the window edge, samples checked).
    The check margin is a share of the face height, but never more than the
    window can give, and the face box is clipped to the source first: a head
    the camera itself cut off is not something a crop can restore.
    """
    violations = checked = 0
    for t, x, y in path:
        p = _at(track, t)
        if not p:
            continue
        checked += 1
        fx, fy, fw, fh = p[1], p[2], p[3], p[4]
        if width and height:
            fx2, fy2 = min(width, fx + fw), min(height, fy + fh)
            fx, fy = max(0.0, fx), max(0.0, fy)
            fw, fh = max(0.0, fx2 - fx), max(0.0, fy2 - fy)
        mx = min(CHECK_MARGIN * p[4], max(0.0, (win_w - fw) / 2 - 1))
        my = min(CHECK_MARGIN * p[4], max(0.0, (win_h - fh) / 2 - 1))
        # no margin is owed on a side where the window already sits on the
        # source edge — the crop cannot move further, and a head the camera
        # cut at the top of the picture stays cut in every framing
        need_l = mx if x > 0 else 0.0
        need_t = my if y > 0 else 0.0
        need_r = mx if (width is None or x + win_w < width) else 0.0
        need_b = my if (height is None or y + win_h < height) else 0.0
        if fx - need_l < x or fy - need_t < y or fx + fw + need_r > x + win_w or fy + fh + need_b > y + win_h:
            violations += 1
    return violations, checked


def build_layout(
    frames: list[dict],
    words: list[dict],
    total_ms: int,
    *,
    width: int,
    height: int,
    out_w: int = 1080,
    out_h: int = 1920,
    mode: str = 'auto',
    subject: str | None = None,
    focus: dict | None = None,
    sample_ms: int = SAMPLE_MS,
    dwell_ms: int = DWELL_MS,
    pan_cap: float = MAX_PAN_PER_S,
) -> dict:
    """The complete layout plan for one clip (see the module docstring)."""
    tracks = build_tracks(frames, width, height, sample_ms)
    act = activity(tracks, total_ms)
    speech = speech_bins(words, total_ms)
    per_bin = speaker_per_bin(tracks, act, speech)
    speaking = smooth_speakers(per_bin)
    segments = plan_segments(tracks, speaking, total_ms, width=width, height=height, mode=mode, subject=subject,
                             dwell_ms=dwell_ms)
    by_id = {t['id']: t for t in tracks}

    paths: list[dict] = []
    violations = checked = 0
    max_pan = 0.0
    for i, seg in enumerate(segments):
        if seg['layout'] == 'fixed_crop':
            f = focus or {'x': 0.25, 'y': 0.0, 'w': 0.5, 'h': 1.0}
            paths.append({'segment': i, 'subject': None, 'w': int(f['w'] * width), 'h': int(f['h'] * height),
                          'keyframes': [[seg['start_ms'], int(f['x'] * width), int(f['y'] * height)]]})
            continue
        for k, sid in enumerate(seg['subjects']):
            track = by_id.get(sid)
            if not track:
                continue
            panel = 'a' if k == 0 else 'b'
            win_w, win_h = crop_size(seg['layout'], panel, width, height, out_w, out_h,
                                     segment_face_h(track, seg['start_ms'], seg['end_ms'], height))
            path = crop_path(track, seg['start_ms'], seg['end_ms'], win_w, win_h, width, height, sample_ms, pan_cap)
            v, c = face_safe(track, path, win_w, win_h, width, height)
            if c and v / c > 0.2 and (win_w < width and win_h < height):
                # too tight for this person's movement: zoom out one step (same aspect) and re-check
                factor = min(1.35, width / win_w, height / win_h)
                win_w, win_h = int(win_w * factor) // 2 * 2, int(win_h * factor) // 2 * 2
                path = crop_path(track, seg['start_ms'], seg['end_ms'], win_w, win_h, width, height, sample_ms, pan_cap)
                v, c = face_safe(track, path, win_w, win_h, width, height)
            violations += v
            checked += c
            for a, b in zip(path, path[1:]):
                dt = max(1, b[0] - a[0]) / 1000
                max_pan = max(max_pan, math.hypot(b[1] - a[1], b[2] - a[2]) / dt / max(1, win_w))
            paths.append({'segment': i, 'subject': sid, 'panel': panel, 'w': win_w, 'h': win_h, 'keyframes': path})

    visible_ms = 0
    for s in speaking:
        for seg in segments:
            overlap = min(s['end_ms'], seg['end_ms']) - max(s['start_ms'], seg['start_ms'])
            if overlap > 0 and (s['track'] in seg['subjects'] or seg['layout'] in ('full_frame', 'original', 'fixed_crop', 'screen_share')):
                visible_ms += overlap
    spoken_ms = sum(s['end_ms'] - s['start_ms'] for s in speaking)
    detected_frames = sum(1 for f in frames if f.get('faces'))
    metrics = {
        'people': len(tracks),
        'frames_sampled': len(frames),
        'faces_detected_pct': round(100 * detected_frames / len(frames)) if frames else 0,
        'speaker_visible_pct': round(100 * visible_ms / spoken_ms) if spoken_ms else None,
        'speaking_confident_pct': round(100 * spoken_ms / max(1, total_ms)),
        'layout_changes': max(0, len(segments) - 1),
        'max_pan_widths_per_s': round(max_pan, 2),
        'face_cut_violations': violations,
        'face_checks': checked,
        'smooth': max_pan <= pan_cap + 1e-6,
    }
    return {
        'schema_version': 1,
        'mode': mode,
        'subject_override': subject if subject in by_id else None,
        'sample_ms': sample_ms,
        'source': {'width': width, 'height': height},
        'canvas': {'width': out_w, 'height': out_h},
        'tracks': [{k: t[k] for k in ('id', 'coverage', 'span_ms', 'first_ms', 'last_ms', 'best_ms', 'mean_center', 'mean_face_h')} | {'frames': t['frames']}
                   for t in tracks],
        'activity': act,
        'speaking': speaking,
        'segments': segments,
        'paths': paths,
        'metrics': metrics,
        'method': 'stock pose_estimation keypoints: head-motion jitter gated by word timing (no diarization)',
    }


# ------------------------------------------------------ episode scan

def people_from_samples(frames: list[dict], width: int, height: int, sample_ms: int) -> list[dict]:
    """
    Persistent "people" over a sparsely sampled episode: positions cluster
    (an interview camera setup rarely moves), so faces are grouped by where and
    how big they appear. Honest naming: these are screen positions, not
    identities.
    """
    clusters: list[dict] = []
    diag = math.hypot(width, height)
    for frame in frames:
        t = int(frame['t_ms'])
        for face in frame.get('faces') or []:
            x, y, w, h = _box(face)
            if w <= 0 or h <= 0:
                continue
            cx, cy = x + w / 2, y + h / 2
            best, best_d = None, 0.12 * diag
            for c in clusters:
                d = math.hypot(cx - c['cx'], cy - c['cy']) + 0.5 * abs(h - c['h'])
                if d < best_d:
                    best, best_d = c, d
            if best is None:
                best = {'cx': cx, 'cy': cy, 'h': h, 'w': w, 'n': 0, 'times': [], 'best': (h, t, (x, y, w, h))}
                clusters.append(best)
            n = best['n']
            best['cx'] = (best['cx'] * n + cx) / (n + 1)
            best['cy'] = (best['cy'] * n + cy) / (n + 1)
            best['h'] = (best['h'] * n + h) / (n + 1)
            best['w'] = (best['w'] * n + w) / (n + 1)
            best['n'] = n + 1
            best['times'].append(t)
            if h > best['best'][0]:
                best['best'] = (h, t, (x, y, w, h))
    total = max(1, len(frames))
    people = []
    for c in sorted(clusters, key=lambda c: -c['n']):
        if c['n'] < 3:
            continue
        spans: list[list[int]] = []
        for t in sorted(c['times']):
            if spans and t - spans[-1][1] <= 2 * sample_ms:
                spans[-1][1] = t + sample_ms
            else:
                spans.append([t, t + sample_ms])
        bx, by, bw, bh = c['best'][2]
        people.append({
            'id': f'p{len(people) + 1}',
            'appearances': c['n'],
            'coverage': round(min(1.0, len(set(c['times'])) / total), 3),
            'center': [round(c['cx'] / width, 4), round(c['cy'] / height, 4)],
            'face_h': round(c['h'] / height, 4),
            # tiny faces are usually people in the background or on a shared screen
            'small': c['h'] / height < 0.06,
            'best_ms': c['best'][1],
            'best_box': [int(bx), int(by), int(bw), int(bh)],
            'timeline': spans,
        })
    return people
