"""
webhooks.py - Inbound webhook endpoints.

External services POST messages into a LyaoTalk conversation:

    POST /webhooks/{webhook_id}
    Authorization: Bearer <token>
    {
      "message": "Build #1234 succeeded on main",
      "username": "ci-bot",
      "icon_emoji": ":white_check_mark:"
    }

Authentication
--------------
Two credentials exist and they are deliberately different things:

* ``token`` - identifies the webhook and authorises the call. Preferred
  transport is the ``Authorization: Bearer`` header; the legacy
  ``/webhooks/{id}/{token}`` path is still accepted so existing integrations
  keep working, but a path token ends up in access logs, shell history and CI
  configuration.
* ``signing_secret`` - keys the request signature. It is returned once at
  creation (and on rotation) and never appears in a URL, so leaking a logged
  URL no longer lets anyone forge or tamper with a delivery.

Signed deliveries send:

    X-LyaoTalk-Timestamp: <unix seconds>
    X-LyaoTalk-Signature: sha256=<hex hmac>

where the HMAC-SHA256 is computed over ``f"{timestamp}.".encode() + raw_body``
with ``signing_secret`` as the key. Timestamps must be within
``WEBHOOK_SIGNATURE_WINDOW_SECONDS`` and are single-use (Redis), so a captured
delivery cannot be replayed. Rotating the secret keeps the previous one valid
for ``ROTATION_OVERLAP_SECONDS``.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional
import hashlib
import hmac
import logging
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import Webhook, Conversation, Message, gen_uuid
from app.services.audit import write_audit, get_client_ip
from app.utils.cache import get_redis
from app.utils.security import get_current_admin

router = APIRouter()
logger = logging.getLogger("lyaotalk.webhooks")

WEBHOOK_SIGNATURE_WINDOW_SECONDS = 300
ROTATION_OVERLAP_SECONDS = 24 * 60 * 60


class WebhookCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    conversation_id: str = Field(..., min_length=1, max_length=64)


class WebhookOut(BaseModel):
    id: str
    name: str
    conversation_id: str
    token: str
    signing_secret: str
    url: str


class WebhookRotateOut(BaseModel):
    id: str
    signing_secret: str
    previous_secret_expires_at: datetime


class WebhookPost(BaseModel):
    message: str = Field(..., min_length=1, max_length=4096)
    username: Optional[str] = Field(None, max_length=64)
    icon_emoji: Optional[str] = Field(None, max_length=32)


def _new_secret() -> str:
    return secrets.token_urlsafe(32)


def _signature_keys(wh: Webhook) -> list[tuple[str, str]]:
    """Keys to try when verifying, as (label, secret).

    The current secret always wins. A rotated secret stays usable until its
    overlap deadline so integrations can be updated without a dropped delivery.
    Rows created before signing secrets existed fall back to the URL token,
    which is exactly the weakness this column removes - log it so operators can
    rotate those webhooks.
    """
    keys: list[tuple[str, str]] = []
    if wh.signing_secret:
        keys.append(("current", wh.signing_secret))
        expires = wh.previous_secret_expires_at
        if wh.previous_signing_secret and expires:
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires > datetime.now(timezone.utc):
                keys.append(("previous", wh.previous_signing_secret))
    if not keys and wh.token:
        keys.append(("legacy-token", wh.token))
    return keys


def _expected_signature(secret: str, timestamp: int, raw_body: bytes) -> str:
    return hmac.new(
        secret.encode(),
        f"{timestamp}.".encode() + raw_body,
        hashlib.sha256,
    ).hexdigest()


async def _verify_signature(request: Request, wh: Webhook) -> None:
    """Raise unless the request carries a valid, non-replayed signature."""
    ts_header = request.headers.get("x-lyaotalk-timestamp")
    sig_header = request.headers.get("x-lyaotalk-signature")

    if not (ts_header or sig_header):
        if settings.WEBHOOK_SIGNATURES_REQUIRED:
            raise HTTPException(401, "Webhook signature required")
        if wh.signing_secret:
            logger.warning("webhook_unsigned_delivery id=%s", wh.id)
        return

    if not (ts_header and sig_header):
        raise HTTPException(401, "Incomplete webhook signature")
    try:
        timestamp = int(ts_header)
    except (TypeError, ValueError):
        raise HTTPException(401, "Invalid webhook timestamp")
    if abs(time.time() - timestamp) > WEBHOOK_SIGNATURE_WINDOW_SECONDS:
        raise HTTPException(401, "Webhook timestamp outside window")

    raw_body = await request.body()
    supplied = sig_header.strip().lower().removeprefix("sha256=")

    matched = None
    for label, secret in _signature_keys(wh):
        expected = _expected_signature(secret, timestamp, raw_body)
        if hmac.compare_digest(expected, supplied):
            matched = label
            break
    if not matched:
        raise HTTPException(401, "Invalid webhook signature")
    if matched == "legacy-token":
        logger.warning(
            "webhook_signature_uses_url_token id=%s (rotate to a signing secret)", wh.id
        )

    # Single use of each timestamp, regardless of which key matched.
    try:
        redis_client = await get_redis()
        fresh = await redis_client.set(
            f"webhook:ts:{wh.id}:{timestamp}",
            "1",
            nx=True,
            ex=WEBHOOK_SIGNATURE_WINDOW_SECONDS * 2,
        )
        if not fresh:
            raise HTTPException(409, "Replayed webhook")
    except HTTPException:
        raise
    except Exception:
        # Never turn a Redis outage into a dropped webhook; log and accept.
        logger.warning("webhook_replay_guard_unavailable id=%s", wh.id)


@router.post("/webhooks", response_model=WebhookOut, dependencies=[Depends(get_current_admin)])
async def create_webhook(
    request: Request,
    payload: WebhookCreate,
    db: AsyncSession = Depends(get_db),
):
    """Admin: create a webhook. The signing secret is returned once, here."""
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == payload.conversation_id)
    )).scalar_one_or_none()
    if not conv:
        raise HTTPException(404, "Conversation not found")

    token = secrets.token_urlsafe(32)
    signing_secret = _new_secret()
    wh = Webhook(
        id=gen_uuid(),
        name=payload.name,
        conversation_id=conv.id,
        token=token,
        signing_secret=signing_secret,
    )
    db.add(wh)
    await db.commit()

    await write_audit(
        db,
        actor="admin",
        action="webhook_created",
        target_type="webhook",
        target_id=wh.id,
        detail={"name": payload.name, "conversation_id": conv.id},
        client_ip=get_client_ip(request),
    )

    return WebhookOut(
        id=wh.id,
        name=wh.name,
        conversation_id=conv.id,
        token=token,
        signing_secret=signing_secret,
        url=f"/webhooks/{wh.id}",
    )


@router.get("/webhooks", dependencies=[Depends(get_current_admin)])
async def list_webhooks(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Webhook))
    # Secrets are never listed; rotate returns the new one once.
    now = datetime.now(timezone.utc)
    out = []
    for w in result.scalars().all():
        expires = w.previous_secret_expires_at
        if expires and expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        out.append({
            "id": w.id,
            "name": w.name,
            "conversation_id": w.conversation_id,
            "signed": bool(w.signing_secret),
            "rotation_overlap_until": expires.isoformat() if expires and expires > now else None,
        })
    return out


@router.post(
    "/webhooks/{webhook_id}/rotate-secret",
    response_model=WebhookRotateOut,
    dependencies=[Depends(get_current_admin)],
)
async def rotate_webhook_secret(
    request: Request,
    webhook_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Admin: issue a new signing secret, keeping the old one valid for a day."""
    wh = (await db.execute(
        select(Webhook).where(Webhook.id == webhook_id)
    )).scalar_one_or_none()
    if not wh:
        raise HTTPException(404, "Webhook not found")

    expires_at = datetime.now(timezone.utc) + timedelta(seconds=ROTATION_OVERLAP_SECONDS)
    wh.previous_signing_secret = wh.signing_secret
    wh.previous_secret_expires_at = expires_at if wh.signing_secret else None
    wh.signing_secret = _new_secret()
    await db.commit()

    await write_audit(
        db,
        actor="admin",
        action="webhook_secret_rotated",
        target_type="webhook",
        target_id=wh.id,
        detail={"previous_valid_until": expires_at.isoformat()},
        client_ip=get_client_ip(request),
    )
    return WebhookRotateOut(
        id=wh.id,
        signing_secret=wh.signing_secret,
        previous_secret_expires_at=expires_at,
    )


