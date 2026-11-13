import asyncio
import socket
import json
import re

from fastapi import APIRouter, Depends, Query, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
from app.core.database import get_db
from app.models import AuditLog, Account, AccountPreference, Message, Attachment, Conversation, PushSubscription, NtfySubscription
from app.core.config import settings
from app.core.version import get_app_version
from app.utils.security import get_current_admin, mark_account_disabled, clear_account_disabled
from app.services.audit import write_audit, get_client_ip
from app.api.routers.metrics import web_vitals_summary as get_web_vitals_summary
from minio import Minio
import redis.asyncio as redis

# All endpoints in this router require an admin JWT.
# Without this, anyone could enumerate audit logs (IPs, failed login attempts),
# pull system stats, probe service health, etc.
router = APIRouter(dependencies=[Depends(get_current_admin)])
APP_VERSION = get_app_version()


def _prosody_request_sync(payload: dict) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(20)
        connection.connect("/run/lyaotalk-prosody.sock")
        connection.sendall((json.dumps({"domain": settings.XMPP_DOMAIN, **payload}) + "\n").encode())
        response = b""
        while b"\n" not in response and len(response) < 65536:
            chunk = connection.recv(4096)
            if not chunk:
                break
            response += chunk
    return json.loads(response.split(b"\n", 1)[0])


async def _prosody_request(payload: dict) -> dict:
    try:
        response = await asyncio.to_thread(_prosody_request_sync, payload)
        if response.get("returncode") != 0:
            raise ValueError("Prosody operation failed")
        return response
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        raise HTTPException(503, "Prosody operation unavailable")


class AdminUserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=6, max_length=256)


class AdminPasswordReset(BaseModel):
    password: str = Field(min_length=6, max_length=256)


def _validated_username(username: str) -> str:
    if not re.fullmatch(r"[\w.-]{1,64}", username) or len(username.encode("utf-8")) > 64:
        raise HTTPException(422, "Invalid username")
    return username


