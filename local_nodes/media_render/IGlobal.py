from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

from .plan import DEFAULTS


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'media_render')

    def endGlobal(self):
        pass
