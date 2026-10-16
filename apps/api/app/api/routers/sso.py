"""
sso.py - Single Sign-On endpoints (OIDC + LDAP).

Two flows are supported:

1. OIDC (Keycloak / Authentik / Auth0 / Okta / etc.)
   - Frontend redirects user to /sso/oidc/login
   - We redirect to provider's authorize endpoint
   - Provider redirects back to /sso/oidc/callback with code
   - We exchange code for tokens, create one-time code, frontend exchanges for token

2. LDAP (Active Directory / OpenLDAP)
   - Frontend POSTs username + password to /sso/ldap/login
   - We bind to LDAP server with user credentials
   - On success, create / look up XMPP account, return user-token

All configuration is read from app.core.config.settings (pydantic-settings).
"""
import hashlib
import logging
import re
import secrets
import time
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import Account, AccountPreference, SsoIdentity, gen_uuid
from app.utils.security import create_access_token

try:
    import redis.asyncio as aioredis
except ImportError:
    aioredis = None  # type: ignore[assignment]

router = APIRouter()
logger = logging.getLogger("lyaotalk.sso")

SSO_CODE_TTL = 30        # seconds for one-time exchange code
OIDC_STATE_TTL = 600     # seconds for OIDC CSRF state


# ---------------------------------------------------------------------------
# Redis helpers for OIDC state + one-time exchange codes
# ---------------------------------------------------------------------------
async def _get_redis():
    """Lazy Redis connection for SSO state storage."""
    if aioredis is None:
        return None
    try:
        r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        await r.ping()
        return r
    except Exception:
        return None


# In-memory fallback (single-worker dev mode only)
_mem_store: dict[str, tuple[str, float]] = {}


async def _store_set(key: str, value: str, ttl: int) -> None:
    r = await _get_redis()
    if r:
        await r.setex(key, ttl, value)
        await r.aclose()
    else:
        _mem_store[key] = (value, time.time() + ttl)


async def _store_pop(key: str) -> Optional[str]:
    r = await _get_redis()
    if r:
        pipe = r.pipeline()
        pipe.get(key)
        pipe.delete(key)
        val, _ = await pipe.execute()
        await r.aclose()
        return val
    else:
        item = _mem_store.pop(key, None)
        if item and item[1] > time.time():
            return item[0]
        return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _sanitize_username(raw: str) -> str:
    """Produce a safe XMPP localpart from a display name or username."""
    s = raw.lower().strip().replace(" ", "_")
    s = re.sub(r"[^a-z0-9._-]", "", s)
    return s[:64] or "user"


def _oidc_jid(sub: str, name: str) -> str:
    """
    Build a collision-resistant JID from OIDC claims.
    Uses the OIDC 'sub' claim hash to guarantee uniqueness even when
    two users share the same display name.
    """
    safe_name = _sanitize_username(name)
    sub_hash = hashlib.sha256(sub.encode()).hexdigest()[:8]
    return f"{safe_name}_{sub_hash}@{settings.XMPP_DOMAIN}"


async def _ensure_account(
    db: AsyncSession,
    jid: str,
    display_name: str,
    auto_provision: bool,
    provider: str = "",
    provider_sub: str = "",
    provider_email: str = "",
) -> Account:
    """Look up or auto-create an Account with its AccountPreference and SsoIdentity.

    Lookup precedence:
    1. By SsoIdentity (provider, provider_sub) — survives display-name changes
    2. By Account.jid — for backward compatibility / when no SSO identity yet
    3. Auto-provision if enabled
    """
    account = None

    # 1. Look up by SsoIdentity (most stable identifier)
    if provider and provider_sub:
        ident_result = await db.execute(
            select(SsoIdentity).where(
                SsoIdentity.provider == provider,
                SsoIdentity.provider_sub == provider_sub,
            )
        )
        identity = ident_result.scalar_one_or_none()
        if identity:
            acc_result = await db.execute(select(Account).where(Account.id == identity.account_id))
            account = acc_result.scalar_one_or_none()

    # 2. Fall back to JID lookup (for accounts created before SSO migration)
    if not account:
        result = await db.execute(select(Account).where(Account.jid == jid))
        account = result.scalar_one_or_none()
        # If found by JID but no SsoIdentity yet, link them
        if account and provider and provider_sub:
            db.add(SsoIdentity(
                id=gen_uuid(),
                account_id=account.id,
                provider=provider,
                provider_sub=provider_sub,
                provider_email=provider_email or None,
            ))
            await db.commit()

    # 3. Auto-provision
    if not account:
        if not auto_provision:
            raise HTTPException(403, f"Account {jid} not provisioned. Ask admin to create it.")
        domain = jid.split("@", 1)[1] if "@" in jid else settings.XMPP_DOMAIN
        account = Account(
            id=gen_uuid(),
            jid=jid,
            domain=domain,
            display_name=display_name,
            is_enabled=True,
        )
        db.add(account)
        db.add(AccountPreference(account_id=account.id))
        if provider and provider_sub:
            db.add(SsoIdentity(
                id=gen_uuid(),
                account_id=account.id,
                provider=provider,
                provider_sub=provider_sub,
                provider_email=provider_email or None,
            ))
        await db.commit()

    if not account.is_enabled:
        raise HTTPException(403, "Account is disabled")
    return account


