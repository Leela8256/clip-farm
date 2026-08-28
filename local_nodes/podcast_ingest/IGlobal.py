from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

# The stock transcriber flushes its buffer every 60 s of audio and stamps sentences
# relative to that buffer, so pieces must stay below 60 s to be one buffer each.
DEFAULTS = {'chunk_kb': 1024, 'piece_seconds': 45}


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'podcast_ingest')
        self.config['chunk_bytes'] = max(64, int(self.config['chunk_kb'])) * 1024
        self.config['piece_seconds'] = max(10, min(58, int(self.config['piece_seconds'])))

    def endGlobal(self):
        pass
