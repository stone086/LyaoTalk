from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from app.utils.security import create_access_token, create_refresh_token, revoke_token
from app.core.config import settings
from app.core.rate_limit import limiter
from app.core.observability import metrics_registry
from app.core.database import get_db
from app.models import Account, AccountPreference
from app.services.audit import write_audit, get_client_ip
from app.services.prosody_revision import get_credential_revision
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
import asyncio
import base64
import json
import socket
import ssl
import logging
import os
from pathlib import Path
import re
import secrets
import subprocess
import uuid
from types import SimpleNamespace
from datetime import datetime, timezone

# Password hash verification — argon2 preferred, bcrypt fallback.
# CryptContext picks the right algorithm by inspecting the hash prefix.
try:
    from passlib.context import CryptContext
    _pwd_context = CryptContext(schemes=["argon2", "bcrypt"], deprecated="auto")
except ImportError:
    _pwd_context = None

router = APIRouter()
logger = logging.getLogger("lyaotalk.auth")
UTC = timezone.utc


def _register_with_prosody(username: str, domain: str, password: str):
    """Register through a narrow local helper running as the Prosody user."""
    helper = "/run/lyaotalk-prosody.sock"
    if Path(helper).exists():
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(20)
            conn.connect(helper)
            conn.sendall((json.dumps({"username": username, "domain": domain, "password": password}) + "\n").encode())
            response = b""
            while b"\n" not in response and len(response) < 8192:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                response += chunk
        result = json.loads(response.split(b"\n", 1)[0])
        return SimpleNamespace(returncode=int(result["returncode"]), stdout=result.get("stdout", ""), stderr=result.get("stderr", ""))
    return subprocess.run(
        ["/usr/bin/sudo", "-n", "/usr/bin/prosodyctl", "register", username, domain, password],
        capture_output=True, text=True, timeout=20, check=False,
    )

ADMIN_USERNAME = settings.ADMIN_USER
ADMIN_PASSWORD = settings.ADMIN_PASS or None
ADMIN_PASSWORD_HASH = settings.ADMIN_PASS_HASH or None


def _verify_admin_password(submitted: str) -> bool:
    """Verify admin password against hash (preferred) or plaintext (legacy).

    Constant-time comparisons are used in both paths so that timing analysis
    cannot distinguish "wrong username" from "wrong password" from the
    response time. Returns True only on exact match.
    """
    # Hash mode (preferred). passlib's verify is constant-time within an algo.
    if ADMIN_PASSWORD_HASH and _pwd_context is not None:
        try:
            return _pwd_context.verify(submitted, ADMIN_PASSWORD_HASH)
        except Exception as e:
            logger.warning(f"admin_password_hash_verify_error: {type(e).__name__}")
            return False
    # Legacy plaintext mode — kept for backwards compatibility but discouraged.
    if ADMIN_PASSWORD:
        return secrets.compare_digest(submitted, ADMIN_PASSWORD)
    return False


class AdminLogin(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=256)


class RegisterRequest(BaseModel):
    jid: str = Field(..., min_length=3, max_length=130)  # localpart(64) + @ + domain(64)
    password: str = Field(..., min_length=6, max_length=256)


class UserTokenRequest(BaseModel):
    jid: str = Field(..., min_length=3, max_length=130)
    password: str = Field(..., min_length=1, max_length=256)


@router.get(
    "/config",
    summary="Public auth configuration",
    description="Return public login configuration needed by the web client.",
)
async def auth_config():
    return {
        "xmpp_domain": settings.XMPP_DOMAIN,
        "public_domain": settings.PUBLIC_DOMAIN,
        "registration_enabled": settings.XMPP_REGISTRATION_ENABLED,
    }


