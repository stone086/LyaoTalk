"""Durable, per-message ntfy delay with displayed-receipt cancellation."""
import asyncio
import hashlib
import json
import logging
import time
import httpx

from app.core.config import settings

from app.services.ntfy import publish_ntfy
from app.utils.cache import get_redis

logger = logging.getLogger("lyaotalk.ntfy_queue")
QUEUE = "ntfy:pending_queue"
WEB_QUEUE = "webpush:pending_queue"
DELAY_SECONDS = 30
TTL_SECONDS = 86400


def _key(topic: str, message_id: str) -> str:
    return hashlib.sha256(f"{topic}:{message_id}".encode()).hexdigest()


async def enqueue_ntfy(topic: str, message_id: str) -> bool:
    redis = await get_redis()
    key = _key(topic, message_id)
    if await redis.exists(f"ntfy:read:{key}"):
        return False
    if await redis.set(f"ntfy:pending:{key}", f"{topic}:{message_id}", nx=True, ex=TTL_SECONDS):
        await redis.zadd(QUEUE, {key: time.time() + DELAY_SECONDS}, nx=True)
    return True


async def cancel_ntfy(topic: str, message_id: str) -> None:
    redis = await get_redis()
    key = _key(topic, message_id)
    await redis.set(f"ntfy:read:{key}", "1", ex=TTL_SECONDS)
    await redis.zrem(QUEUE, key)
    await redis.delete(f"ntfy:pending:{key}")


async def enqueue_webpush(payload: dict) -> None:
    redis = await get_redis()
    key = _key(payload["node"], payload["message_id"])
    if await redis.exists(f"webpush:read:{key}"):
        return
    if await redis.set(f"webpush:pending:{key}", json.dumps(payload), nx=True, ex=TTL_SECONDS):
        await redis.zadd(WEB_QUEUE, {key: time.time() + DELAY_SECONDS}, nx=True)


async def cancel_webpush(node: str, message_id: str) -> None:
    redis = await get_redis()
    key = _key(node, message_id)
    await redis.set(f"webpush:read:{key}", "1", ex=TTL_SECONDS)
    await redis.zrem(WEB_QUEUE, key)
    await redis.delete(f"webpush:pending:{key}")


async def _send_webpush(payload: dict) -> bool:
    payload = {**payload, "secret": settings.PUSH_SHARED_SECRET, "deliver_only": True}
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post("http://127.0.0.1:8000/push/notify", json=payload)
    if response.status_code != 200:
        return False
    result = response.json()
    return result.get("status") in {"ok", "duplicate", "no_subscriptions"} and (
        result.get("status") != "ok" or result.get("sent", 0) > 0 or result.get("removed", 0) > 0
    )


async def _process_due_webpush() -> None:
    redis = await get_redis()
    keys = await redis.zrangebyscore(WEB_QUEUE, "-inf", time.time(), start=0, num=20)
    for key in keys:
        lock = f"webpush:send_lock:{key}"
        if not await redis.set(lock, "1", nx=True, ex=60):
            continue
        try:
            pending = await redis.get(f"webpush:pending:{key}")
            if not pending or await redis.exists(f"webpush:read:{key}"):
                await redis.zrem(WEB_QUEUE, key)
                await redis.delete(f"webpush:pending:{key}")
                continue
            if await _send_webpush(json.loads(pending)):
                await redis.zrem(WEB_QUEUE, key)
                await redis.delete(f"webpush:pending:{key}")
            else:
                await redis.zadd(WEB_QUEUE, {key: time.time() + 30})
        finally:
            await redis.delete(lock)


async def _process_due() -> None:
    redis = await get_redis()
    keys = await redis.zrangebyscore(QUEUE, "-inf", time.time(), start=0, num=20)
    for key in keys:
        lock = f"ntfy:send_lock:{key}"
        if not await redis.set(lock, "1", nx=True, ex=60):
            continue
        try:
            pending = await redis.get(f"ntfy:pending:{key}")
            if not pending or await redis.exists(f"ntfy:read:{key}"):
                await redis.zrem(QUEUE, key)
                await redis.delete(f"ntfy:pending:{key}")
                continue
            topic, message_id = pending.split(":", 1)
            if await publish_ntfy(topic, message_id=message_id):
                await redis.zrem(QUEUE, key)
                await redis.delete(f"ntfy:pending:{key}")
            else:
                await redis.zadd(QUEUE, {key: time.time() + 30})
        finally:
            await redis.delete(lock)


async def ntfy_queue_worker() -> None:
    while True:
        try:
            await _process_due()
            await _process_due_webpush()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("ntfy_queue_failed error=%s", type(exc).__name__)
        await asyncio.sleep(1)
