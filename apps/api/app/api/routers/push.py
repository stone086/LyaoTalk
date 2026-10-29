"""
push.py - Web Push notification endpoint.

Receives push subscriptions from PWA frontend and forwards XMPP push
notifications (XEP-0357) to the browser via the Web Push protocol.

Architecture:
  Prosody (mod_cloud_notify) → POST /push/notify → Web Push → Browser SW
                                       ↑
  PWA frontend → POST /push/subscribe (registers endpoint)
"""
import secrets as _secrets
import hashlib
import hmac
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, HTTPException, Body, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, or_
from sqlalchemy.exc import IntegrityError
from typing import Optional
import json
import logging
import asyncio
from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import PushSubscription, NtfySubscription
from app.services.ntfy import ntfy_ready, publish_ntfy
from app.utils.security import get_current_user

logger = logging.getLogger("lyaotalk.push")

router = APIRouter()


# Allow-list of trusted Web Push endpoints. Without this, an attacker could
# register `endpoint="https://attacker.com/log"` — the notify handler would
# happily POST notification bodies (sender JID, message preview) to the
# attacker's URL, leaking message content.
#
# These are the canonical push services for major browsers:
#   - FCM (Chrome, Edge, Brave, Opera, all Chromium): fcm.googleapis.com
#   - Mozilla (Firefox): updates.push.services.mozilla.com
#   - Apple (Safari): web.push.apple.com
#   - Microsoft Edge legacy: notify.windows.com
_ALLOWED_PUSH_HOSTS = {
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
    "notify.windows.com",
}


def _notification_tag(node: str, secret: str) -> str:
    """Group only notifications for the same opaque device node.

    A fixed tag merges notifications from separate logged-in accounts. Never
    expose the node itself or a JID to the browser notification surface.
    """
    digest = hmac.new(secret.encode(), node.encode(), hashlib.sha256).hexdigest()
    return f"lyaotalk-{digest[:23]}"


def _validate_push_endpoint(endpoint: str) -> None:
    """Reject endpoints that don't point to a trusted Web Push provider."""
    try:
        parsed = urlparse(endpoint)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid endpoint URL")
    if parsed.scheme != "https":
        raise HTTPException(status_code=400, detail="Endpoint must use https")
    host = (parsed.hostname or "").lower()
    if not host:
        raise HTTPException(status_code=400, detail="Endpoint missing host")
    # Allow exact matches and subdomains of allowed hosts (FCM uses fcm.googleapis.com directly)
    if host in _ALLOWED_PUSH_HOSTS:
        return
    for allowed in _ALLOWED_PUSH_HOSTS:
        if host.endswith("." + allowed):
            return
    raise HTTPException(status_code=400, detail="Endpoint host is not a recognized push provider")


class PushSubscriptionRequest(BaseModel):
    endpoint: str = Field(..., min_length=10, max_length=2048)
    node: str = Field(..., pattern=r"^[A-Za-z0-9_-]{1,128}$")
    p256dh: str = Field(..., min_length=1, max_length=256)
    auth: str = Field(..., min_length=1, max_length=64)
    user_agent: Optional[str] = Field(None, max_length=512)


class PushNotifyRequest(BaseModel):
    """Internal endpoint called by Prosody mod_cloud_notify."""
    node: str = Field(..., pattern=r"^[A-Za-z0-9_-]{1,128}$")
    title: str = Field(..., max_length=256)
    body: str = Field(..., max_length=2048)
    badge: Optional[int] = Field(None, ge=0, le=99999)
    secret: str = Field(..., min_length=1, max_length=512)


def _ntfy_info(row: NtfySubscription) -> dict[str, str | bool]:
    return {
        "enabled": True,
        "node": row.node,
        "topic": row.topic,
        "server": settings.NTFY_PUBLIC_URL.rstrip("/"),
    }


