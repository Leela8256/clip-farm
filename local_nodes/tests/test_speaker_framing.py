"""
The speaker_framing node's contract — no engine, no ffmpeg, no app fixtures:
synthetic detections and a synthetic spec through the real node class, with a
fake store and a fake instance standing in for the engine.

    python3 -m unittest discover -s local_nodes/tests -v

The framing numbers themselves are locked by test_visual.py (the math library
the node calls); the equivalence test below ties the node to them.
"""

from __future__ import annotations
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


# ---------------------------------------------------------------- engine stubs

def _stub(name: str, **attrs) -> types.ModuleType:
    module = sys.modules.get(name)
    if module is None:
        module = types.ModuleType(name)
        sys.modules[name] = module
    for key, value in attrs.items():
        if not hasattr(module, key):
            setattr(module, key, value)
    return module


class _Answer:
    def __init__(self, expectJson: bool = False):  # noqa: N803 — engine spelling
        self.expectJson = expectJson
        self.payload = None

    def setAnswer(self, payload):  # noqa: N802 — engine spelling
        self.payload = payload


try:  # the engine ships these; outside it, stand them in
    import rocketlib  # noqa: F401
except ImportError:
    _stub('rocketlib', IInstanceBase=object, IGlobalBase=object, Entry=object,
          warning=lambda *a, **k: None, debug=lambda *a, **k: None)
try:
    from ai.common.schema import Answer  # noqa: F401
except ImportError:
    _stub('ai')
    _stub('ai.common')
    _stub('ai.common.schema', Answer=_Answer, Question=object)

from importlib import import_module  # noqa: E402

from local_nodes.podcast_common.visual import build_layout, faces_from_persons  # noqa: E402

instance_module = import_module('local_nodes.speaker_framing.IInstance')
IInstance = instance_module.IInstance

W, H = 1280, 720
DETECT = 640            # the detections are made on a 640 px copy


# ------------------------------------------------------------- fake engine

class FakeStore:
    """The account file store's async surface, in memory."""

    def __init__(self):
        self.files: dict[str, bytes] = {}

    async def open_write(self, path):
        self.files[path] = b''
        return path

    async def write_chunk(self, handle, chunk):
        self.files[handle] += chunk

    async def close_write(self, handle):
        return None

    async def open_read(self, path):
        if path not in self.files:
            raise FileNotFoundError(path)
        return {'handle': path, 'size': len(self.files[path])}

    async def read_chunk(self, handle, offset, size):
        return self.files[handle][offset:offset + size]

    async def close_read(self, handle):
        return None

    def json(self, path):
        return json.loads(self.files[path].decode('utf-8'))

    def put_json(self, path, obj):
        self.files[path] = json.dumps(obj).encode('utf-8')


class FakeInstance:
    pipeId = None

    def __init__(self, lanes=('text', 'answers')):
        self.lanes = set(lanes)
        self.text: list[str] = []
        self.answers: list[object] = []

    def hasListener(self, lane):  # noqa: N802 — engine spelling
        return lane in self.lanes

    def writeText(self, text):  # noqa: N802
        self.text.append(text)

    def writeAnswers(self, answer):  # noqa: N802
        self.answers.append(answer)


def question(*lines):
    return types.SimpleNamespace(context=['\n'.join(lines)], questions=[])


PLAN_CONFIG = {'mode': 'plan', 'layout': 'auto', 'sample_ms': 200, 'detect_width': DETECT,
               'canvas_width': 1080, 'canvas_height': 1920, 'dwell_ms': 2000, 'pan_cap': 0.5,
               'scenes': False, 'scene_threshold': 0.35}
SCAN_CONFIG = {'mode': 'scan', 'layout': 'auto', 'sample_ms': 2000, 'detect_width': 0,
               'canvas_width': 1080, 'canvas_height': 1920, 'dwell_ms': 2000, 'pan_cap': 0.5,
               'scenes': True, 'scene_threshold': 0.35}