# ---------------------------------------------------------------------------
# Provider discovery
# ---------------------------------------------------------------------------
@router.get("/sso/providers")
async def list_providers():
    """Tell the frontend which SSO methods are configured."""
    return {
        "oidc": settings.OIDC_ENABLED,
        "ldap": settings.LDAP_ENABLED,
        "oidc_label": settings.OIDC_LABEL,
        "ldap_label": settings.LDAP_LABEL,
    }


# OIDC: signature algorithms we'll accept on id_token. Pinned tight because
# provider metadata can be poisoned to include "none" or "HS256" — both of
# which would let an attacker forge id_tokens. RS256/RS512/ES256/ES512 are
# the only ones in real use by IdPs (Keycloak, Authentik, Auth0, Okta, etc.)
_ALLOWED_OIDC_ALGS = {"RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"}


def _oidc_pkce_pair() -> tuple[str, str]:
    """Generate a (verifier, S256-challenge) pair per RFC 7636.

    PKCE protects the authorization code from interception attacks: even if
    a malicious party steals the code (e.g., via referer leak, log dump, or
    open-redirect-on-IdP), they can't redeem it without the verifier that
    only our /sso/oidc/login endpoint knew.
    """
    import base64
    verifier = secrets.token_urlsafe(64)  # 64 bytes ≈ 86 base64url chars; spec allows 43-128
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


