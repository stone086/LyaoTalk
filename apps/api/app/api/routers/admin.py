import asyncio
import socket

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.core.database import get_db
from app.models import AuditLog, Account, Message, Attachment
from app.core.config import settings
from app.core.version import get_app_version
from app.utils.security import get_current_admin
from app.api.routers.metrics import web_vitals_summary as get_web_vitals_summary
from minio import Minio
import redis.asyncio as redis

# All endpoints in this router require an admin JWT.
# Without this, anyone could enumerate audit logs (IPs, failed login attempts),
# pull system stats, probe service health, etc.
router = APIRouter(dependencies=[Depends(get_current_admin)])
APP_VERSION = get_app_version()


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
        minio_ok = bool(minio_client.bucket_exists(settings.MINIO_BUCKET))
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