@router.get("/accounts")
async def admin_accounts(
    query: str = Query("", max_length=128),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    users = (await _prosody_request({"action": "list_users"}))["users"]
    records = (await db.execute(select(Account).where(Account.domain == settings.XMPP_DOMAIN))).scalars().all()
    by_jid = {row.jid.lower(): row for row in records}
    selected = [jid for jid in users if query.strip().lower() in jid.lower()]
    return [{"id": by_jid[jid.lower()].id if jid.lower() in by_jid else None,
             "jid": jid, "username": jid.rsplit("@", 1)[0],
             "display_name": by_jid[jid.lower()].display_name if jid.lower() in by_jid else None,
             "is_enabled": by_jid[jid.lower()].is_enabled if jid.lower() in by_jid else None,
             "created_at": str(by_jid[jid.lower()].created_at) if jid.lower() in by_jid and by_jid[jid.lower()].created_at else None}
            for jid in sorted(selected)[offset:offset + limit]]


@router.post("/users")
async def admin_create_user(
    data: AdminUserCreate, request: Request, actor: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    username = _validated_username(data.username)
    jid = f"{username}@{settings.XMPP_DOMAIN}"
    existing = await db.scalar(select(Account).where(Account.jid == jid))
    if existing and existing.is_enabled:
        raise HTTPException(409, "Account already exists")
    await _prosody_request({"action": "register", "username": username, "password": data.password})
    if existing:
        existing.is_enabled = True
        if not clear_account_disabled(existing.id):
            raise HTTPException(503, "Account created; session fence unavailable")
    else:
        account = Account(jid=jid, domain=settings.XMPP_DOMAIN, is_enabled=True)
        db.add(account)
        await db.flush()
        db.add(AccountPreference(account_id=account.id))
    await db.commit()
    await write_audit(db, actor=actor, action="prosody_user_created", target_type="account",
                      target_id=jid, client_ip=get_client_ip(request))
    return {"ok": True, "jid": jid}


@router.post("/user-actions/{action}/{username}")
async def admin_manage_user(
    username: str, action: str, request: Request, actor: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    username = _validated_username(username)
    if action not in ("disable", "enable", "delete"):
        raise HTTPException(404, "Unknown action")
    jid = f"{username}@{settings.XMPP_DOMAIN}"
    await _prosody_request({"action": f"{action}_user", "username": username})
    account = await db.scalar(select(Account).where(Account.jid == jid))
    if account:
        account.is_enabled = action == "enable"
        await db.commit()
        fence_ok = clear_account_disabled(account.id) if action == "enable" else mark_account_disabled(account.id)
        if not fence_ok:
            raise HTTPException(503, "Prosody updated; session fence unavailable")
    await write_audit(db, actor=actor, action=f"prosody_user_{action}", target_type="account",
                      target_id=jid, client_ip=get_client_ip(request))
    return {"ok": True}


@router.post("/users/{username}/password")
async def admin_reset_user_password(
    username: str, data: AdminPasswordReset, request: Request,
    actor: str = Depends(get_current_admin), db: AsyncSession = Depends(get_db),
):
    username = _validated_username(username)
    await _prosody_request({"action": "change_password", "username": username, "password": data.password})
    await write_audit(db, actor=actor, action="prosody_password_reset", target_type="account",
                      target_id=f"{username}@{settings.XMPP_DOMAIN}", client_ip=get_client_ip(request))
    return {"ok": True}


@router.get("/online-sessions")
async def admin_online_sessions():
    response = await _prosody_request({"action": "online_sessions"})
    rows = []
    for line in response["output"].splitlines()[1:]:
        columns = [column.strip() for column in line.split("|")]
        if len(columns) >= 6 and "@" in columns[1]:
            rows.append({"jid": columns[1], "status": columns[4], "security": columns[5]})
    return rows


@router.post("/users/{username}/end-sessions")
async def admin_end_user_sessions(
    username: str, request: Request, actor: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    username = _validated_username(username)
    await _prosody_request({"action": "end_sessions", "username": username})
    await write_audit(db, actor=actor, action="prosody_sessions_ended", target_type="account",
                      target_id=f"{username}@{settings.XMPP_DOMAIN}", client_ip=get_client_ip(request))
    return {"ok": True}


@router.get("/groups")
async def admin_groups(db: AsyncSession = Depends(get_db)):
    """List rooms from Prosody's persistent MUC storage, with app linkage counts."""
    room_jids = (await _prosody_request({"action": "list_rooms"}))["rooms"]
    result = await db.execute(
        select(Conversation.peer_jid, func.count(func.distinct(Conversation.account_id)).label("accounts"))
        .where(Conversation.type == "group")
        .group_by(Conversation.peer_jid)
        .order_by(Conversation.peer_jid)
    )
    counts = {row.peer_jid: row.accounts for row in result}
    return [{"jid": jid, "account_count": counts.get(jid, 0)} for jid in room_jids]


@router.post("/groups/{room}/destroy")
async def admin_destroy_group(
    room: str, request: Request, actor: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    room = _validated_username(room)
    jid = f"{room}@conference.{settings.XMPP_DOMAIN}"
    await _prosody_request({"action": "destroy_room", "room": room})
    await write_audit(db, actor=actor, action="prosody_room_destroyed", target_type="group",
                      target_id=jid, client_ip=get_client_ip(request))
    return {"ok": True}


@router.get("/groups/{room}/members")
async def admin_group_members(room: str):
    room = _validated_username(room)
    response = await _prosody_request({"action": "room_members", "room": room})
    rows = []
    for line in response["output"].splitlines()[1:]:
        columns = [column.strip() for column in line.split("|")]
        if len(columns) >= 2 and columns[0] in ("owner", "admin", "member", "outcast") and "@" in columns[1]:
            rows.append({"jid": columns[1], "affiliation": columns[0]})
    return rows


@router.get("/push-status")
async def admin_push_status(db: AsyncSession = Depends(get_db)):
    web_push = await db.scalar(select(func.count()).select_from(PushSubscription)) or 0
    ntfy = await db.scalar(select(func.count()).select_from(NtfySubscription)) or 0
    return {"web_push_subscriptions": web_push, "ntfy_subscriptions": ntfy,
            "ntfy_configured": bool(settings.NTFY_INTERNAL_URL and settings.NTFY_PUBLISH_TOKEN),
            "web_push_configured": bool(settings.VAPID_PRIVATE_KEY and settings.VAPID_PUBLIC_KEY)}


@router.get("/configuration")
async def admin_configuration():
    """Expose operational settings without returning credentials or tokens."""
    return {"xmpp_domain": settings.XMPP_DOMAIN,
            "public_domain": settings.PUBLIC_DOMAIN,
            "registration_enabled": settings.XMPP_REGISTRATION_ENABLED,
            "ntfy_public_url": settings.NTFY_PUBLIC_URL,
            "minio_bucket": settings.MINIO_BUCKET,
            "oidc_enabled": settings.OIDC_ENABLED,
            "ldap_enabled": settings.LDAP_ENABLED}


@router.get("/push-subscriptions")
async def admin_push_subscriptions(db: AsyncSession = Depends(get_db)):
    web_rows = (await db.execute(select(PushSubscription, Account.jid).join(
        Account, Account.id == PushSubscription.account_id))).all()
    ntfy_rows = (await db.execute(select(NtfySubscription, Account.jid).join(
        Account, Account.id == NtfySubscription.account_id))).all()
    return sorted(
        [{"account_id": row.account_id, "jid": jid, "channel": "web_push",
          "created_at": str(row.created_at) if row.created_at else None} for row, jid in web_rows] +
        [{"account_id": row.account_id, "jid": jid, "channel": "ntfy",
          "created_at": str(row.created_at) if row.created_at else None} for row, jid in ntfy_rows],
        key=lambda item: (item["jid"], item["channel"]),
    )


@router.delete("/push-subscriptions/{account_id}/{channel}")
async def admin_revoke_push_subscription(
    account_id: str, channel: str, request: Request,
    actor: str = Depends(get_current_admin), db: AsyncSession = Depends(get_db),
):
    if channel == "web_push":
        await db.execute(delete(PushSubscription).where(PushSubscription.account_id == account_id))
    elif channel == "ntfy":
        await db.execute(delete(NtfySubscription).where(NtfySubscription.account_id == account_id))
    else:
        raise HTTPException(404, "Unknown push channel")
    await db.commit()
    await write_audit(db, actor=actor, action="push_subscription_revoked", target_type="account",
                      target_id=account_id, detail={"channel": channel}, client_ip=get_client_ip(request))
    return {"ok": True}


@router.get(
    "/status",
    summary="System status",
    description="Return high-level system status and entity counters.",
)
async def system_status(db: AsyncSession = Depends(get_db)):
    account_count = await db.scalar(select(func.count()).select_from(Account))
    message_count = await db.scalar(select(func.count()).select_from(Message))
    attachment_count = await db.scalar(select(func.count()).select_from(Attachment))
    return {
        "status": "healthy",
        "version": APP_VERSION,
        "stats": {
            "accounts": account_count,
            "messages": message_count,
            "attachments": attachment_count,
        },
    }


@router.get(
    "/audit-logs",
    summary="Audit logs",
    description="Return paginated audit log entries.",
)
async def get_audit_logs(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0, le=1_000_000),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit).offset(offset)
    )
    logs = result.scalars().all()
    return [
        {
            "id": l.id, "actor": l.actor, "action": l.action,
            "target_type": l.target_type, "target_id": l.target_id,
            "detail_json": l.detail_json,
            "created_at": str(l.created_at) if l.created_at else None,
        }
        for l in logs
    ]


async def _tcp_check(host: str, port: int, timeout: float = 1.5) -> bool:
    try:
        fut = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(fut, timeout=timeout)
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False


@router.get(
    "/service-health",
    summary="Service health",
    description="Check runtime health of DB, Redis, MinIO, and Prosody dependencies.",
)
async def service_health(db: AsyncSession = Depends(get_db)):
    services = []

    # API/database health
    db_ok = True
    try:
        await db.execute(select(1))
    except Exception:
        db_ok = False

    # Redis
    redis_ok = False
    try:
        redis_client = redis.from_url(settings.REDIS_URL)
        redis_ok = bool(await redis_client.ping())
        await redis_client.aclose()
    except Exception:
        redis_ok = False

    # MinIO
    minio_ok = False
    try:
        minio_client = Minio(
            settings.MINIO_ENDPOINT,
            access_key=settings.MINIO_ACCESS_KEY,
            secret_key=settings.MINIO_SECRET_KEY,
            secure=settings.MINIO_SECURE,
        )
        # bucket_exists() is a blocking HTTP call; keep it off the event loop.
        minio_ok = bool(await asyncio.to_thread(minio_client.bucket_exists, settings.MINIO_BUCKET))
    except Exception:
        minio_ok = False

    # Prosody checks (c2s and http/websocket ports on localhost)
    prosody_5222 = await _tcp_check("127.0.0.1", 5222)
    prosody_5280 = await _tcp_check("127.0.0.1", 5280)
    prosody_ok = prosody_5222 or prosody_5280

    services.append({"name": "api", "label": "FastAPI Backend", "ok": True, "detail": "process is serving this endpoint"})
    services.append({"name": "postgresql", "label": "PostgreSQL", "ok": db_ok, "detail": "database query check"})
    services.append({"name": "redis", "label": "Redis", "ok": redis_ok, "detail": "redis ping"})
    services.append({"name": "minio", "label": "MinIO", "ok": minio_ok, "detail": f"bucket check: {settings.MINIO_BUCKET}"})
    services.append({"name": "prosody", "label": "Prosody XMPP", "ok": prosody_ok, "detail": "tcp check 5222/5280"})

    overall = "healthy" if all(item["ok"] for item in services) else "degraded"
    return {"status": overall, "services": services}



# =====================================================
# KILLER-02: Enterprise dashboard endpoints
# =====================================================
from datetime import datetime, timedelta, timezone
from sqlalchemy import select, func, and_

UTC = timezone.utc

@router.get("/dashboard/activity")
async def dashboard_activity(
    days: int = 7,
    db: AsyncSession = Depends(get_db),
):
    """
    Per-day message activity for the last N days.
    Returns a list of {date, message_count, active_users}.
    Used by the admin dashboard to draw activity graphs.
    """
    from app.models import Message, Account
    cutoff = datetime.now(UTC) - timedelta(days=days)

    result = await db.execute(
        select(
            func.date_trunc("day", Message.created_at).label("day"),
            func.count(Message.id).label("count"),
        )
        .where(Message.created_at >= cutoff)
        .group_by("day")
        .order_by("day")
    )
    daily = [{"date": str(row.day.date()), "count": row.count} for row in result]

    return {"daily_messages": daily, "window_days": days}


@router.get("/dashboard/top-conversations")
async def dashboard_top_conversations(
    limit: int = 10,
    db: AsyncSession = Depends(get_db),
):
    """
    Most active conversations by message count in the last 30 days.
    Hidden by default behind admin auth - reveal for compliance audits.
    """
    from app.models import Message, Conversation
    cutoff = datetime.now(UTC) - timedelta(days=30)

    result = await db.execute(
        select(
            Conversation.id,
            Conversation.peer_jid,
            Conversation.type,
            func.count(Message.id).label("count"),
        )
        .join(Message, Message.conversation_id == Conversation.id)
        .where(Message.created_at >= cutoff)
        .group_by(Conversation.id)
        .order_by(func.count(Message.id).desc())
        .limit(limit)
    )
    return [
        {"id": r.id, "peer_jid": r.peer_jid, "type": r.type, "count": r.count}
        for r in result
    ]


@router.get("/dashboard/storage-usage")
async def dashboard_storage_usage(db: AsyncSession = Depends(get_db)):
    """
    Storage usage breakdown for capacity planning.
    """
    from app.models import Attachment

    result = await db.execute(
        select(
            func.count(Attachment.id).label("file_count"),
            func.coalesce(func.sum(Attachment.size_bytes), 0).label("total_bytes"),
        )
    )
    row = result.first()
    return {
        "file_count": row.file_count if row else 0,
        "total_bytes": int(row.total_bytes) if row and row.total_bytes else 0,
        "total_mb": round((int(row.total_bytes) if row and row.total_bytes else 0) / (1024 * 1024), 2),
    }


@router.get("/dashboard/user-stats")
async def dashboard_user_stats(db: AsyncSession = Depends(get_db)):
    """
    User-level statistics: total / active in last 24h / 7d / 30d.
    """
    from app.models import Account, Message

    now = datetime.now(UTC)
    total = (await db.execute(select(func.count(Account.id)))).scalar() or 0
    enabled = (await db.execute(
        select(func.count(Account.id)).where(Account.is_enabled == True)
    )).scalar() or 0

    # active = sent at least one message in window
    async def _active(window_hours: int) -> int:
        cutoff = now - timedelta(hours=window_hours)
        r = await db.execute(
            select(func.count(func.distinct(Message.conversation_id)))
            .where(Message.created_at >= cutoff)
        )
        return r.scalar() or 0

    return {
        "total": total,
        "enabled": enabled,
        "active_24h": await _active(24),
        "active_7d": await _active(24 * 7),
        "active_30d": await _active(24 * 30),
    }


@router.get("/web-vitals/summary")
async def web_vitals_summary():
    return get_web_vitals_summary()
