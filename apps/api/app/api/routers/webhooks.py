"""
webhooks.py - Inbound webhook endpoints.

External services can POST messages into a LyaoTalk conversation:
  POST /webhooks/{webhook_id}
  {
    "message": "Build #1234 succeeded on main",
    "username": "ci-bot",         # display name for this message
    "icon_emoji": ":white_check_mark:"  # optional avatar emoji
  }

Each webhook is bound to a specific conversation (group or 1:1).
Admins generate webhooks via the admin panel and share the URL with
the external service (Jenkins, GitLab, Sentry, etc).

Authenticated by the random webhook_id token in the URL itself.
"""
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
import logging

from app.core.rate_limit import limiter

logger = logging.getLogger("lyaotalk.webhooks")
from sqlalchemy import select
from typing import Optional
import secrets

from app.core.database import get_db
from app.models import Webhook, Conversation, Message, gen_uuid
from app.services.audit import write_audit, get_client_ip
from app.utils.security import get_current_admin

router = APIRouter()


class WebhookCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    conversation_id: str = Field(..., min_length=1, max_length=64)


class WebhookOut(BaseModel):
    id: str
    name: str
    conversation_id: str
    token: str
    url: str


class WebhookPost(BaseModel):
    message: str = Field(..., min_length=1, max_length=4096)
    username: Optional[str] = Field(None, max_length=64)
    icon_emoji: Optional[str] = Field(None, max_length=32)


@router.post("/webhooks", response_model=WebhookOut, dependencies=[Depends(get_current_admin)])
async def create_webhook(
    request: Request,
    payload: WebhookCreate,
    db: AsyncSession = Depends(get_db),
):
    """Admin: generate a new inbound webhook URL for a conversation."""
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == payload.conversation_id)
    )).scalar_one_or_none()
    if not conv:
        raise HTTPException(404, "Conversation not found")

    token = secrets.token_urlsafe(32)
    wh_id = gen_uuid()
    wh = Webhook(id=wh_id, name=payload.name, conversation_id=conv.id, token=token)
    db.add(wh)
    await db.commit()

    # Audit creation. Token is NEVER logged (audit layer would redact it
    # anyway, but we don't even pass it). detail records the conversation
    # context so operators can spot suspicious creation patterns.
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
        url=f"/webhooks/{wh.id}/{token}",
    )


@router.get("/webhooks", dependencies=[Depends(get_current_admin)])
async def list_webhooks(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Webhook))
    return [
        {"id": w.id, "name": w.name, "conversation_id": w.conversation_id}
        for w in result.scalars().all()
    ]


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
    return {"status": "deleted"}


@router.post("/webhooks/{webhook_id}/{token}", include_in_schema=False)
@limiter.limit("60/minute")
async def trigger_webhook(
    request: Request,
    webhook_id: str,
    token: str,
    payload: WebhookPost,
    db: AsyncSession = Depends(get_db),
):
    """
    Public endpoint - triggered by external services.
    Authenticated by webhook_id + token combination.
    """
    wh = (await db.execute(
        select(Webhook).where(Webhook.id == webhook_id)
    )).scalar_one_or_none()
    # Defensive: a row with NULL token would crash compare_digest with TypeError,
    # leaking 500 instead of 401. Treat any missing/non-string token as invalid.
    stored_token = getattr(wh, "token", None) if wh else None
    if (
        not wh
        or not isinstance(stored_token, str)
        or not stored_token
        or not isinstance(token, str)
        or not secrets.compare_digest(stored_token, token)
    ):
        # Constant-error response — don't leak whether the ID was found
        raise HTTPException(401, "Invalid webhook")

    # Verify the conversation still exists. Without this, a webhook whose
    # conversation was deleted will fail at Message FK insert with a 500;
    # admins should reap dead webhooks but in the meantime we 410 cleanly.
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == wh.conversation_id)
    )).scalar_one_or_none()
    if not conv:
        raise HTTPException(410, "Webhook conversation no longer exists")

    # Sanitize display fields — webhooks are public-internet-facing, so the
    # username and emoji come from arbitrary external services. Strip control
    # characters that could mangle UI rendering, log files, or pollute the
    # synthetic sender_jid (which downstream layers might split on `:` or `/`).
    def _strip_controls(s: str) -> str:
        return "".join(c for c in s if ord(c) >= 0x20 and ord(c) != 0x7F)

    raw_username = (payload.username or wh.name or "webhook")
    sender_name = _strip_controls(raw_username)[:64].strip() or "webhook"
    # Disallow `:` / `/` in synthetic sender_jid so it can't be confused with a real JID
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

    # Audit the trigger so abuse can be traced. Only log webhook id (not token).
    client_ip = (request.client.host if request.client else "?")
    logger.info(
        "webhook_triggered id=%s conv=%s sender=%r ip=%s body_len=%d",
        webhook_id, wh.conversation_id, sender_name, client_ip, len(body),
    )
    return {"status": "ok"}
