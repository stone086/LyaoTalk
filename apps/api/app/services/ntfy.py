"""Publish generic chat alerts to the local ntfy server."""
import logging
import hashlib
from urllib.parse import urlparse

import httpx

from app.core.config import settings
from app.utils.cache import get_redis

logger = logging.getLogger("lyaotalk.ntfy")


def ntfy_ready() -> bool:
    internal = urlparse(settings.NTFY_INTERNAL_URL)
    public = urlparse(settings.NTFY_PUBLIC_URL)
    return bool(
        internal.scheme == "http"
        and internal.hostname in {"127.0.0.1", "localhost"}
        and public.scheme == "https"
        and public.hostname
        and settings.NTFY_PUBLISH_TOKEN
    )


async def publish_ntfy(topic: str, *, message_id: str | None = None) -> bool:
    """Send no sender, JID, message body, or conversation identifier."""
    if not ntfy_ready() or not topic.startswith("lt_"):
        return False
    cache = None
    dedup_key = "ntfy:message:" + hashlib.sha256((topic + ":" + (message_id or "")).encode()).hexdigest()
    if message_id:
        try:
            cache = await get_redis()
            if not await cache.set(dedup_key, "1", ex=86400, nx=True):
                return True
        except Exception as exc:
            logger.warning("ntfy_dedup_unavailable error=%s", type(exc).__name__)
            cache = None
    click = (settings.FRONTEND_URL or "https://2-yc.com").rstrip("/") + "/"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{settings.NTFY_INTERNAL_URL.rstrip('/')}/{topic}",
                content="你有新消息",
                headers={
                    "Authorization": f"Bearer {settings.NTFY_PUBLISH_TOKEN}",
                    "Title": "LyaoTalk",
                    "Click": click,
                    "Priority": "default",
                },
            )
        if response.status_code == 200:
            return True
        logger.warning("ntfy_publish_failed status=%s", response.status_code)
    except httpx.HTTPError as exc:
        logger.warning("ntfy_publish_failed error=%s", type(exc).__name__)
    if cache is not None:
        try:
            await cache.delete(dedup_key)
        except Exception:
            pass
    return False