# =====================================================
# OIDC flow (with secure one-time code exchange)
# =====================================================
@router.get("/sso/oidc/login")
async def oidc_login():
    """Start OIDC authorization code flow with PKCE + nonce."""
    if not settings.OIDC_ENABLED:
        raise HTTPException(404, "OIDC not configured")

    issuer = settings.OIDC_ISSUER.rstrip("/")
    client_id = settings.OIDC_CLIENT_ID
    redirect_uri = settings.OIDC_REDIRECT_URI
    if not (issuer and client_id and redirect_uri):
        raise HTTPException(503, "OIDC misconfigured")

    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier, challenge = _oidc_pkce_pair()
    # Persist verifier + nonce keyed on state. Without verifier the auth
    # code can't be exchanged; without nonce we can't validate that the
    # returned id_token belongs to THIS login (replay protection).
    await _store_set(
        f"oidc:state:{state}",
        f"{verifier}||{nonce}",
        OIDC_STATE_TTL,
    )

    # Discover authorization endpoint
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            disc = await client.get(f"{issuer}/.well-known/openid-configuration")
            disc.raise_for_status()
            auth_endpoint = disc.json()["authorization_endpoint"]
        except Exception as e:
            # Don't leak the issuer URL or low-level exception detail.
            logger.warning("oidc_discovery_failed: %s: %s", type(e).__name__, e)
            raise HTTPException(502, "OIDC discovery failed")

    params = httpx.QueryParams({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    return RedirectResponse(f"{auth_endpoint}?{params}")


@router.get("/sso/oidc/callback")
async def oidc_callback(
    code: str,
    state: str,
    db: AsyncSession = Depends(get_db),
):
    """Handle OIDC redirect back from provider."""
    # Validate CSRF state and retrieve PKCE verifier + nonce.
    stored = await _store_pop(f"oidc:state:{state}")
    if not stored:
        raise HTTPException(400, "Invalid or expired state")
    try:
        verifier, expected_nonce = stored.split("||", 1)
    except ValueError:
        # Legacy state from before this version had PKCE/nonce (in-flight
        # logins during upgrade). Treat as no PKCE.
        verifier, expected_nonce = "", ""

    issuer = settings.OIDC_ISSUER.rstrip("/")
    client_id = settings.OIDC_CLIENT_ID
    client_secret = settings.OIDC_CLIENT_SECRET
    redirect_uri = settings.OIDC_REDIRECT_URI

    async with httpx.AsyncClient(timeout=10.0) as client:
        # Discover endpoints
        disc = await client.get(f"{issuer}/.well-known/openid-configuration")
        disc.raise_for_status()
        meta = disc.json()
        token_endpoint = meta["token_endpoint"]
        userinfo_endpoint = meta["userinfo_endpoint"]

        # Exchange code for token (with PKCE verifier when available)
        token_request = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "client_secret": client_secret,
        }
        if verifier:
            token_request["code_verifier"] = verifier
        token_resp = await client.post(token_endpoint, data=token_request)
        if token_resp.status_code >= 400:
            raise HTTPException(401, "OIDC token exchange failed")
        token_data = token_resp.json()
        access_token = token_data.get("access_token")
        id_token_raw = token_data.get("id_token")
        if not access_token:
            raise HTTPException(401, "No access_token from OIDC provider")

        # Verify id_token signature. We FAIL CLOSED on any verification error
        # (bad signature, expired, wrong issuer, alg mismatch, nonce mismatch).
        # Previously the code fell back to userinfo when verification failed,
        # which meant a stolen access_token could be passed in by an attacker
        # along with a missing/invalid id_token, and we'd accept it because
        # userinfo would still return claims for that token. Fail-closed
        # ensures only a properly-issued id_token (matching our nonce + audience)
        # can authenticate.
        id_token_claims: dict = {}
        if id_token_raw and meta.get("jwks_uri"):
            try:
                import jwt
                jwks_resp = await client.get(meta["jwks_uri"])
                jwks_resp.raise_for_status()
                jwks = jwks_resp.json()
                # Provider-advertised algs are filtered through our static
                # allowlist — never honor "none" or symmetric algs even if
                # the provider claims to support them.
                provider_algs = meta.get("id_token_signing_alg_values_supported", ["RS256"])
                safe_algs = [a for a in provider_algs if a in _ALLOWED_OIDC_ALGS]
                if not safe_algs:
                    safe_algs = ["RS256"]
                header = jwt.get_unverified_header(id_token_raw)
                if header.get("alg") not in safe_algs:
                    raise ValueError("OIDC signing algorithm is not allowed")
                matching_keys = [
                    key for key in jwks.get("keys", [])
                    if key.get("kid") == header.get("kid")
                    and key.get("use", "sig") == "sig"
                ]
                if len(matching_keys) != 1:
                    raise ValueError("OIDC signing key not found or ambiguous")
                signing_key = jwt.PyJWK.from_dict(matching_keys[0]).key
                id_token_claims = jwt.decode(
                    id_token_raw,
                    signing_key,
                    algorithms=safe_algs,
                    audience=client_id,
                    issuer=issuer,
                )
                # Bind id_token to THIS login flow via nonce (replay protection)
                if expected_nonce:
                    id_nonce = id_token_claims.get("nonce")
                    if not id_nonce or not secrets.compare_digest(id_nonce, expected_nonce):
                        logger.warning("oidc_nonce_mismatch")
                        raise HTTPException(401, "OIDC id_token replay detected")
            except HTTPException:
                raise
            except Exception as exc:
                # Fail closed: if id_token verification can't complete cleanly,
                # we don't trust userinfo alone. Better to force a clean re-login.
                logger.warning("oidc_id_token_verify_failed: %s: %s", type(exc).__name__, exc)
                raise HTTPException(401, "OIDC id_token verification failed")
        else:
            # Provider didn't return an id_token or doesn't expose JWKS — that's
            # a misconfigured / non-conforming OIDC provider. Refuse to proceed.
            logger.warning("oidc_no_id_token_or_jwks")
            raise HTTPException(401, "OIDC provider did not return a verifiable id_token")

        # Get user info (cross-reference, even though id_token is authoritative)
        ui = await client.get(
            userinfo_endpoint,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if ui.status_code >= 400:
            raise HTTPException(401, "OIDC userinfo failed")
        userinfo = ui.json()

    # id_token claims are authoritative; userinfo only fills gaps.
    # The previous order (userinfo base, id_token override) was vulnerable
    # if an attacker could control userinfo response via stolen access_token.
    merged = {**userinfo, **{k: v for k, v in id_token_claims.items() if v}}

    email = merged.get("email")
    if not email or not isinstance(email, str):
        raise HTTPException(401, "OIDC user has no email claim")
    # Sanity-check email shape: a single localpart@domain with no whitespace,
    # no control chars. Prevents an IdP that's lax about validation from
    # giving us malformed values that downstream code would mishandle (e.g.
    # split("@") returning unexpected pieces).
    if (
        len(email) > 254
        or "\n" in email
        or "\r" in email
        or "\t" in email
        or " " in email
        or email.count("@") != 1
        or email.startswith("@")
        or email.endswith("@")
    ):
        raise HTTPException(401, "OIDC email claim has invalid shape")

    # Verify email_verified=true. Without this check, an attacker who
    # registers an unverified email at the IdP (many IdPs allow account
    # creation with any email and verify lazily-or-never) could log in to
    # LyaoTalk claiming to be that email's owner. The OIDC spec says
    # "RPs SHOULD NOT rely on this value being true". We treat it as a
    # required signal: if the IdP doesn't verify emails, we don't trust
    # the email_verified flag's presence — we trust that a deployment
    # using OIDC has chosen a properly-configured IdP.
    #
    # If your IdP doesn't set email_verified at all (e.g., a misconfigured
    # Keycloak realm), set OIDC_REQUIRE_EMAIL_VERIFIED=false in .env to
    # bypass this check. Default is to require it.
    if getattr(settings, "OIDC_REQUIRE_EMAIL_VERIFIED", True):
        ev = merged.get("email_verified")
        if ev is not True:
            logger.warning("oidc_email_not_verified email=%s ev=%r", email, ev)
            raise HTTPException(401, "OIDC email is not verified by the identity provider")

    sub = merged.get("sub")
    if not sub or not isinstance(sub, str):
        # `sub` MUST be present in id_token per OIDC spec. Without it we
        # have no stable identifier to dedup users across email changes.
        raise HTTPException(401, "OIDC token missing required sub claim")

    name = merged.get("name") or merged.get("preferred_username") or email.split("@")[0]
    if not isinstance(name, str):
        name = str(name)
    name = name.strip()[:128] or email.split("@")[0]

    # Build collision-resistant JID using sub claim hash
    jid = _oidc_jid(sub, name)
    account = await _ensure_account(
        db, jid, name, settings.AUTO_PROVISION_OIDC,
        provider="oidc", provider_sub=sub, provider_email=email,
    )

    # Issue internal user token
    user_token = create_access_token(jid, role="user", account_id=account.id)

    # Store a one-time code in Redis; frontend exchanges code for token
    exchange_code = secrets.token_urlsafe(48)
    await _store_set(
        f"oidc:code:{exchange_code}",
        f"{user_token}||{jid}",
        SSO_CODE_TTL,
    )

    frontend_url = settings.FRONTEND_URL or "/"
    return RedirectResponse(f"{frontend_url}#sso-code={exchange_code}")


@router.post("/sso/oidc/exchange")
@limiter.limit("20/minute")
async def oidc_exchange_code(request: Request, code: str):
    """
    Exchange a one-time SSO code for an access token.
    The code lives for 30 seconds and can only be used once.
    """
    stored = await _store_pop(f"oidc:code:{code}")
    if not stored:
        raise HTTPException(401, "Invalid or expired SSO code")
    token, jid = stored.split("||", 1)
    return {"access_token": token, "jid": jid}


# =====================================================
# LDAP flow (with rate limiting)
# =====================================================
class LdapLoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=1, max_length=256)


@router.post("/sso/ldap/login")
@limiter.limit("10/minute")
async def ldap_login(
    request: Request,
    payload: LdapLoginRequest,
    db: AsyncSession = Depends(get_db),
):
    """Authenticate via LDAP bind, then issue user-token."""
    if not settings.LDAP_ENABLED:
        raise HTTPException(404, "LDAP not configured")
    if not payload.username or not payload.password:
        raise HTTPException(400, "username and password required")

    server_url = settings.LDAP_SERVER
    bind_template = settings.LDAP_BIND_DN_TEMPLATE
    if not server_url:
        raise HTTPException(503, "LDAP misconfigured")

    bind_dn = bind_template.replace("{username}", payload.username)

    def _ldap_bind() -> None:
        """Synchronous LDAP bind, run in worker thread to avoid blocking event loop."""
        from ldap3 import Server, Connection, ALL, SIMPLE
        srv = Server(server_url, get_info=ALL)
        conn = Connection(
            srv,
            user=bind_dn,
            password=payload.password,
            authentication=SIMPLE,
            auto_bind=True,
            raise_exceptions=True,
        )
        conn.unbind()

    try:
        import asyncio
        await asyncio.to_thread(_ldap_bind)
    except ImportError:
        raise HTTPException(503, "ldap3 library not installed on server")
    except Exception as exc:
        logger.warning(
            f"ldap_auth_failed username={payload.username} "
            f"client={request.client.host if request.client else '?'} "
            f"error={type(exc).__name__}"
        )
        raise HTTPException(401, "LDAP authentication failed")

    # Build JID from LDAP username
    safe_name = _sanitize_username(payload.username)
    jid = f"{safe_name}@{settings.XMPP_DOMAIN}"
    account = await _ensure_account(
        db, jid, payload.username, settings.AUTO_PROVISION_LDAP,
        provider="ldap", provider_sub=bind_dn,
    )

    token = create_access_token(jid, role="user", account_id=account.id)
    return {"access_token": token, "jid": jid}
