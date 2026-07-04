"""
WebSocket job-status push — replaces polling GET /api/tasks/{id}/status.

The frontend opens one socket per job and receives stage/terminal events as
Celery tasks publish them (see workers/events.py). On connect, it also sends
the job's current status from Postgres so a client that connects mid-job
doesn't have to wait for the next event to know where things stand.

Ordering matters: we subscribe to the Redis channel BEFORE reading the
snapshot. Redis pub/sub is fire-and-forget with no replay, so subscribing
after the snapshot read would drop any event a fast task fires in the gap.
Subscribing first means at worst the client sees a stage event slightly
before the snapshot — harmless — instead of missing the terminal event.
"""

from __future__ import annotations
import asyncio
import json

import redis.asyncio as aioredis
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from workers.celery_app import REDIS_URL
from workers.events import CHANNEL_PREFIX
from db.session import get_session
from db.models import Job

router = APIRouter()

_TERMINAL = {"done", "ready", "error"}


def _snapshot(job_id: str) -> dict | None:
    with get_session() as session:
        job = session.get(Job, job_id)
        if job is None:
            return None
        return {
            "type": "snapshot",
            "status": job.status,
            "stage": job.stage,
            "error": job.error,
            "final_file": job.final_file,
        }


@router.websocket("/ws/jobs/{job_id}")
async def job_status_ws(websocket: WebSocket, job_id: str):
    await websocket.accept()

    redis_client = aioredis.from_url(REDIS_URL)
    pubsub = redis_client.pubsub()
    # Subscribe FIRST so no event is lost between the snapshot read and here.
    await pubsub.subscribe(f"{CHANNEL_PREFIX}{job_id}")

    # Sync DB read off the event loop so it doesn't stall other sockets.
    snapshot = await asyncio.to_thread(_snapshot, job_id)
    if snapshot is None:
        await pubsub.unsubscribe(f"{CHANNEL_PREFIX}{job_id}")
        await pubsub.aclose()
        await redis_client.aclose()
        await websocket.close(code=4404, reason="Job not found")
        return
    await websocket.send_json(snapshot)

    # If the job already reached a terminal state before we connected, the
    # snapshot is all there is — no further events will come. Close cleanly.
    if snapshot["status"] in _TERMINAL:
        await pubsub.unsubscribe(f"{CHANNEL_PREFIX}{job_id}")
        await pubsub.aclose()
        await redis_client.aclose()
        await websocket.close()
        return

    async def relay_events():
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=None)
            if message is not None:
                await websocket.send_text(message["data"].decode())

    async def watch_disconnect():
        # This route is push-only; any inbound frame (including the close
        # frame) means we're done relaying.
        await websocket.receive_text()

    relay_task = asyncio.create_task(relay_events())
    disconnect_task = asyncio.create_task(watch_disconnect())
    try:
        await asyncio.wait(
            [relay_task, disconnect_task], return_when=asyncio.FIRST_COMPLETED
        )
    except WebSocketDisconnect:
        pass
    finally:
        relay_task.cancel()
        disconnect_task.cancel()
        await pubsub.unsubscribe(f"{CHANNEL_PREFIX}{job_id}")
        await pubsub.aclose()
        await redis_client.aclose()