def run_node(config, *, spec=None, context=(), detections=(), table=None, lanes=('text', 'answers'), store=None):
    """Drive one object through the node exactly as the engine would."""
    store = store if store is not None else FakeStore()
    node = IInstance()
    node.IGlobal = types.SimpleNamespace(config=dict(config))
    node.instance = FakeInstance(lanes)
    original = instance_module.get_store
    instance_module.get_store = lambda: store
    try:
        node.beginInstance()
        node.open(None)
        if context:
            node.writeQuestions(question(*context))
        if spec is not None:
            node.writeText(json.dumps(spec))
        for persons in detections:
            node.writeText(json.dumps(persons))
        if table is not None:
            node.writeTable(table)
        node.closing()
    finally:
        instance_module.get_store = original
    return node, store


# --------------------------------------------------------------- detections

def face(x, y, w, h, mouth_dy=0.55, mouth_dx=0.0):
    """A detection dict in the detector's own pixels (as face_detection emits)."""
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


def talking(t_ms, period=400):
    return 0.5 + (0.12 if (t_ms // period) % 2 else -0.12)


def detections(seconds, faces_at, sample_ms=200):
    return [faces_at(t) for t in range(0, int(seconds * 1000), sample_ms)]


def two_people(t):
    """Detector pixels on the 640 px copy — half of the 1280 px source."""
    return [face(100, 100, 80, 100, mouth_dy=talking(t)), face(450, 110, 75, 95)]


def frame_table(times_s):
    rows = ['| Frame | Seconds | Time Stamp |', '| --- | --- | --- |']
    rows += [f'| {i} | {t} | 00:00:00 |' for i, t in enumerate(times_s)]
    return '\n'.join(rows)


SPEC = {'source': 'media/talk.mp4', 'keep': [[0, 10_000]],
        'framing': {'duration_ms': 10_000, 'width': W, 'height': H,
                    'write_to': 'out/clip', 'status_to': 'out/status.json'}}
WORDS = [{'start_ms': i * 500, 'end_ms': i * 500 + 400} for i in range(20)]


class PlanModeTests(unittest.TestCase):
    def test_plan_is_written_and_merged_into_the_incoming_json(self):
        spec = {**SPEC, 'framing': {**SPEC['framing'], 'words': WORDS, 'echo': {'clip_id': 'c01'}}}
        node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(10, two_people))

        self.assertEqual(sorted(store.files), ['out/clip/layout.json', 'out/status.json'])
        plan = store.json('out/clip/layout.json')
        self.assertEqual(plan['schema_version'], 1)
        self.assertEqual(plan['metrics']['people'], 2)
        self.assertEqual(plan['source'], {'width': W, 'height': H})
        self.assertEqual(plan['canvas'], {'width': 1080, 'height': 1920})
        self.assertEqual(plan['clip_id'], 'c01')             # echo is stamped into the file
        self.assertEqual(plan['thumbnails'], {})             # no thumbnails_to → none made
        self.assertTrue(plan['paths'] and plan['segments'])

        # the caller's JSON goes on unchanged, with the plan merged in
        self.assertEqual(len(node.instance.text), 1)
        forwarded = json.loads(node.instance.text[0])
        self.assertEqual(forwarded['source'], 'media/talk.mp4')
        self.assertEqual(forwarded['keep'], [[0, 10_000]])
        self.assertEqual(forwarded['framing_plan'], plan)

    def test_the_plan_is_the_math_library_verbatim(self):
        """The node adds paths, thumbnails and timing — never different geometry."""
        spec = {**SPEC, 'framing': {**SPEC['framing'], 'words': WORDS}}
        _node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(10, two_people))
        plan = store.json('out/clip/layout.json')

        frames = [{'t_ms': i * 200, 'faces': [{**f, 'box': {k: v * 2.0 for k, v in f['box'].items()},
                                               'landmarks': [{**kp, 'x': kp['x'] * 2.0, 'y': kp['y'] * 2.0} for kp in f['landmarks']]}
                                              for f in faces_from_persons(two_people(i * 200))]}
                  for i in range(50)]
        direct = json.loads(json.dumps(build_layout(frames, WORDS, 10_000, width=W, height=H,
                                                    out_w=1080, out_h=1920, sample_ms=200)))
        self.assertEqual({k: v for k, v in plan.items() if k not in ('thumbnails', 'seconds')}, direct)

    def test_detections_are_scaled_from_the_detector_copy_to_source_pixels(self):
        spec = {**SPEC, 'framing': {**SPEC['framing'], 'write_to': 'out/clip'}}
        _node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(6, two_people))
        scaled = store.json('out/clip/layout.json')
        _node, store2 = run_node({**PLAN_CONFIG, 'detect_width': 0}, spec=spec, detections=detections(6, two_people))
        unscaled = store2.json('out/clip/layout.json')
        # 640 px detections on a 1280 px source: every box doubles
        self.assertEqual(scaled['tracks'][0]['frames'][0][1], 2 * unscaled['tracks'][0]['frames'][0][1])
        self.assertAlmostEqual(scaled['tracks'][0]['mean_face_h'], 2 * unscaled['tracks'][0]['mean_face_h'], places=3)
        self.assertEqual(scaled['tracks'][0]['mean_center'], [0.2188, 0.4167])   # (200+360)/2/1280, (200+400)/2/720

    def test_frame_times_come_from_the_table_when_it_lines_up(self):
        spec = {**SPEC, 'framing': {**SPEC['framing'], 'duration_ms': 2000}}
        times = [0.0, 0.25, 0.5, 0.9, 1.2]
        _node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(1, two_people),
                                table=frame_table(times))
        self.assertEqual([p[0] for p in store.json('out/clip/layout.json')['tracks'][0]['frames']],
                         [0, 250, 500, 900, 1200])
        # a table that does not line up is ignored in favour of the sample interval
        _node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(1, two_people),
                                table=frame_table([0.0, 0.25]))
        self.assertEqual([p[0] for p in store.json('out/clip/layout.json')['tracks'][0]['frames']],
                         [0, 200, 400, 600, 800])

    def test_aspect_chooses_the_canvas(self):
        for aspect, canvas in (('4:5', {'width': 1080, 'height': 1350}),
                               ('1:1', {'width': 1080, 'height': 1080}),
                               ('16:9', {'width': 1920, 'height': 1080})):
            spec = {**SPEC, 'framing': {**SPEC['framing'], 'aspect': aspect}}
            _node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(6, two_people))
            self.assertEqual(store.json('out/clip/layout.json')['canvas'], canvas, aspect)

    def test_settings_precedence_and_echo(self):
        spec = {**SPEC, 'framing': {**SPEC['framing'], 'layout': 'full_frame', 'echo': {'clip_id': 'c07'}}}
        node, store = run_node(PLAN_CONFIG, spec=spec, context=('layout: solo_follow', 'echo.run: r3'),
                               detections=detections(6, two_people))
        plan = store.json('out/clip/layout.json')
        self.assertEqual(plan['mode'], 'full_frame')                 # the framing block wins
        self.assertEqual(plan['segments'][0]['layout'], 'full_frame')
        self.assertEqual((plan['clip_id'], plan['run']), ('c07', 'r3'))
        status = store.json('out/status.json')
        self.assertEqual((status['node'], status['stage'], status['run']), ('speaker_framing', 'planned', 'r3'))

    def test_context_only_wiring_without_a_framing_block(self):
        node, store = run_node(PLAN_CONFIG, spec={'source': 'media/talk.mp4'},
                               context=('mode: plan', 'width: 1280', 'height: 720', 'duration_ms: 6000',
                                        'write_to: out/one.json', 'subject: p2'),
                               detections=detections(6, two_people))
        plan = store.json('out/one.json')                            # a .json write_to is used as given
        self.assertEqual(plan['subject_override'], 'p2')
        self.assertEqual(plan['segments'][0]['subjects'], ['p2'])
        self.assertEqual(json.loads(node.instance.text[0])['framing_plan']['metrics']['people'], 2)

    def test_words_are_read_from_a_store_path(self):
        store = FakeStore()
        store.put_json('out/words.json', {'words': [{'s': 0, 'e': 6000}]})
        spec = {**SPEC, 'framing': {**SPEC['framing'], 'words': 'out/words.json', 'duration_ms': 6000}}
        _node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(6, two_people), store=store)
        plan = store.json('out/clip/layout.json')
        self.assertTrue(plan['speaking'])                            # the talking gate saw speech
        self.assertEqual(plan['speaking'][0]['track'], 'p1')

    def test_tunables_reach_the_planner(self):
        spec = {**SPEC, 'framing': {**SPEC['framing'], 'duration_ms': 20_000, 'dwell_ms': 6000}}
        def people(t):
            out = [face(100, 100, 80, 100, mouth_dy=talking(t))]
            if (t // 1000) % 2 == 0:
                out.append(face(450, 110, 75, 95))
            return out

        _node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(20, people))
        segments = store.json('out/clip/layout.json')['segments']
        self.assertTrue(all(s['end_ms'] - s['start_ms'] >= 6000 for s in segments),
                        [(s['start_ms'], s['end_ms']) for s in segments])

    def test_audio_only_and_no_detections_pass_through(self):
        spec = {**SPEC, 'framing': {**SPEC['framing'], 'has_video': False}}
        node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(6, two_people))
        plan = json.loads(node.instance.text[0])['framing_plan']
        self.assertEqual(plan['segments'], [{'start_ms': 0, 'end_ms': 10_000, 'layout': 'full_frame',
                                             'subjects': [], 'reason': 'audio-only recording'}])
        self.assertEqual(plan['method'], 'no detection')
        self.assertNotIn('out/clip/layout.json', store.files)        # a pass-through is not persisted

        node, store = run_node(PLAN_CONFIG, spec=SPEC, detections=[])
        plan = json.loads(node.instance.text[0])['framing_plan']
        self.assertEqual(plan['segments'][0]['reason'], 'no frames reached the face detector')
        self.assertEqual(plan['metrics'], {'people': 0, 'frames_sampled': 0, 'faces_detected_pct': 0, 'layout_changes': 0})

    def test_no_write_to_and_no_status_to_write_nothing(self):
        spec = {'source': 'media/talk.mp4', 'framing': {'duration_ms': 6000, 'width': W, 'height': H}}
        node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(6, two_people))
        self.assertEqual(store.files, {})
        self.assertEqual(json.loads(node.instance.text[0])['framing_plan']['metrics']['people'], 2)

    def test_the_answers_lane_carries_a_summary(self):
        spec = {**SPEC, 'framing': {**SPEC['framing'], 'echo': {'clip_id': 'c01'}}}
        node, _store = run_node(PLAN_CONFIG, spec=spec, detections=detections(6, two_people))
        payload = node.instance.answers[0].payload
        self.assertEqual((payload['clip_id'], payload['mode'], payload['people']), ('c01', 'plan', 2))
        self.assertEqual(payload['plan'], 'out/clip/layout.json')

    def test_a_failure_leaves_a_full_frame_plan_and_an_error(self):
        spec = {**SPEC, 'framing': {**SPEC['framing'], 'focus': 'not a box', 'layout': 'fixed_crop'}}
        node, store = run_node(PLAN_CONFIG, spec=spec, detections=detections(6, two_people))
        plan = json.loads(node.instance.text[0])['framing_plan']
        # a bad focus is ignored (the planner's own default box is used), so the
        # plan still comes out — the error path is exercised by a broken canvas
        self.assertEqual(plan['segments'][0]['layout'], 'fixed_crop')
        node, store = run_node({**PLAN_CONFIG, 'canvas_height': 0}, spec=SPEC, detections=detections(6, two_people))
        plan = json.loads(node.instance.text[0])['framing_plan']
        self.assertIn('error', plan)
        self.assertEqual(plan['segments'][0]['layout'], 'full_frame')
        self.assertEqual(store.json('out/status.json')['stage'], 'error')


