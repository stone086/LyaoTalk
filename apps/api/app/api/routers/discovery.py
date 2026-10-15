"""
discovery.py - Public group discovery + server health badges.

Endpoints:
  GET /discovery/groups   - List public groups (those marked as public by admin)
  GET /discovery/health   - Server health badge (uptime, latency, version)

The discovery directory is opt-in per group. Groups marked private don't appear.
Admins can curate which groups to expose via the admin panel.
"""
from typing import List, Optional
from datetime import datetime, timedelta, timezone
import time

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.rate_limit import limiter
from app.core.version import APP_VERSION

router = APIRouter()
UTC = timezone.utc

_server_start_time = time.time()


class PublicGroup(BaseModel):
    jid: str
    name: str
    description: Optional[str] = None
    member_count: int
    last_active: Optional[str] = None


class ServerHealth(BaseModel):
    version: str
    uptime_seconds: int
    uptime_human: str
    user_count: int
    message_count_30d: int
    avg_response_ms: int


@router.get("/discovery/groups", response_model=List[PublicGroup])
@limiter.limit("30/minute")
async def list_public_groups(request: Request, db: AsyncSession = Depends(get_db)):
    """
    List groups that have been explicitly marked as discoverable.

    Until the dedicated PublicGroupListing table is built, this returns
    an empty list. Previously this endpoint returned ALL groups regardless
    of privacy, which leaked private group JIDs to any unauthenticated
    caller (information disclosure: company chat names, project codenames,
    etc. exposed in the response). Returning [] is the safe default — better
    no directory than a leaky one.
    """
    return []


@router.get("/discovery/health", response_model=ServerHealth)
@limiter.limit("60/minute")
async def server_health_badge(request: Request, db: AsyncSession = Depends(get_db)):
    """
    Public health stats. Shows on the login page so users can decide
    whether the server is reliable.

    Rate-limited to prevent abuse for monitoring server load patterns
    (an attacker could scrape this to time DoS attacks during low-traffic
    windows). User and message counts are returned in coarse buckets to
    blunt growth-tracking.
    """
    from app.models import Account, Message
    started = time.perf_counter()
    uptime_s = int(time.time() - _server_start_time)
    days = uptime_s // 86400
    hours = (uptime_s % 86400) // 3600
    mins = (uptime_s % 3600) // 60
    if days:
        uptime_human = f"{days}d {hours}h"
    elif hours:
        uptime_human = f"{hours}h {mins}m"
    else:
        uptime_human = f"{mins}m"

    user_count = (await db.execute(select(func.count(Account.id)))).scalar() or 0

    cutoff = datetime.now(UTC) - timedelta(days=30)
    msg_count = (await db.execute(
        select(func.count(Message.id)).where(Message.created_at >= cutoff)
    )).scalar() or 0

    # Bucket exact counts to blunt monitoring/competitive intelligence —
    # exact values aren't needed for a "is this server alive" badge.
    def bucket(n: int) -> int:
        if n < 10: return n  # small values shown precisely
        if n < 100: return (n // 10) * 10
        if n < 1000: return (n // 50) * 50
        if n < 10000: return (n // 500) * 500
        return (n // 5000) * 5000

    elapsed_ms = max(1, int((time.perf_counter() - started) * 1000))

    return ServerHealth(
        version=APP_VERSION,
        uptime_seconds=uptime_s,
        uptime_human=uptime_human,
        user_count=bucket(user_count),
        message_count_30d=bucket(msg_count),
        avg_response_ms=elapsed_ms,
    )
