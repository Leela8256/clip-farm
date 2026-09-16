from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

# Every key here is also accepted per run in the question context and in the
# `framing` block of the JSON on the text lane (see IInstance.DEFAULTS).
DEFAULTS = {
    'mode': 'plan',                 # plan (one clip) | scan (a whole recording)
    'layout': 'auto',               # forced layout, 'auto' decides per moment
    'sample_ms': 200,               # interval the frames were sampled at
    'detect_width': 640,            # width the detections were made at (0 = source pixels)
    'canvas_width': 1080,           # the shape the crop windows are planned for
    'canvas_height': 1920,
    'dwell_ms': 2000,               # a layout holds at least this long
    'pan_cap': 0.5,                 # crop widths per second
    'scenes': True,                 # scan: detect shot changes
    'scene_threshold': 0.35,
}


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'speaker_framing')

    def endGlobal(self):
        pass
