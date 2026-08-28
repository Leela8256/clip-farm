from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

DEFAULTS = {'mode': 'preview', 'size': 960, 'layouts': 'vertical', 'fps': 30, 'crf': 28, 'preset': 'ultrafast',
            'captions': True, 'sidecars': False}


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'podcast_render')

    def endGlobal(self):
        pass