class LifecycleTests(unittest.TestCase):
    def test_a_detector_that_wraps_its_persons_in_an_object(self):
        frames = [{'persons': two_people(t)} for t in range(0, 6000, 200)]
        node, store = run_node(PLAN_CONFIG, spec=SPEC, detections=frames)
        self.assertEqual(store.json('out/clip/layout.json')['metrics']['people'], 2)
        self.assertEqual(json.loads(node.instance.text[0])['source'], 'media/talk.mp4')

    def test_a_second_object_starts_from_scratch(self):
        store = FakeStore()
        node = IInstance()
        node.IGlobal = types.SimpleNamespace(config=dict(PLAN_CONFIG))
        node.instance = FakeInstance()
        original = instance_module.get_store
        instance_module.get_store = lambda: store
        try:
            node.beginInstance()
            node.open(None)
            node.writeQuestions(question('echo.run: r1'))
            node.writeText(json.dumps(SPEC))
            for persons in detections(6, two_people):
                node.writeText(json.dumps(persons))
            node.open(None)                      # a second lane of the same run keeps the state
            node.closing()
            first = store.json('out/clip/layout.json')
            node.open(None)                      # ...a new run does not
            node.writeText(json.dumps(SPEC))
            node.closing()
        finally:
            instance_module.get_store = original
        second = json.loads(node.instance.text[1])['framing_plan']
        self.assertEqual(first['metrics']['people'], 2)
        self.assertEqual(first['run'], 'r1')      # the question outlives its object
        self.assertEqual(second['metrics']['frames_sampled'], 0)
        self.assertEqual(second['segments'][0]['reason'], 'no frames reached the face detector')
        self.assertEqual(store.json('out/clip/layout.json'), first)   # a pass-through overwrites nothing


