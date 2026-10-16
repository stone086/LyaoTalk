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
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, HTTPException, Body, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import Optional
import json
import logging
from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import PushSubscription
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
    p256dh: str = Field(..., min_length=1, max_length=256)
    auth: str = Field(..., min_length=1, max_length=64)
    user_agent: Optional[str] = Field(None, max_length=512)


class PushNotifyRequest(BaseModel):
    """Internal endpoint called by Prosody mod_cloud_notify."""
    account_jid: str = Field(..., min_length=3, max_length=130)
    title: str = Field(..., max_length=256)
    body: str = Field(..., max_length=2048)
    badge: Optional[int] = Field(None, ge=0, le=99999)
    secret: str = Field(..., min_length=1, max_length=512)


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

    # Upsert: replace any existing subscription for same endpoint.
    # Note: this also implicitly lets a user "claim" any orphaned sub for the
    # same endpoint URL, but since endpoints are scoped to a browser/device
    # token only the legitimate device knows the URL, so this is fine.
    await db.execute(
        delete(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    )
    sub = PushSubscription(
        account_id=account_id,
        endpoint=payload.endpoint,
        p256dh=payload.p256dh,
        auth=payload.auth,
        user_agent=payload.user_agent,
    )
    db.add(sub)
    await db.commit()
    return {"status": "ok"}


@router.delete("/push/unsubscribe")
async def unsubscribe(
    endpoint: str = Body(..., embed=True, max_length=2048),
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Remove a Web Push subscription. Only deletes subs owned by caller."""
    account_id = current_user.get("account_id")
    if not account_id and current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="User token required")
    # Scope the delete to the caller's account so a malicious user can't
    # unsubscribe someone else by guessing/leaking their endpoint URL.
    if current_user.get("role") == "admin":
        stmt = delete(PushSubscription).where(PushSubscription.endpoint == endpoint)
    else:
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

    # Find subscriptions for the target account
    from app.models import Account
    result = await db.execute(
        select(Account).where(Account.jid == payload.account_jid)
    )
    account = result.scalar_one_or_none()
    if not account:
        return {"status": "no_account"}

    result = await db.execute(
        select(PushSubscription).where(PushSubscription.account_id == account.id)
    )
    subs = result.scalars().all()
    if not subs:
        return {"status": "no_subscriptions"}

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
        "tag": "lyaotalk-msg",
    })

    sent = 0
    failed_endpoints = []
    for sub in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                },
                data=notify_payload,
                vapid_private_key=vapid_private_key,
                vapid_claims={"sub": f"mailto:{vapid_email}"},
            )
            sent += 1
        except WebPushException as exc:
            # 410 = subscription expired/revoked
            if exc.response and exc.response.status_code in (404, 410):
                failed_endpoints.append(sub.endpoint)
        except Exception as exc:
            logger.warning(f"push_send_failed endpoint={sub.endpoint[:80]} error={type(exc).__name__}: {exc}")

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