@router.get("/push/ntfy")
async def ntfy_status(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    row = await db.get(NtfySubscription, current_user["account_id"])
    return _ntfy_info(row) if row else {"enabled": False}


@router.post("/push/ntfy")
@limiter.limit("10/minute")
async def ntfy_enable(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    if not ntfy_ready():
        raise HTTPException(status_code=503, detail="ntfy is not configured")
    account_id = current_user["account_id"]
    row = await db.get(NtfySubscription, account_id)
    if row is None:
        row = NtfySubscription(
            account_id=account_id,
            topic=f"lt_{_secrets.token_hex(16)}",
            node=f"ntfy_{_secrets.token_hex(16)}",
        )
        db.add(row)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            row = await db.get(NtfySubscription, account_id)
            if row is None:
                raise HTTPException(status_code=409, detail="Please retry ntfy setup")
    return _ntfy_info(row)


@router.delete("/push/ntfy")
async def ntfy_disable(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    await db.execute(delete(NtfySubscription).where(NtfySubscription.account_id == current_user["account_id"]))
    await db.commit()
    return {"enabled": False}


@router.post("/push/ntfy/test")
@limiter.limit("5/minute")
async def ntfy_test(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    row = await db.get(NtfySubscription, current_user["account_id"])
    if row is None:
        raise HTTPException(status_code=404, detail="ntfy is not enabled")
    if not await publish_ntfy(row.topic):
        raise HTTPException(status_code=502, detail="ntfy delivery failed")
    return {"status": "sent"}


@router.post("/push/subscribe")
@limiter.limit("30/minute")
async def subscribe(
    request: Request,
    payload: PushSubscriptionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Register a Web Push subscription for the current user."""
    account_id = current_user.get("account_id")
    if not account_id:
        raise HTTPException(status_code=403, detail="User token required")
    _validate_push_endpoint(payload.endpoint)

    # A node identifies exactly one registered account/device. A different
    # account may not claim an existing node even if it guesses its value.
    existing = await db.execute(
        select(PushSubscription).where(PushSubscription.node == payload.node)
    )
    owner = existing.scalar_one_or_none()
    if owner and owner.account_id != account_id:
        raise HTTPException(status_code=409, detail="Push node already registered")
    # Replace stale endpoint or node for this account only.
    await db.execute(
        delete(PushSubscription).where(
            PushSubscription.account_id == account_id,
            or_(PushSubscription.endpoint == payload.endpoint, PushSubscription.node == payload.node),
        )
    )
    sub = PushSubscription(
        account_id=account_id,
        endpoint=payload.endpoint,
        node=payload.node,
        p256dh=payload.p256dh,
        auth=payload.auth,
        user_agent=payload.user_agent,
    )
    db.add(sub)
    try:
        await db.commit()
    except IntegrityError as exc:
        # Another registration may claim the globally unique node between the
        # ownership query and commit. Return a conflict instead of a 500.
        await db.rollback()
        raise HTTPException(status_code=409, detail="Push subscription conflict") from exc
    return {"status": "ok"}


@router.delete("/push/unsubscribe")
async def unsubscribe(
    endpoint: str = Body(..., embed=True, max_length=2048),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Remove a Web Push subscription. Only deletes subs owned by caller."""
    account_id = current_user.get("account_id")
    if not account_id:
        raise HTTPException(status_code=403, detail="User token required")
    # Scope the delete to the caller's account.
    stmt = delete(PushSubscription).where(
        PushSubscription.endpoint == endpoint,
        PushSubscription.account_id == account_id,
    )
    await db.execute(stmt)
    await db.commit()
    return {"status": "ok"}


@router.post("/push/notify", include_in_schema=False)
async def notify(
    payload: PushNotifyRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Internal endpoint called by Prosody (XEP-0357) when an XMPP push
    notification needs to be relayed to the user's PWA.

    Authenticated by shared secret (PUSH_SHARED_SECRET env), not JWT.
    """
    expected = settings.PUSH_SHARED_SECRET or None
    # Constant-time comparison + presence check. `payload.secret != expected`
    # is timing-attackable and would crash if expected is None.
    if not expected or not _secrets.compare_digest(payload.secret, expected):
        raise HTTPException(status_code=403, detail="Invalid push secret")

    ntfy_row = (await db.execute(
        select(NtfySubscription).where(NtfySubscription.node == payload.node)
    )).scalar_one_or_none()
    ntfy_sent = False
    if ntfy_row:
        # ntfy failures must not prevent existing Web Push delivery.
        ntfy_sent = await publish_ntfy(ntfy_row.topic, collapse=True)

    # Route using the opaque per-account node from the XEP-0357 publish IQ.
    # The publishing server's stanza `from` is its domain, not the recipient.
    result = await db.execute(
        select(PushSubscription).where(PushSubscription.node == payload.node)
    )
    subs = result.scalars().all()
    if not subs:
        return {"status": "ok" if ntfy_sent else "no_subscriptions", "ntfy_sent": ntfy_sent}

    # Send Web Push to each subscription
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        # pywebpush not installed; log and skip
        return {"status": "pywebpush_missing"}

    vapid_private_key = settings.VAPID_PRIVATE_KEY
    vapid_email = settings.VAPID_EMAIL
    if not vapid_private_key:
        return {"status": "vapid_not_configured"}

    notify_payload = json.dumps({
        "title": payload.title,
        "body": payload.body,
        "badge": payload.badge,
        "tag": _notification_tag(payload.node, expected),
    })

    async def send_one(sub: PushSubscription) -> tuple[str, str]:
        try:
            await asyncio.to_thread(
                webpush,
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                },
                data=notify_payload,
                vapid_private_key=vapid_private_key,
                vapid_claims={"sub": f"mailto:{vapid_email}"},
                ttl=3600,
                timeout=10,
                headers={"Urgency": "high"},
            )
            return ("sent", sub.endpoint)
        except WebPushException as exc:
            # 410 = subscription expired/revoked
            if exc.response and exc.response.status_code in (404, 410):
                return ("expired", sub.endpoint)
            logger.warning("push_send_failed status=%s", exc.response.status_code if exc.response else "unknown")
        except Exception as exc:
            logger.warning("push_send_failed error=%s", type(exc).__name__)
        return ("failed", sub.endpoint)

    # pywebpush performs blocking HTTP I/O; send independently so one slow
    # provider cannot stall the API event loop or other device deliveries.
    outcomes = await asyncio.gather(*(send_one(sub) for sub in subs))
    sent = sum(status == "sent" for status, _ in outcomes)
    failed_endpoints = [endpoint for status, endpoint in outcomes if status == "expired"]

    # Clean up dead subscriptions
    if failed_endpoints:
        await db.execute(
            delete(PushSubscription).where(
                PushSubscription.endpoint.in_(failed_endpoints)
            )
        )
        await db.commit()

    return {"status": "ok", "sent": sent, "removed": len(failed_endpoints)}


@router.get("/push/vapid-public-key")
async def get_vapid_public_key():
    """Public endpoint - frontend needs the VAPID public key to subscribe."""
    return {"key": settings.VAPID_PUBLIC_KEY}
