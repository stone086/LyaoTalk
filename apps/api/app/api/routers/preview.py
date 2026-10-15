"""
preview.py - Server-side link preview generator (OG/oEmbed meta scraping).

Frontend detects URLs in messages and calls /preview?url=...
We fetch the URL server-side (bypasses browser CORS), parse Open Graph
and basic <meta> tags, and return a structured preview that the chat
bubble can render as a card.

Cached in Redis for 1 hour to avoid hammering target sites.
"""
import re
import asyncio
import ipaddress
import socket
import time
from urllib.parse import urlparse
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.core.config import settings
from app.core.rate_limit import limiter

router = APIRouter()


class LinkPreview(BaseModel):
    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None
    site_name: Optional[str] = None
    favicon: Optional[str] = None


# In-process cache as a fallback if Redis is unavailable
_local_cache: dict[str, tuple[float, LinkPreview]] = {}
_CACHE_TTL = 3600.0  # 1 hour
_CACHE_MAX_ENTRIES = 1000  # Bound memory usage
_MAX_RESPONSE_BYTES = 200_000


def _local_cache_set(url: str, expires_at: float, preview: LinkPreview) -> None:
    """Set cache entry; if over size limit, evict expired then oldest entries."""
    now = time.time()
    if len(_local_cache) >= _CACHE_MAX_ENTRIES:
        # First, drop expired entries
        expired = [k for k, (exp, _) in _local_cache.items() if exp <= now]
        for k in expired:
            _local_cache.pop(k, None)
        # If still over limit, drop oldest (lowest expiry)
        if len(_local_cache) >= _CACHE_MAX_ENTRIES:
            sorted_items = sorted(_local_cache.items(), key=lambda kv: kv[1][0])
            for k, _ in sorted_items[: len(_local_cache) - _CACHE_MAX_ENTRIES + 1]:
                _local_cache.pop(k, None)
    _local_cache[url] = (expires_at, preview)


