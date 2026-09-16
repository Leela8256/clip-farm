"""
Compatibility shim: the ffmpeg / PyAV library now lives inside the generic
`media_render` node (`local_nodes/media_render/render_lib.py`), where it can
be copied upstream with the node it belongs to.

Everything that used to be defined here is re-exported unchanged, so the CLI,
the tests and the app-side nodes keep importing one name
(`local_nodes.podcast_common.media`). New code inside a node should import
`local_nodes.media_render.render_lib` directly.
"""

from __future__ import annotations

from local_nodes.media_render import render_lib as _render_lib
from local_nodes.media_render.render_lib import *  # noqa: F401,F403

# the private helpers too (`_audio_graph`, `_loudnorm_stats`, `_interp`, …):
# a shim that only forwards the public half is a trap for the next reader.
globals().update({k: v for k, v in vars(_render_lib).items() if not k.startswith('__')})
