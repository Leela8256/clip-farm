"""Node configuration loading shared by the podcast_* IGlobal classes."""

from __future__ import annotations

from rocketlib import warning

try:
    from rocketlib import OPEN_MODE
except ImportError:  # older engine builds
    OPEN_MODE = None


def as_bool(value, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def load_node_config(iglobal, defaults: dict, name: str) -> dict:
    """Profile values from the pipeline config layered over the node's defaults (typed like the defaults)."""
    config = dict(defaults)
    try:
        if OPEN_MODE is not None and iglobal.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return config
    except Exception:  # noqa: BLE001
        pass
    try:
        from ai.common.config import Config

        cfg = Config.getNodeConfig(iglobal.glb.logicalType, iglobal.glb.connConfig) or {}
    except Exception as exc:  # noqa: BLE001
        warning(f'{name}: using default config: {exc}')
        return config
    for key, default in defaults.items():
        value = cfg.get(key)
        if value in (None, ''):
            continue
        if isinstance(default, bool):
            config[key] = as_bool(value, default)
        elif isinstance(default, int):
            try:
                config[key] = int(float(value))
            except (TypeError, ValueError):
                pass
        elif isinstance(default, float):
            try:
                config[key] = float(value)
            except (TypeError, ValueError):
                pass
        else:
            config[key] = value
    return config
