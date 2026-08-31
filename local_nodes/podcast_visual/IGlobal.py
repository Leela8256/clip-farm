from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

DEFAULTS = {'sample_seconds': 2.0, 'scenes': True, 'scene_threshold': 0.35}


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'podcast_visual')

    def endGlobal(self):
        pass