class ScanModeTests(unittest.TestCase):
    def scan(self, **framing):
        def faces(t):
            out = [face(200 + (t % 4000) / 400, 200, 160, 200)]
            if 10_000 <= t < 40_000:
                out.append(face(900, 220, 150, 190))
            return out

        ref = {'source': 'media/talk.mp4',
               'framing': {'width': W, 'height': H, 'duration_ms': 60_000, 'write_to': 'out/visual',
                           'status_to': 'out/status.json', 'echo': {'project': 'library/one', 'episode_id': 'one'},
                           **framing}}
        return run_node(SCAN_CONFIG, spec=ref, detections=detections(60, faces, sample_ms=2000))

    def test_people_and_scenes_are_written_with_the_caller_fields(self):
        node, store = self.scan()
        people = store.json('out/visual/people.json')
        self.assertEqual(people['schema_version'], 1)
        self.assertEqual((people['project'], people['episode_id']), ('library/one', 'one'))
        self.assertEqual((people['sample_ms'], people['frames'], people['faces_detected_pct']), (2000, 30, 100))
        self.assertEqual((people['width'], people['height']), (W, H))
        self.assertEqual([p['id'] for p in people['people']], ['p1', 'p2'])
        self.assertEqual(people['people'][1]['timeline'], [[10_000, 40_000]])
        self.assertEqual(len(people['people'][1]['best_box']), 4)
        self.assertNotIn('thumbnail', people['people'][0])           # no thumbnails_to given

        scenes = store.json('out/visual/scenes.json')
        # no source to decode → no shot detection, one scene over the recording
        self.assertEqual(scenes['cuts_ms'], [])
        self.assertEqual(scenes['scenes'], [{'index': 0, 'start_ms': 0, 'end_ms': 60_000}])
        self.assertEqual(scenes['method'], 'ffmpeg scene score > 0.35')

    def test_the_manifest_reaches_both_lanes(self):
        node, _store = self.scan()
        manifest = node.instance.answers[0].payload
        self.assertEqual(manifest['project'], 'library/one')
        self.assertEqual((manifest['scenes'], manifest['frames']), (1, 30))
        self.assertEqual([p['id'] for p in manifest['people']], ['p1', 'p2'])
        self.assertEqual(json.loads(node.instance.text[0]), manifest)

    def test_progress_uses_the_neutral_node_name_and_the_stages_clients_know(self):
        _node, store = self.scan()
        status = store.json('out/status.json')
        self.assertEqual((status['node'], status['stage']), ('speaker_framing', 'scanned'))
        self.assertEqual((status['people'], status['scenes'], status['frames']), (2, 1, 30))

    def test_a_scan_without_dimensions_reports_no_people_instead_of_failing(self):
        _node, store = self.scan(width=0, height=0)
        self.assertEqual(store.json('out/visual/people.json')['people'], [])
        self.assertEqual(store.json('out/status.json')['stage'], 'scanned')


if __name__ == '__main__':
    unittest.main()
