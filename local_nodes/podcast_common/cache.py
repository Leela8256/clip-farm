"""
Local read cache for source recordings. Every clip job needs the episode's
source file; instead of pulling the whole recording out of the account store
each time, nodes share one on-disk copy keyed by store path + size + mtime.
The cache lives in the engine's temp dir and is pruned to a few files.
"""

from __future__ import annotations
import hashlib
import os
import tempfile
import threading
from pathlib import Path

from .store import _run, download_to

CACHE_DIR = Path(os.environ.get('PODCAST_CACHE_DIR') or (Path(tempfile.gettempdir()) / 'podcast_cache'))
MAX_FILES = int(os.environ.get('PODCAST_CACHE_FILES', '8'))

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def local_source(store, path: str) -> Path:
    info = _run(store.stat(path)) or {}
    if isinstance(info, dict) and info.get('exists') is False:
        raise FileNotFoundError(f'not in the account store: {path}')
    size = int(info.get('size') or 0) if isinstance(info, dict) else 0
    modified = info.get('modified') if isinstance(info, dict) else None
    key = hashlib.sha1(f'{path}|{size}|{modified}'.encode('utf-8')).hexdigest()[:16]
    local = CACHE_DIR / f'{key}{Path(path).suffix.lower() or ".bin"}'

    with _lock_for(key):
        if local.exists() and (size == 0 or local.stat().st_size == size):
            os.utime(local, None)
            return local
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        part = local.with_name(local.name + '.part')
        download_to(store, path, part)
        os.replace(part, local)
    _prune()
    return local


def _prune() -> None:
    try:
        files = [p for p in CACHE_DIR.iterdir() if p.is_file() and not p.name.endswith('.part')]
        files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[MAX_FILES:]:
            old.unlink(missing_ok=True)
    except OSError:
        pass
