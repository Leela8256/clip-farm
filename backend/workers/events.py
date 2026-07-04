"""
Job progress pub/sub — Celery tasks publish stage changes here; the FastAPI
WebSocket route (api/routes/ws.py) relays them to connected frontends.
Redis is already a hard dependency (Celery's broker), so its pub/sub is the
simplest way to bridge a Celery worker process to a FastAPI process without
adding new infrastructure.
"""

from __future__ import annotations
import json
import os

import redis

from workers.celery_app import REDIS_URL

CHANNEL_PREFIX = "job_events:"

# Lazily created per-process. Celery prefork forks the worker after import, so
# a connection object made at import time would be shared across forked
# children — recreate it once per PID instead.
_redis: redis.Redis | None = None
_redis_pid: int | None = None


def _client() -> redis.Redis:
    global _redis, _redis_pid
    pid = os.getpid()
    if _redis is None or _redis_pid != pid:
        _redis = redis.Redis.from_url(REDIS_URL)
        _redis_pid = pid
    return _redis


def _channel(job_id: str) -> str:
    return f"{CHANNEL_PREFIX}{job_id}"


def publish_stage(job_id: str, stage: str) -> None:
    _client().publish(_channel(job_id), json.dumps({"type": "stage", "stage": stage}))


def publish_terminal(job_id: str, status: str, **extra) -> None:
    payload = {"type": "terminal", "status": status, **extra}
    _client().publish(_channel(job_id), json.dumps(payload))
