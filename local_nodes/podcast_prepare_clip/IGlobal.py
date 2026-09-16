from __future__ import annotations

from rocketlib import IGlobalBase

from local_nodes.podcast_common.config import load_node_config

DEFAULTS = {
    'model': 'medium',
    'language': 'en',
    'pad_seconds': 2,
    'filler_policy': 'smart',
    'silence_policy': 'tighten',
    'caption_preset': 'classic',
    'level_check': True,
    # whole-episode editing studio
    'studio_piece_seconds': 60,
    'studio_model': '',
    # what the render this plan feeds is asked to produce. media_render is generic:
    # the deliverables (and their encode) are part of the spec this node emits, so
    # the preview/export difference lives here now instead of in the renderer.
    'render_mode': 'preview',
    'size': 960,
    'layouts': 'vertical',
    'fps': 30,
    'crf': 28,
    'preset': 'ultrafast',
    'captions': True,
    'sidecars': False,
    # legacy booleans (schema 1 pipes); mapped onto the policies when the new keys are absent
    'tighten_pauses': True,
    'remove_fillers': True,
}


class IGlobal(IGlobalBase):
    config: dict

    def beginGlobal(self):
        self.config = load_node_config(self, DEFAULTS, 'podcast_prepare_clip')
        cfg = self.config
        if not cfg.get('tighten_pauses', True):
            cfg['silence_policy'] = 'keep'
        if not cfg.get('remove_fillers', True):
            cfg['filler_policy'] = 'keep'

    def endGlobal(self):
        pass