class PublicIPTransport(httpx.AsyncHTTPTransport):
    """Resolve once, validate, then connect to that exact IP address."""

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        parsed = urlparse(str(request.url))
        host = parsed.hostname or ""
        if (parsed.scheme not in ("http", "https") or not host or
                parsed.username or parsed.password or
                parsed.port not in (None, 80, 443)):
            raise HTTPException(400, "URL not allowed")
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(
                host, parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
            addresses = [ipaddress.ip_address(info[4][0]) for info in infos]
        except (OSError, ValueError):
            raise HTTPException(400, "URL not allowed")
        if not addresses or any(not address.is_global for address in addresses):
            raise HTTPException(400, "URL not allowed")
        request.headers["Host"] = parsed.netloc
        request.extensions["sni_hostname"] = host
        request.url = request.url.copy_with(host=str(addresses[0]))
        return await super().handle_async_request(request)


def _meta_value(html: str, *names: str) -> Optional[str]:
    """Extract content from <meta property=... content=...> for any of names.

    Returned value is capped at 1024 chars — a malicious target page could
    return a 200KB og:title that bloats Redis and the client cache.
    """
    for name in names:
        # property="og:title" content="..." or content="..." property="..."
        for pattern in (
            rf'<meta[^>]+(?:property|name)=["\']({re.escape(name)})["\'][^>]*content=["\']([^"\']+)["\']',
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']({re.escape(name)})["\']',
        ):
            m = re.search(pattern, html, re.IGNORECASE)
            if m:
                # The content group depends on which pattern matched
                groups = m.groups()
                # Find the one that's not the name itself
                value = next((g for g in groups if g != name), None)
                if value is not None:
                    return value[:1024]
    return None


def _extract_title(html: str) -> Optional[str]:
    m = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
    return m.group(1).strip()[:1024] if m else None


@router.get("/preview", response_model=LinkPreview)
@limiter.limit("60/minute")
async def link_preview(
    request: Request,
    url: str = Query(..., min_length=1, max_length=2000),
):
    """
    Fetch a URL and return Open Graph metadata for rendering a preview card.

    Rate-limited per client IP to prevent abuse:
      - DoS-by-fetch: amplifying load on target sites via our server
      - SSRF probing: even with `_looks_safe`, brute-forcing IP space
      - Crawl tarpit: forcing us to dial slow/dead servers in parallel
    """
    parsed_url = urlparse(url)
    if parsed_url.scheme not in ("http", "https") or not parsed_url.hostname:
        raise HTTPException(400, "URL not allowed")

    import time
    now = time.time()

    # Check local cache first
    cached = _local_cache.get(url)
    if cached and cached[0] > now:
        return cached[1]

    # Try Redis if available
    redis_client = None
    try:
        import redis.asyncio as aredis
        redis_client = aredis.from_url(settings.REDIS_URL or "redis://127.0.0.1:6379")
        cached_json = await redis_client.get(f"preview:{url}")
        if cached_json:
            import json
            return LinkPreview(**json.loads(cached_json))
    except Exception:
        redis_client = None

    # Fetch the URL with manual redirect handling. We validate every hop
    # against _looks_safe to prevent SSRF via:
    #   - DNS rebinding (httpx re-resolves on connect after our pre-check)
    #   - HTTP redirects (a public URL can 302 to http://169.254.169.254/...)
    # Cap at 5 redirects.
    try:
        async with httpx.AsyncClient(
            timeout=8.0,
            follow_redirects=False,
            trust_env=False,
            transport=PublicIPTransport(limits=httpx.Limits(max_connections=5)),
            headers={"User-Agent": "LiaoTBot/1.0 (link preview)"},
        ) as client:
            current_url = url
            status_code = None
            response_headers = {}
            response_text = ""
            for hop in range(6):
                # The transport validates every redirect hop and pins the
                # connection to the validated address.
                async with client.stream("GET", current_url) as resp:
                    status_code = resp.status_code
                    response_headers = resp.headers
                    if status_code in (301, 302, 303, 307, 308):
                        location = resp.headers.get("location", "")
                        if not location:
                            break
                        from urllib.parse import urljoin
                        current_url = urljoin(current_url, location)
                        continue
                    if status_code < 400:
                        chunks = bytearray()
                        async for chunk in resp.aiter_bytes():
                            chunks.extend(chunk)
                            if len(chunks) > _MAX_RESPONSE_BYTES:
                                raise HTTPException(413, "Preview response too large")
                        response_text = chunks.decode(resp.encoding or "utf-8", errors="replace")
                break
            if status_code is None:
                raise HTTPException(502, "No response")
            if status_code in (301, 302, 303, 307, 308):
                raise HTTPException(400, "Too many redirects")
            if status_code >= 400:
                raise HTTPException(502, f"Target returned {status_code}")
            ctype = response_headers.get("content-type", "").lower()
            if "html" not in ctype and "xml" not in ctype:
                # Probably an image/video - return minimal preview
                preview = LinkPreview(url=url, image=url if "image" in ctype else None)
            else:
                # Parse HTML
                html = response_text
                preview = LinkPreview(
                    url=url,
                    title=_meta_value(html, "og:title") or _extract_title(html),
                    description=_meta_value(html, "og:description", "description"),
                    image=_meta_value(html, "og:image", "twitter:image"),
                    site_name=_meta_value(html, "og:site_name"),
                )
                # Resolve relative image URLs and harden against XSS:
                # Reject data:/javascript:/vbscript:/file: schemes — these would
                # let an attacker inject <img src="javascript:..."> or
                # <img src="data:image/svg+xml,<svg onload=...>"> via OG tags.
                if preview.image:
                    img = preview.image.strip()
                    if not img.startswith(("http://", "https://")):
                        parsed = urlparse(url)
                        if img.startswith("//"):
                            img = f"{parsed.scheme}:{img}"
                        elif img.startswith("/"):
                            img = f"{parsed.scheme}://{parsed.netloc}{img}"
                        else:
                            # Reject any other scheme (data:, javascript:, file:, ...)
                            img = ""
                    # Final scheme check after resolution
                    if img and not img.lower().startswith(("http://", "https://")):
                        img = ""
                    preview.image = img or None
                # Favicon
                preview.favicon = f"{urlparse(url).scheme}://{urlparse(url).netloc}/favicon.ico"
    except httpx.TimeoutException:
        raise HTTPException(504, "Target timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Fetch failed: {e}")

    # Store in caches
    _local_cache_set(url, now + _CACHE_TTL, preview)
    if redis_client:
        try:
            import json
            await redis_client.setex(
                f"preview:{url}",
                _CACHE_TTL,
                json.dumps(preview.model_dump()),
            )
            await redis_client.close()
        except Exception:
            pass

    return preview