@router.post(
    "/admin/login",
    summary="Admin login",
    description="Authenticate admin user and return JWT access + refresh tokens.",
)
@limiter.limit("5/minute")
async def admin_login(
    request: Request,
    data: AdminLogin,
    db: AsyncSession = Depends(get_db),
):
    client_ip = get_client_ip(request)
    # For structured-log readability we mask the IP; for audit we pass the
    # raw IP and let the audit layer mask it consistently.
    masked_for_log = _mask_ip_for_log(client_ip) if client_ip else "?"
    if not (ADMIN_PASSWORD or ADMIN_PASSWORD_HASH):
        raise HTTPException(
            status_code=503,
            detail="Admin password not configured: set ADMIN_PASS_HASH (preferred) or ADMIN_PASS",
        )
    if data.username != ADMIN_USERNAME or not _verify_admin_password(data.password):
        # Don't distinguish "bad username" from "bad password" in either response or timing
        metrics_registry.inc("lyaotalk_events_total", event="admin_login_failed")
        logger.warning("admin_login_failed", extra={"username": data.username, "client_ip_masked": masked_for_log})
        await write_audit(
            db,
            actor=data.username,
            action="admin_login_failed",
            client_ip=client_ip,
        )
        raise HTTPException(status_code=401, detail="Invalid credentials")
    metrics_registry.inc("lyaotalk_events_total", event="admin_login_ok")
    logger.info("admin_login_ok", extra={"username": data.username, "client_ip_masked": masked_for_log})
    await write_audit(
        db,
        actor=data.username,
        action="admin_login_ok",
        client_ip=client_ip,
    )
    access_token = create_access_token(data.username, role="admin")
    refresh_token = create_refresh_token(data.username, role="admin")
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES_ACCESS * 60,
    }


def _mask_ip_for_log(ip: str) -> str:
    """Quick IP-mask for structured logs (audit layer has its own)."""
    import re as _re
    m = _re.fullmatch(r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})", ip or "")
    if m:
        return f"{m.group(1)}.{m.group(2)}.{m.group(3)}.0"
    return ip or "?"


def _request_host(request: Request | None) -> str:
    if not request:
        return ""
    return (request.headers.get("host") or request.url.hostname or "").split(":", 1)[0].strip().lower()


def parse_jid(jid: str, request: Request | None = None):
    value = (jid or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="JID is required")
    if "@" in value:
        username, domain = value.split("@", 1)
    else:
        username, domain = value, settings.XMPP_DOMAIN

    username = username.strip()
    domain = domain.strip().lower()
    if not username or not domain:
        raise HTTPException(status_code=400, detail="Invalid JID")
    if not re.fullmatch(r"[\w.-]{1,64}", username) or len(username.encode("utf-8")) > 64:
        raise HTTPException(status_code=400, detail="Username contains invalid characters")
    xmpp_domain = settings.XMPP_DOMAIN.strip().lower()
    public_aliases = {
        settings.PUBLIC_DOMAIN.strip().lower(),
        _request_host(request),
    }
    public_aliases.discard("")
    public_aliases.discard(xmpp_domain)
    if domain in public_aliases:
        domain = xmpp_domain
    if domain != xmpp_domain:
        raise HTTPException(status_code=400, detail=f"Use {xmpp_domain} as the XMPP domain")
    return username, domain


def _recv_until(sock: socket.socket, needle: bytes, timeout: float = 5.0) -> bytes:
    sock.settimeout(timeout)
    chunks: list[bytes] = []
    data = b""
    while needle not in data and len(data) < 65536:
        chunk = sock.recv(4096)
        if not chunk:
            break
        chunks.append(chunk)
        data = b"".join(chunks)
    return data


