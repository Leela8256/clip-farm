from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

from .media_lib import DETECT_FPS, DETECT_WIDTH, clamp_piece_seconds

# `mode: auto` follows the wiring: an audio listener wants transcriber pieces, a
# video listener wants the small detection copy, anything else just probes.
DEFAULTS = {'mode': 'auto', 'chunk_kb': 1024, 'piece_seconds': 45,
            'detect_width': DETECT_WIDTH, 'detect_fps': DETECT_FPS}


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'media_io')
        cfg = self.config
        cfg['chunk_bytes'] = max(64, int(cfg['chunk_kb'])) * 1024
        cfg['piece_seconds'] = clamp_piece_seconds(cfg['piece_seconds'])
        cfg['detect_width'] = max(64, int(cfg['detect_width'])) // 2 * 2
        cfg['detect_fps'] = max(1, int(cfg['detect_fps']))

    def endGlobal(self):
        pass
