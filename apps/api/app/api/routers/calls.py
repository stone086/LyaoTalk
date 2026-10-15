"""Call history endpoints."""
from datetime import datetime
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import CallLog, gen_uuid
from app.utils.security import get_current_user

router = APIRouter()


class CallLogRecord(BaseModel):
    peer_jid: str
    direction: Literal["incoming", "outgoing"]
    media_types: Literal["audio", "video", "audio,video"]
    status: Literal["answered", "missed", "declined", "failed"]
    duration_seconds: Optional[int] = None
    started_at: datetime
    ended_at: Optional[datetime] = None


class CallLogOut(CallLogRecord):
    id: str


@router.post("/calls/log", response_model=CallLogOut)
async def log_call(
    record: CallLogRecord,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    # Reject implausible timestamps. Without this, a malicious or buggy
    # client could fill the call log with year-2099 entries that pin to the
    # top of "history" forever, or year-1970 entries that hide records.
    from datetime import timedelta, timezone
    now = datetime.now(timezone.utc)
    started_at = record.started_at
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    if abs((now - started_at).total_seconds()) > 86400 * 7:
        raise HTTPException(status_code=400, detail="started_at must be within ±7 days")
    ended_at = record.ended_at
    if ended_at is not None:
        if ended_at.tzinfo is None:
            ended_at = ended_at.replace(tzinfo=timezone.utc)
        if ended_at < started_at:
            raise HTTPException(status_code=400, detail="ended_at must be >= started_at")
        if (ended_at - started_at).total_seconds() > 86400:
            raise HTTPException(status_code=400, detail="Call duration > 24h is not allowed")
    # Clamp the persisted duration_seconds to a sane range too
    duration = record.duration_seconds
    if duration is not None and (duration < 0 or duration > 86400):
        raise HTTPException(status_code=400, detail="duration_seconds out of range")

    log = CallLog(
        id=gen_uuid(),
        account_id=user["account_id"],
        peer_jid=record.peer_jid,
        direction=record.direction,
        media_types=record.media_types,
        status=record.status,
        duration_seconds=duration,
        started_at=started_at,
        ended_at=ended_at,
    )
    db.add(log)
    await db.commit()
    await db.refresh(log)
    return CallLogOut(
        id=log.id,
        peer_jid=log.peer_jid,
        direction=log.direction,
        media_types=log.media_types,
        status=log.status,
        duration_seconds=log.duration_seconds,
        started_at=log.started_at,
        ended_at=log.ended_at,
    )


@router.get("/calls/history", response_model=List[CallLogOut])
async def call_history(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=100_000),
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(CallLog)
        .where(CallLog.account_id == user["account_id"])
        .order_by(desc(CallLog.started_at))
        .offset(offset)
        .limit(limit)
    )
    return [
        CallLogOut(
            id=call.id,
            peer_jid=call.peer_jid,
            direction=call.direction,
            media_types=call.media_types,
            status=call.status,
            duration_seconds=call.duration_seconds,
            started_at=call.started_at,
            ended_at=call.ended_at,
        )
        for call in result.scalars()
    ]


@router.delete("/calls/log/{log_id}")
async def delete_call_log(
    log_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    log = (
        await db.execute(
            select(CallLog).where(
                CallLog.id == log_id,
                CallLog.account_id == user["account_id"],
            )
        )
    ).scalar_one_or_none()
    if not log:
        raise HTTPException(status_code=404, detail="Call log not found")
    await db.delete(log)
    await db.commit()
    return {"status": "deleted"}