@router.delete("/webhooks/{webhook_id}", dependencies=[Depends(get_current_admin)])
async def delete_webhook(
    request: Request,
    webhook_id: str,
    db: AsyncSession = Depends(get_db),
):
    wh = (await db.execute(
        select(Webhook).where(Webhook.id == webhook_id)
    )).scalar_one_or_none()
    if not wh:
        raise HTTPException(404, "Webhook not found")
    wh_name = wh.name
    wh_conv = wh.conversation_id
    await db.delete(wh)
    await db.commit()
    await write_audit(
        db,
        actor="admin",
        action="webhook_deleted",
        target_type="webhook",
        target_id=webhook_id,
        detail={"name": wh_name, "conversation_id": wh_conv},
        client_ip=get_client_ip(request),
    )
    return {"ok": True}


async def _handle_webhook(
    request: Request,
    webhook_id: str,
    path_token: Optional[str],
    payload: WebhookPost,
    db: AsyncSession,
) -> dict:
    wh = (await db.execute(
        select(Webhook).where(Webhook.id == webhook_id)
    )).scalar_one_or_none()

    # Prefer the Authorization header; accept the legacy path token as well.
    supplied_token = path_token
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        supplied_token = auth_header[7:].strip()
    elif not supplied_token:
        supplied_token = request.headers.get("x-lyaotalk-token")

    stored_token = getattr(wh, "token", None) if wh else None
    if (
        not wh
        or not isinstance(stored_token, str)
        or not stored_token
        or not isinstance(supplied_token, str)
        or not supplied_token
        or not secrets.compare_digest(stored_token, supplied_token)
    ):
        # Constant-error response: don't leak whether the id exists.
        raise HTTPException(401, "Invalid webhook")

    if path_token:
        logger.debug("webhook_legacy_path_token id=%s", wh.id)

    await _verify_signature(request, wh)

    # Verify the conversation still exists. Without this, a webhook whose
    # conversation was deleted fails at Message FK insert with a 500; admins
    # should reap dead webhooks but in the meantime we 410 cleanly.
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == wh.conversation_id)
    )).scalar_one_or_none()
    if not conv:
        raise HTTPException(410, "Webhook conversation no longer exists")

    # Sanitize display fields - webhooks are public-internet-facing, so the
    # username and emoji come from arbitrary external services. Strip control
    # characters that could mangle UI rendering, log files, or pollute the
    # synthetic sender_jid (which downstream layers might split on ':' or '/').
    def _strip_controls(s: str) -> str:
        return "".join(c for c in s if ord(c) >= 0x20 and ord(c) != 0x7F)

    raw_username = (payload.username or wh.name or "webhook")
    sender_name = _strip_controls(raw_username)[:64].strip() or "webhook"
    sender_jid_safe = sender_name.replace(":", "_").replace("/", "_").replace("@", "_")

    body = _strip_controls(payload.message)[:4096]
    if payload.icon_emoji:
        emoji = _strip_controls(payload.icon_emoji)[:32]
        body = f"{emoji} {body}" if emoji else body

    msg = Message(
        id=gen_uuid(),
        conversation_id=wh.conversation_id,
        sender_jid=f"webhook:{sender_jid_safe}",
        body=body,
        direction="in",
        status="delivered",
    )
    db.add(msg)
    await db.commit()

    client_ip = get_client_ip(request) or "?"
    logger.info(
        "webhook_triggered id=%s conv=%s sender=%r ip=%s body_len=%d",
        webhook_id, wh.conversation_id, sender_name, client_ip, len(body),
    )
    return {"status": "ok"}


@router.post("/webhooks/{webhook_id}", include_in_schema=False)
@limiter.limit("60/minute")
async def trigger_webhook_header_auth(
    request: Request,
    webhook_id: str,
    payload: WebhookPost,
    db: AsyncSession = Depends(get_db),
):
    """Preferred form: token in the Authorization header, never in a URL."""
    return await _handle_webhook(request, webhook_id, None, payload, db)


@router.post("/webhooks/{webhook_id}/{token}", include_in_schema=False)
@limiter.limit("60/minute")
async def trigger_webhook(
    request: Request,
    webhook_id: str,
    token: str,
    payload: WebhookPost,
    db: AsyncSession = Depends(get_db),
):
    """Legacy form: token in the path. Kept for existing integrations."""
    return await _handle_webhook(request, webhook_id, token, payload, db)

