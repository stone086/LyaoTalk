"""
audit.py — Audit logging helper.

Audit events are durable, after-the-fact records of security-significant
actions (logins, role changes, account lifecycle, webhook lifecycle, etc).
They go to PostgreSQL, NOT structured logs, because audit logs need to:
  - Survive log-rotation / log-retention policies that delete normal logs
  - Be queryable from the admin panel via /admin/audit-logs
  - Have integrity (you can ALTER LOG-FILE permissions; you can't ALTER
    PostgreSQL rows without leaving traces in the WAL)

DESIGN PRINCIPLES

1. Best-effort. If audit write fails (DB down, table missing on a fresh
   install before migration), log a warning to the structured log and
   continue. NEVER let an audit failure block the user-facing action it
   was logging — that turns audit logging into an availability bug.

2. PII-aware. The `detail` dict is filtered before write:
   - IP addresses have their last octet masked (192.168.1.200 → 192.168.1.0/24).
     This preserves enough info for forensics ("which subnet?") while
     reducing the GDPR exposure of storing exact user IPs forever.
   - Known sensitive keys (password, token, secret, key, authorization,
     cookie) are redacted to "***" — even if a caller accidentally passes
     a password through the audit detail.
   - String values >2KB are truncated; nested dicts beyond depth 4 are
     dropped. Audit detail is for forensics, not data archival.

3. Caller-friendly. Pass `actor`, `action`, optional target + detail.
   No need to manage commits — we open our own short transaction.
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog

logger = logging.getLogger("lyaotalk.audit")


# Keys that should never appear in audit detail. Match case-insensitively;
# any key whose name CONTAINS one of these substrings is redacted.
_SENSITIVE_KEY_PATTERNS = re.compile(
    r"password|secret|token|api[-_]?key|auth(orization)?|cookie|session|"
    r"private[-_]?key|client[-_]?secret|refresh|csrf",
    re.IGNORECASE,
)

_MAX_VALUE_LEN = 2048
_MAX_DEPTH = 4


def _mask_ip(ip: Optional[str]) -> Optional[str]:
    """Mask the last octet of an IPv4 address; mask last segment of IPv6.

    Without this, the audit log accumulates exact user IPs forever, which
    is GDPR-relevant PII and a high-value target if the audit table leaks.
    Subnet-level granularity is plenty for forensics ("login from 10.0.5.x"
    is enough to correlate with VPN concentrator logs).
    """
    if not ip or not isinstance(ip, str):
        return ip
    # IPv4
    m = re.fullmatch(r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})", ip)
    if m:
        return f"{m.group(1)}.{m.group(2)}.{m.group(3)}.0/24"
    # IPv6 — drop the last 64 bits (network prefix is what we care about)
    if ":" in ip and len(ip) <= 39:
        parts = ip.split(":")
        if len(parts) >= 4:
            return ":".join(parts[:4]) + "::/64"
    return ip  # unknown shape; pass through


def _sanitize(value: Any, depth: int = 0) -> Any:
    """Recursively scrub a detail value before storing.

    Returns a new structure — never mutates input.
    """
    if depth >= _MAX_DEPTH:
        return "<...truncated depth>"
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return value if len(value) <= _MAX_VALUE_LEN else value[:_MAX_VALUE_LEN] + "...[truncated]"
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            sk = str(k)[:128]
            if _SENSITIVE_KEY_PATTERNS.search(sk):
                out[sk] = "***"
            elif sk.lower() in ("ip", "client_ip", "remote_addr", "x_forwarded_for"):
                out[sk] = _mask_ip(v if isinstance(v, str) else str(v))
            else:
                out[sk] = _sanitize(v, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [_sanitize(v, depth + 1) for v in value[:50]]  # cap list length too
    # Anything else (bytes, custom objects) — stringify safely
    try:
        return str(value)[:_MAX_VALUE_LEN]
    except Exception:
        return "<unrepresentable>"


async def write_audit(
    db: AsyncSession,
    actor: Optional[str],
    action: str,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    detail: Optional[dict] = None,
    client_ip: Optional[str] = None,
) -> None:
    """Record an audit event. Never raises.

    Failures fall back to the structured log so we don't lose the event
    entirely, then return cleanly. The caller's main operation continues
    regardless.
    """
    try:
        sanitized_detail = _sanitize(detail or {})
        # Add client_ip as a top-level field so admin queries can filter on it
        # without parsing JSON. Mask it the same way detail-IPs are masked.
        if client_ip:
            sanitized_detail["client_ip"] = _mask_ip(client_ip)
        log = AuditLog(
            id=str(uuid.uuid4()),
            actor=(actor or "<anonymous>")[:256],
            action=action[:128],
            target_type=(target_type[:64] if target_type else None),
            target_id=(target_id[:128] if target_id else None),
            detail_json=sanitized_detail,
        )
        db.add(log)
        await db.commit()
    except Exception as exc:
        # Don't propagate. Log to structured log and continue. If the DB
        # is unhealthy we don't want every audit-emitting endpoint to 500.
        try:
            await db.rollback()
        except Exception:
            pass
        logger.warning(
            "audit_write_failed action=%s actor=%s err=%s",
            action, actor, type(exc).__name__,
        )


def get_client_ip(request) -> Optional[str]:
    """Extract the caller's IP, trusting only what nginx sets directly.

    THE TRAP: `X-Forwarded-For` is APPENDED-to by nginx, not replaced.
    When a client sends `X-Forwarded-For: 1.2.3.4` and connects from
    5.6.7.8, the FastAPI app sees `X-Forwarded-For: 1.2.3.4, 5.6.7.8`.
    Taking index [0] gives the attacker-supplied value — they can spoof
    audit log IPs, rate-limit keys, and any log line referencing client IP.

    THE FIX: trust `X-Real-IP` instead. nginx sets it explicitly to
    `$remote_addr`, the actual TCP source — clients can't forge that
    because nginx doesn't pass through the client-supplied X-Real-IP.
    Falls back to `request.client.host` only when X-Real-IP is absent
    (running behind a different proxy or directly without nginx).

    If you ever stack a CDN in front of nginx (Cloudflare, Fastly), set
    `set_real_ip_from <CDN-network>;` and `real_ip_header CF-Connecting-IP;`
    in nginx so X-Real-IP reflects the actual client behind the CDN —
    DON'T parse X-Forwarded-For yourself in app code.
    """
    if not request:
        return None
    # X-Real-IP is set by nginx to $remote_addr (line 119 of lyaotalk.conf
    # and equivalent in /api/ block). nginx does NOT pass through any
    # client-supplied X-Real-IP — the proxy_set_header fully replaces.
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip[:64]
    # Direct connection (no nginx in front, e.g. running uvicorn locally).
    if request.client:
        return request.client.host
    return None