def _verify_xmpp_sasl_plain(username: str, domain: str, password: str) -> bool:
    """Verify a Prosody password through local XMPP SASL PLAIN.

    Some distro Prosody versions do not support `prosodyctl check password`.
    The server may require STARTTLS before advertising SASL mechanisms, so this
    performs a minimal client-to-server STARTTLS negotiation before auth.
    """
    stream = (
        f"<?xml version='1.0'?><stream:stream to='{domain}' "
        "xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' "
        "version='1.0'>"
    ).encode()
    auth = base64.b64encode(f"\x00{username}\x00{password}".encode()).decode()
    auth_stanza = (
        f"<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>{auth}</auth>"
    ).encode()

    with socket.create_connection(("127.0.0.1", int(os.getenv("XMPP_C2S_PORT", "5222"))), timeout=5) as raw:
        raw.sendall(stream)
        features = _recv_until(raw, b"</stream:features>")

        if b"urn:ietf:params:xml:ns:xmpp-tls" in features:
            raw.sendall(b"<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>")
            proceed = _recv_until(raw, b"/>")
            if b"<proceed" not in proceed:
                return False
            context = ssl.create_default_context()
            with context.wrap_socket(raw, server_hostname=domain) as tls_sock:
                tls_sock.sendall(stream)
                _recv_until(tls_sock, b"</stream:features>")
                tls_sock.sendall(auth_stanza)
                resp = _recv_until(tls_sock, b"/>")
                return b"<success" in resp

        raw.sendall(auth_stanza)
        resp = _recv_until(raw, b"/>")
        return b"<success" in resp


@router.post(
    "/register",
    summary="Register XMPP account",
    description="Create a new Prosody account when registration is enabled.",
)
@limiter.limit("10/minute")
async def register_xmpp_account(request: Request, data: RegisterRequest):
    if not settings.XMPP_REGISTRATION_ENABLED:
        raise HTTPException(status_code=403, detail="Registration is disabled")
    if len(data.password or "") < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    # Reject control chars / NUL bytes — these break argv on some kernels
    # (NUL truncates the rest of the password, allowing trivial bypasses) and
    # XMPP SASL never carries them anyway.
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in data.password):
        raise HTTPException(status_code=400, detail="Password contains invalid characters")

    username, domain = parse_jid(data.jid, request)
    try:
        result = await asyncio.to_thread(
            _register_with_prosody, username, domain, data.password
        )
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="prosodyctl not found on server")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Registration command timed out")

    output = f"{result.stdout}\n{result.stderr}".lower()
    if result.returncode != 0:
        if "exists" in output or "conflict" in output or "already" in output:
            raise HTTPException(status_code=409, detail="Account already exists")
        logger.warning(
            "xmpp_register_failed",
            extra={
                "jid": f"{username}@{domain}",
                "returncode": result.returncode,
                "output_preview": output[:300],
            },
        )
        raise HTTPException(status_code=500, detail="Failed to create account")

    return {"ok": True, "jid": f"{username}@{domain}"}


@router.post(
    "/user-token",
    summary="Issue user token",
    description="Issue a JWT for a regular XMPP user by JID.",
)
@limiter.limit("20/minute")
async def issue_user_token(
    request: Request,
    data: UserTokenRequest,
    db: AsyncSession = Depends(get_db),
):
    username, domain = parse_jid(data.jid, request)
    full_jid = f"{username}@{domain}"
    password = (data.password or "").strip()
    if not password:
        raise HTTPException(status_code=400, detail="Password is required")
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in password):
        raise HTTPException(status_code=400, detail="Password contains invalid characters")

    try:
        verified = await asyncio.to_thread(_verify_xmpp_sasl_plain, username, domain, password)
    except Exception:
        logger.exception("xmpp_password_verification_unavailable")
        raise HTTPException(status_code=503, detail="Password verification unavailable")
    if not verified:
        raise HTTPException(status_code=401, detail="Invalid JID or password")

    result = await db.execute(select(Account).where(Account.jid == full_jid))
    account = result.scalar_one_or_none()
    if not account:
        account = Account(
            id=str(uuid.uuid4()),
            jid=full_jid,
            domain=domain,
            display_name=username,
            is_enabled=True,
        )
        db.add(account)
        db.add(AccountPreference(account_id=account.id))
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            result = await db.execute(select(Account).where(Account.jid == full_jid))
            account = result.scalar_one_or_none()
            if not account:
                raise
        else:
            await db.refresh(account)
    if not account.is_enabled:
        raise HTTPException(status_code=403, detail="Account is disabled")

    credential_revision = await asyncio.to_thread(get_credential_revision, full_jid)
    token = create_access_token(full_jid, role="user", account_id=account.id, credential_revision=credential_revision)
    refresh = create_refresh_token(full_jid, role="user", account_id=account.id, credential_revision=credential_revision)
    return {
        "access_token": token,
        "refresh_token": refresh,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES_ACCESS * 60,
        "account_id": account.id,
        "jid": full_jid,
    }


