import redis.asyncio as aioredis
from app.core.config import settings
from typing import Optional
import json

_redis: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = await aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis


async def cache_set(key: str, value: dict, ttl: int = 300):
    r = await get_redis()
    await r.setex(key, ttl, json.dumps(value))


async def cache_get(key: str) -> Optional[dict]:
    r = await get_redis()
    raw = await r.get(key)
    if raw:
        return json.loads(raw)
    return None


async def cache_delete(key: str):
    r = await get_redis()
    await r.delete(key)


async def cache_invalidate_prefix(prefix: str):
    r = await get_redis()
    keys = await r.keys(f"{prefix}*")
    if keys:
        await r.delete(*keys)
