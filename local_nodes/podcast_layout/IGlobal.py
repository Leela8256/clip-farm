from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

DEFAULTS = {'mode': 'auto', 'sample_ms': 200, 'detect_width': 640, 'canvas_width': 1080, 'canvas_height': 1920}


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'podcast_layout')

    def endGlobal(self):
        pass
