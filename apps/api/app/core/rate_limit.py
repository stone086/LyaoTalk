"""Rate limiter shared by every router.

Two properties matter here:

* The key must be the real TCP peer. nginx appends to ``X-Forwarded-For``
  (``$proxy_add_x_forwarded_for``), so a client-supplied value must never be
  trusted. nginx replaces ``X-Real-IP`` with ``$remote_addr``, which is what
  the audit log already uses.
* Counters must be shared. uvicorn runs ``--workers 2``; the slowapi default
  storage is per-process ``memory://``, which silently doubles every limit
  and forgets them on restart. Redis is already a hard dependency of the API
  (JWT revocation, sessions), so use the same instance.
"""
from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import settings


def client_key(request: Request) -> str:
    """Rate-limit bucket key: X-Real-IP when present, else the socket peer."""
    real_ip = (request.headers.get("x-real-ip") or "").strip()
    if real_ip:
        return real_ip[:64]
    return get_remote_address(request)


try:
    limiter = Limiter(key_func=client_key, storage_uri=settings.REDIS_URL)
except Exception:  # pragma: no cover - degraded but functional
    limiter = Limiter(key_func=client_key)
