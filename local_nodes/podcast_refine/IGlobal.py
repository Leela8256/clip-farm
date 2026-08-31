from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

DEFAULTS = {'candidates': 10, 'min_seconds': 20, 'max_seconds': 90, 'target_seconds': 45}


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'podcast_refine')

    def endGlobal(self):
        pass
