from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

DEFAULTS = {'model': 'small', 'language': 'en', 'pad_seconds': 2.0, 'tighten_pauses': True, 'remove_fillers': True}


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'podcast_prepare_clip')

    def endGlobal(self):
        pass
