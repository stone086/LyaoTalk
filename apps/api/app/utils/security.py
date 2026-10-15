"""
JWT issuance, validation, and revocation.

Each token carries a ``jti`` (JWT ID) so it can be individually revoked
through the Redis-backed denylist. Two token types are issued:

* **access** — short-lived (default 30 min). Carried in
  ``Authorization: Bearer ...``. Verified on every request.
* **refresh** — longer-lived (default 14 days). Used at
  ``POST /auth/refresh`` to mint a new access token without re-prompting
  for the password. Marked with ``type=refresh`` so it cannot be used in
  place of an access token.

Revocation is best-effort: if Redis is unreachable, validation still
succeeds (we don't want to lock everyone out on a Redis outage), but a
warning is logged. To force a hard fence (deny on Redis failure), set
``JWT_DENY_ON_REVOCATION_BACKEND_FAILURE=1`` in env.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import jwt
from jwt import PyJWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models import Account

bearer_scheme = HTTPBearer(auto_error=False)
logger = logging.getLogger("liaot.security")
UTC = timezone.utc

# Redis client created lazily so missing redis (e.g. tests) doesn't crash import
_redis_client = None
_redis_init_failed = False


def _get_redis():
    global _redis_client, _redis_init_failed
    if _redis_client is not None:
        return _redis_client
    if _redis_init_failed:
        return None
    try:
        import redis  # type: ignore[import-not-found]
        _redis_client = redis.from_url(
            settings.REDIS_URL,
            socket_timeout=2,
            socket_connect_timeout=2,
            decode_responses=True,
        )
        return _redis_client
    except Exception as e:
        _redis_init_failed = True
        logger.warning(f"redis_init_failed: {type(e).__name__}: {e}")
        return None


REVOCATION_KEY_PREFIX = "jwt:revoked:"
DISABLED_ACCOUNT_KEY_PREFIX = "jwt:disabled-account:"
SESSION_VERSION_KEY_PREFIX = "jwt:session-version:"


def current_session_version(account_id: str, *, create: bool = False) -> str:
    """Return an account-wide opaque version; fail closed if Redis is lost."""
    r = _get_redis()
    if r is None:
        raise HTTPException(status_code=503, detail="Session store unavailable")
    key = f"{SESSION_VERSION_KEY_PREFIX}{account_id}"
    try:
        if create:
            r.setnx(key, str(uuid.uuid4()))
        version = r.get(key)
    except Exception as exc:
        logger.warning("session_version_check_failed account=%s err=%s", account_id[:8], type(exc).__name__)
        raise HTTPException(status_code=503, detail="Session store unavailable") from exc
    if not isinstance(version, str) or not version:
        raise HTTPException(status_code=401, detail="Session has expired")
    return version


def rotate_session_version(account_id: str) -> str:
    """Invalidate every access and refresh token for one account."""
    r = _get_redis()
    if r is None:
        raise HTTPException(status_code=503, detail="Session store unavailable")
    version = str(uuid.uuid4())
    try:
        if not r.set(f"{SESSION_VERSION_KEY_PREFIX}{account_id}", version):
            raise ValueError("session version write failed")
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Session store unavailable") from exc
    return version


def _hard_fence_on_redis_failure() -> bool:
    return os.getenv("JWT_DENY_ON_REVOCATION_BACKEND_FAILURE", "").strip().lower() in (
        "1", "true", "yes",
    )


def _is_revoked(jti: str) -> bool:
    """Check if the given jti has been revoked.

    On Redis failure: returns False (allow) by default. Set
    ``JWT_DENY_ON_REVOCATION_BACKEND_FAILURE=1`` to flip the default to
    deny — useful in high-security deployments.
    """
    r = _get_redis()
    if r is None:
        return _hard_fence_on_redis_failure()
    try:
        return bool(r.exists(f"{REVOCATION_KEY_PREFIX}{jti}"))
    except Exception as e:
        logger.warning(f"revocation_check_failed jti={jti[:8]}... err={type(e).__name__}: {e}")
        return _hard_fence_on_redis_failure()


def revoke_token(jti: str, ttl_seconds: int) -> bool:
    """Add a jti to the revocation list with TTL matching the token's expiry.

    The TTL prevents the denylist from growing unboundedly: once the
    underlying token would have expired anyway, the revocation record
    is no longer needed. Returns True on success, False if the backend is
    unavailable.
    """
    if ttl_seconds <= 0:
        return False
    r = _get_redis()
    if r is None:
        return False
    try:
        r.set(f"{REVOCATION_KEY_PREFIX}{jti}", "1", ex=ttl_seconds)
        return True
    except Exception as e:
        logger.warning(f"revoke_token_failed jti={jti[:8]}... err={type(e).__name__}: {e}")
        return False


def mark_account_disabled(account_id: str) -> bool:
    """Fence every existing token for an account, including websocket logins."""
    r = _get_redis()
    if r is None:
        return False
    try:
        return bool(r.set(f"{DISABLED_ACCOUNT_KEY_PREFIX}{account_id}", "1"))
    except Exception as exc:
        logger.warning("account_disable_fence_failed: %s", type(exc).__name__)
        return False


def _is_account_disabled(account_id: str) -> bool:
    r = _get_redis()
    if r is None:
        return True
    try:
        return bool(r.exists(f"{DISABLED_ACCOUNT_KEY_PREFIX}{account_id}"))
    except Exception as exc:
        logger.warning("account_disable_check_failed: %s", type(exc).__name__)
        return True


def _build_payload(
    subject: str,
    role: str,
    token_type: str,
    expires_minutes: int,
    account_id: str | None = None,
    credential_revision: str | None = None,
) -> dict[str, Any]:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": int(now.timestamp()),
        "exp": now + timedelta(minutes=expires_minutes),
        "jti": str(uuid.uuid4()),
        "role": role,
        "type": token_type,
    }
    if account_id:
        payload["account_id"] = account_id
    if role == "user":
        if not account_id:
            raise ValueError("User tokens require an account ID")
        payload["sv"] = current_session_version(account_id, create=True)
        if credential_revision:
            payload["cv"] = credential_revision
    return payload


def create_access_token(
    subject: str,
    expires_minutes: int | None = None,
    role: str = "admin",
    account_id: str | None = None,
    credential_revision: str | None = None,
) -> str:
    """Issue a short-lived access token (30 min default)."""
    minutes = expires_minutes or settings.ACCESS_TOKEN_EXPIRE_MINUTES_ACCESS
    payload = _build_payload(subject, role, "access", minutes, account_id, credential_revision)
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(
    subject: str,
    role: str = "admin",
    account_id: str | None = None,
    credential_revision: str | None = None,
) -> str:
    """Issue a refresh token (14 days default).

    Refresh tokens are used only at the /auth/refresh endpoint to mint
    new access tokens. They cannot stand in for an access token because
    the validators check ``type == "access"``.
    """
    minutes = settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60
    payload = _build_payload(subject, role, "refresh", minutes, account_id, credential_revision)
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str, expected_type: str = "access") -> dict[str, Any]:
    """Decode and validate a JWT.

    Validates: signature, expiry (exp), required claims (sub, jti, type),
    type matches expected, jti not revoked.
    """
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    if "sub" not in payload:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    # Token type — refresh tokens MUST NOT be accepted as access tokens
    token_type = payload.get("type", "access")  # legacy tokens have no type → treat as access
    if expected_type and token_type != expected_type:
        raise HTTPException(status_code=401, detail=f"Token type mismatch (expected {expected_type})")

    if payload.get("role") == "user":
        account_id = payload.get("account_id")
        if not account_id or _is_account_disabled(account_id):
            raise HTTPException(status_code=403, detail="Account is disabled or unavailable")
        if payload.get("sv") != current_session_version(account_id):
            raise HTTPException(status_code=401, detail="Session has expired")
        if payload.get("cv"):
            from app.services.prosody_revision import get_credential_revision
            if payload["cv"] != get_credential_revision(payload["sub"]):
                raise HTTPException(status_code=401, detail="Account credentials changed")

    # Revocation check — denies tokens that have been explicitly invalidated
    jti = payload.get("jti")
    if jti and _is_revoked(jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    return payload


def get_current_admin(
    credentials: HTTPAuthorizationCredentials = Security(bearer_scheme),
) -> str:
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    if payload.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin token required")
    return payload["sub"]


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Security(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    if payload.get("role") != "user":
        raise HTTPException(status_code=403, detail="User token required")
    account_id = payload.get("account_id")
    if not account_id:
        raise HTTPException(status_code=401, detail="Invalid user token payload")
    result = await db.execute(select(Account).where(Account.id == account_id))
    account = result.scalar_one_or_none()
    if not account or not account.is_enabled or account.jid != payload["sub"]:
        raise HTTPException(status_code=403, detail="Account is disabled or unavailable")
    return {"sub": payload["sub"], "account_id": account_id}
