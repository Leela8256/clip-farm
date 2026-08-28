"""
Synchronous wrappers over the engine's account file store for use inside
nodes. The store API is async; nodes run on engine threads without a loop,
so each helper drives its own loop. Store paths are never mapped to disk —
the backend may be local disk or object storage.
"""

from __future__ import annotations
import asyncio
import json
from pathlib import Path
from typing import Any, Iterator

CHUNK = 4 * 1024 * 1024


def get_store():
    """The FileStore bound to the current engine task, or None outside a task."""
    from ai.account.store import Store

    return Store.engine_file_store()


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def read_bytes(store, path: str) -> bytes:
    async def go():
        opened = await store.open_read(path)
        handle, size = opened['handle'], opened.get('size')
        parts, offset = [], 0
        try:
            while True:
                chunk = await store.read_chunk(handle, offset, CHUNK)
                if not chunk:
                    break
                parts.append(chunk)
                offset += len(chunk)
                if isinstance(size, int) and offset >= size:
                    break
        finally:
            await store.close_read(handle)
        return b''.join(parts)

    return _run(go())


def read_json(store, path: str) -> Any:
    return json.loads(read_bytes(store, path).decode('utf-8'))


def write_bytes(store, path: str, data: bytes) -> None:
    async def go():
        handle = await store.open_write(path)
        try:
            for i in range(0, len(data), CHUNK):
                await store.write_chunk(handle, data[i : i + CHUNK])
        finally:
            await store.close_write(handle)

    _run(go())


def write_json(store, path: str, obj: Any) -> None:
    write_bytes(store, path, json.dumps(obj, indent=2, default=str).encode('utf-8'))


def write_file(store, path: str, local: str | Path) -> str:
    async def go():
        handle = await store.open_write(path)
        try:
            with open(local, 'rb') as f:
                while True:
                    chunk = f.read(CHUNK)
                    if not chunk:
                        break
                    await store.write_chunk(handle, chunk)
        finally:
            await store.close_write(handle)

    _run(go())
    return path


def download_to(store, path: str, local: str | Path) -> Path:
    local = Path(local)
    local.parent.mkdir(parents=True, exist_ok=True)

    async def go():
        opened = await store.open_read(path)
        handle, size = opened['handle'], opened.get('size')
        offset = 0
        try:
            with open(local, 'wb') as out:
                while True:
                    chunk = await store.read_chunk(handle, offset, CHUNK)
                    if not chunk:
                        break
                    out.write(chunk)
                    offset += len(chunk)
                    if isinstance(size, int) and offset >= size:
                        break
        finally:
            await store.close_read(handle)

    _run(go())
    return local


def stream_chunks(store, path: str, chunk_size: int = 1024 * 1024) -> Iterator[bytes]:
    """Yield a store file in chunks without holding it in memory."""
    loop = asyncio.new_event_loop()
    try:
        opened = loop.run_until_complete(store.open_read(path))
        handle, size = opened['handle'], opened.get('size')
        offset = 0
        try:
            while True:
                chunk = loop.run_until_complete(store.read_chunk(handle, offset, chunk_size))
                if not chunk:
                    break
                yield chunk
                offset += len(chunk)
                if isinstance(size, int) and offset >= size:
                    break
        finally:
            loop.run_until_complete(store.close_read(handle))
    finally:
        loop.close()


def exists(store, path: str) -> bool:
    """stat() may raise OR return a descriptor for a missing path — treat both as absent."""
    try:
        info = _run(store.stat(path))
    except Exception:  # noqa: BLE001
        return False
    if not isinstance(info, dict):
        return bool(info)
    if 'exists' in info:
        return bool(info['exists'])
    return info.get('type') in ('file', 'dir', 'directory') or 'size' in info


def list_dir(store, path: str) -> list[dict]:
    try:
        return list((_run(store.list_dir(path)) or {}).get('entries', []))
    except Exception:  # noqa: BLE001
        return []
