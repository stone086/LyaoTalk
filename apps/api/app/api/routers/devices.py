"""Per-device XMPP credentials backed by Prosody tokenauth grants."""
import asyncio
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import Account
from app.api.routers.auth import _verify_xmpp_sasl_plain
from app.utils.security import (
    create_access_token, create_refresh_token, get_current_user,
    set_device_active,
)

router = APIRouter(prefix="/devices", tags=["devices"])


async def _prosody(action: str, payload: dict) -> dict:
    secret = settings.DEVICE_AUTH_SECRET
    if len(secret) < 32:
        raise HTTPException(status_code=503, detail="Device authentication unavailable")
    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=False, trust_env=False) as client:
            response = await client.post(
                f"{settings.DEVICE_AUTH_URL}/{action}", json=payload,
                headers={"X-LyaoTalk-Device-Secret": secret, "Host": settings.XMPP_DOMAIN},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Device authentication unavailable") from exc
    if response.status_code >= 500:
        raise HTTPException(status_code=503, detail="Device authentication unavailable")
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail="Device request rejected")
    try:
        return response.json()
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="Device authentication unavailable") from exc


class DeviceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=4096)


class DeviceRevoke(BaseModel):
    id: str = Field(min_length=1, max_length=128)


class DeviceLogin(BaseModel):
    token: str = Field(min_length=20, max_length=4096)


@router.post("/issue")
@limiter.limit("5/minute")
async def issue_device(
    request: Request, data: DeviceCreate,
    user: dict = Depends(get_current_user),
):
    username = user["sub"].split("@", 1)[0]
    domain = user["sub"].split("@", 1)[1]
    try:
        verified = await asyncio.to_thread(_verify_xmpp_sasl_plain, username, domain, data.password)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Password verification unavailable") from exc
    if not verified:
        raise HTTPException(status_code=401, detail="Invalid account password")
    result = await _prosody("issue", {"username": username, "name": data.name})
    try:
        set_device_active(user["account_id"], result["id"], True)
    except HTTPException:
        await _prosody("revoke", {"username": username, "id": result["id"]})
        raise
    return result


@router.post("/list")
@limiter.limit("30/minute")
async def list_devices(request: Request, user: dict = Depends(get_current_user)):
    return await _prosody("list", {"username": user["sub"].split("@", 1)[0]})


@router.post("/revoke")
@limiter.limit("20/minute")
async def revoke_device(
    request: Request, data: DeviceRevoke,
    user: dict = Depends(get_current_user),
):
    result = await _prosody("revoke", {"username": user["sub"].split("@", 1)[0], "id": data.id})
    set_device_active(user["account_id"], data.id, False)
    return result


@router.post("/revoke-all")
@limiter.limit("5/minute")
async def revoke_all_devices(request: Request, user: dict = Depends(get_current_user)):
    return await revoke_all_for_user(user)


async def revoke_all_for_user(user: dict) -> dict:
    result = await _prosody("revoke-all", {"username": user["sub"].split("@", 1)[0]})
    for device_id in result["revoked"]:
        set_device_active(user["account_id"], device_id, False)
    return {"revoked": len(result["revoked"])}


@router.post("/login")
@limiter.limit("20/minute")
async def login_device(request: Request, data: DeviceLogin, db: AsyncSession = Depends(get_db)):
    info = await _prosody("renew", {"token": data.token})
    jid = info["jid"]
    result = await db.execute(select(Account).where(Account.jid == jid))
    account = result.scalar_one_or_none()
    if not account or not account.is_enabled:
        raise HTTPException(status_code=403, detail="Account unavailable")
    device_id = info["id"]
    set_device_active(account.id, device_id, True)
    access = create_access_token(jid, role="user", account_id=account.id, device_id=device_id)
    refresh = create_refresh_token(jid, role="user", account_id=account.id, device_id=device_id)
    return {
        "access_token": access, "refresh_token": refresh, "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES_ACCESS * 60,
        "account_id": account.id, "jid": jid, "device_id": device_id,
        "new_device_token": info.get("new_token"),
    }
