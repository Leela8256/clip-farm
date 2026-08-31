from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

DEFAULTS = {'min_seconds': 20, 'max_seconds': 90, 'per_chunk': 4, 'chunk_minutes': 10, 'overlap_seconds': 45,
            'passage_seconds': 60, 'passage_step_seconds': 30}


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'podcast_segment')

    def endGlobal(self):
        pass