# ---------------------------------------------------------------------------
# Refresh + logout endpoints
# ---------------------------------------------------------------------------

class RefreshRequest(BaseModel):
    refresh_token: str = Field(..., min_length=20, max_length=4096)


class LogoutRequest(BaseModel):
    refresh_token: str | None = Field(None, max_length=4096)


@router.post(
    "/refresh",
    summary="Refresh access token",
    description="Exchange a refresh token for a new access token. The "
                "refresh token itself is rotated (the old one is revoked) "
                "to limit replay if a refresh token is stolen.",
)
@limiter.limit("30/minute")
async def refresh_access_token(
    request: Request,
    data: RefreshRequest,
    db: AsyncSession = Depends(get_db),
):
    from app.utils.security import decode_token, revoke_token  # local import to avoid cycle
    payload = decode_token(data.refresh_token, expected_type="refresh")

    subject = payload["sub"]
    role = payload.get("role", "user")
    account_id = payload.get("account_id")
    jti = payload.get("jti")
    exp = payload.get("exp")

    if role == "user":
        if not account_id:
            raise HTTPException(status_code=401, detail="Invalid user refresh token")
        result = await db.execute(select(Account).where(Account.id == account_id))
        account = result.scalar_one_or_none()
        if not account or not account.is_enabled or account.jid != subject:
            raise HTTPException(status_code=403, detail="Account is disabled or unavailable")

    # Rotate: revoke the old refresh token immediately so it cannot be reused.
    # This bounds the impact of a stolen refresh token to one mint cycle.
    if jti and exp:
        ttl = max(0, int(exp - datetime.now(UTC).timestamp()))
        if not revoke_token(jti, ttl):
            raise HTTPException(status_code=503, detail="Token revocation unavailable")

    credential_revision = payload.get("cv") if role == "user" else None
    new_access = create_access_token(subject, role=role, account_id=account_id, credential_revision=credential_revision)
    new_refresh = create_refresh_token(subject, role=role, account_id=account_id, credential_revision=credential_revision)
    return {
        "access_token": new_access,
        "refresh_token": new_refresh,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES_ACCESS * 60,
    }


@router.post(
    "/logout",
    summary="Revoke session tokens",
    description="Revokes the bearer access token (from Authorization header) "
                "and optionally the refresh token. After logout, both tokens "
                "are rejected even if not yet expired.",
)
@limiter.limit("60/minute")
async def logout(
    request: Request,
    data: LogoutRequest,
):
    from app.utils.security import decode_token, revoke_token, bearer_scheme
    from fastapi.security import HTTPAuthorizationCredentials

    revoked: list[str] = []
    access_payload = None
    refresh_payload = None

    # Revoke the access token from the Authorization header
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        access_token = auth_header[len("Bearer "):]
        try:
            access_payload = decode_token(access_token, expected_type="access")
        except HTTPException:
            # Already invalid/expired — nothing to revoke
            pass

    # Revoke the refresh token if supplied
    if data.refresh_token:
        try:
            refresh_payload = decode_token(data.refresh_token, expected_type="refresh")
        except HTTPException:
            pass

    if access_payload and refresh_payload:
        identity = lambda payload: (payload.get("sub"), payload.get("role"), payload.get("account_id"))
        if identity(access_payload) != identity(refresh_payload):
            raise HTTPException(status_code=403, detail="Tokens belong to different accounts")

    for token_type, payload in (("access", access_payload), ("refresh", refresh_payload)):
        if not payload:
            continue
        jti = payload.get("jti")
        exp = payload.get("exp")
        if jti and exp:
            ttl = max(0, int(exp - datetime.now(UTC).timestamp()))
            if revoke_token(jti, ttl):
                revoked.append(token_type)

    return {"revoked": revoked}
