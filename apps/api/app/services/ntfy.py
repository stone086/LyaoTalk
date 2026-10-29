"""Publish generic chat alerts to the local ntfy server."""
import logging
from urllib.parse import urlparse

import httpx

from app.core.config import settings

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


async def publish_ntfy(topic: str) -> bool:
    """Send no sender, JID, message body, or conversation identifier."""
    if not ntfy_ready() or not topic.startswith("lt_"):
        return False
    click = (settings.FRONTEND_URL or "https://2-yc.com").rstrip("/") + "/"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{settings.NTFY_INTERNAL_URL.rstrip('/')}/{topic}",
                content="You have a new message",
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
    return False
