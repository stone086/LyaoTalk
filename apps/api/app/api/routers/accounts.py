from fastapi import APIRouter, Depends, HTTPException, Request, Security
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, List
from app.core.database import get_db
from app.models import Account, AccountPreference
from app.services.audit import write_audit, get_client_ip
from app.utils.security import bearer_scheme, decode_token, mark_account_disabled
from fastapi.security import HTTPAuthorizationCredentials
import uuid

router = APIRouter()


def _actor(credentials: HTTPAuthorizationCredentials = Security(bearer_scheme)) -> dict[str, str | None]:
    """Resolve the calling actor.

    Required on every accounts endpoint — without this anyone could:
      - POST /accounts/    create infinite junk accounts (DoS)
      - GET /accounts/     enumerate every JID on the server (info disclosure)
      - DELETE /accounts/{id}  wipe any account
      - PUT /accounts/{id}/preferences  modify any account's settings
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    role = payload.get("role")
    if role not in ("admin", "user"):
        raise HTTPException(status_code=403, detail="Account access denied")
    return {
        "role": role,
        "sub": payload.get("sub"),
        "account_id": payload.get("account_id"),
    }


def _require_account_access(account_id: str, actor: dict[str, str | None]) -> None:
    """Admins → any account. Users → only their own account_id."""
    if actor.get("role") == "admin":
        return
    if actor.get("account_id") != account_id:
        raise HTTPException(status_code=403, detail="Account access denied")


class AccountCreate(BaseModel):
    jid: str = Field(..., min_length=3, max_length=130)
    domain: str = Field(..., min_length=1, max_length=64)
    display_name: Optional[str] = Field(None, max_length=128)


class AccountResponse(BaseModel):
    id: str
    jid: str
    domain: str
    display_name: Optional[str]
    is_enabled: bool

    model_config = ConfigDict(from_attributes=True)


class AccountPreferenceResponse(BaseModel):
    auto_login: bool
    default_presence: str
    theme_override: Optional[str] = None
    notifications_enabled: bool
    config_json: dict = Field(default_factory=dict)


class AccountPreferenceUpdate(BaseModel):
    auto_login: Optional[bool] = None
    default_presence: Optional[str] = Field(None, max_length=16)
    theme_override: Optional[str] = Field(None, max_length=32)
    notifications_enabled: Optional[bool] = None
    config_json: Optional[dict] = None


@router.get(
    "/",
    response_model=List[AccountResponse],
    summary="List accounts",
    description="Admins see all accounts; users see only their own.",
)
async def list_accounts(
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    if actor.get("role") == "admin":
        result = await db.execute(select(Account).where(Account.is_enabled == True))
        return result.scalars().all()
    # Regular users only see their own account
    own_id = actor.get("account_id")
    if not own_id:
        return []
    result = await db.execute(
        select(Account).where(Account.id == own_id, Account.is_enabled == True)
    )
    return result.scalars().all()


@router.post(
    "/",
    response_model=AccountResponse,
    summary="Create account",
    description="Create a local account record and default preference profile. "
                "Caller must be admin OR a user whose token JID matches the new account JID.",
)
async def create_account(
    request: Request,
    data: AccountCreate,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    # Admins can create any account; users can only create their own JID's account.
    # Without this check, anyone with any token could spam infinite junk accounts.
    if actor.get("role") != "admin":
        token_jid = (actor.get("sub") or "").lower().strip()
        new_jid = (data.jid or "").lower().strip()
        if not token_jid or token_jid != new_jid:
            raise HTTPException(status_code=403, detail="Cannot create accounts for other users")

    existing = (
        await db.execute(select(Account).where(Account.jid == data.jid))
    ).scalar_one_or_none()
    if existing:
        return existing

    account = Account(
        id=str(uuid.uuid4()),
        jid=data.jid,
        domain=data.domain,
        display_name=data.display_name,
    )
    db.add(account)
    pref = AccountPreference(account_id=account.id)
    db.add(pref)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = (
            await db.execute(select(Account).where(Account.jid == data.jid))
        ).scalar_one_or_none()
        if existing:
            return existing
        raise
    await db.refresh(account)
    # Audit account creation. Useful for forensics: an attacker who steals
    # an admin token and creates new accounts will leave a trace here.
    await write_audit(
        db,
        actor=actor.get("sub") or actor.get("role"),
        action="account_created",
        target_type="account",
        target_id=account.id,
        detail={"jid": data.jid, "by_role": actor.get("role")},
        client_ip=get_client_ip(request),
    )
    return account


@router.get(
    "/{account_id}",
    response_model=AccountResponse,
    summary="Get account",
    description="Fetch one account by id.",
)
async def get_account(
    account_id: str,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    _require_account_access(account_id, actor)
    result = await db.execute(select(Account).where(Account.id == account_id))
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    return account


@router.delete(
    "/{account_id}",
    summary="Disable account",
    description="Soft-delete an account by setting is_enabled to false.",
)
async def delete_account(
    request: Request,
    account_id: str,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    _require_account_access(account_id, actor)
    result = await db.execute(select(Account).where(Account.id == account_id))
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    account.is_enabled = False
    await db.commit()
    if not mark_account_disabled(account_id):
        # The database state is authoritative; Redis failure makes user token
        # validation fail closed until the fence can be written.
        raise HTTPException(status_code=503, detail="Account disabled; session fence unavailable")
    # Audit account disable. Without this, mass-disable attacks (admin token
    # compromise + script disabling all accounts) are silent until users
    # complain.
    await write_audit(
        db,
        actor=actor.get("sub") or actor.get("role"),
        action="account_disabled",
        target_type="account",
        target_id=account_id,
        detail={"jid": account.jid, "by_role": actor.get("role")},
        client_ip=get_client_ip(request),
    )
    return {"ok": True}


@router.get(
    "/{account_id}/preferences",
    response_model=AccountPreferenceResponse,
    summary="Get account preferences",
    description="Return account-level preference settings, creating defaults when missing.",
)
async def get_account_preferences(
    account_id: str,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    _require_account_access(account_id, actor)
    account_result = await db.execute(select(Account).where(Account.id == account_id))
    account = account_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    result = await db.execute(select(AccountPreference).where(AccountPreference.account_id == account_id))
    pref = result.scalar_one_or_none()
    if not pref:
        pref = AccountPreference(account_id=account_id)
        db.add(pref)
        await db.commit()
        await db.refresh(pref)
    return pref


@router.put(
    "/{account_id}/preferences",
    response_model=AccountPreferenceResponse,
    summary="Update account preferences",
    description="Patch account preference fields and return the saved profile.",
)
async def update_account_preferences(
    account_id: str,
    data: AccountPreferenceUpdate,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    _require_account_access(account_id, actor)
    account_result = await db.execute(select(Account).where(Account.id == account_id))
    account = account_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    result = await db.execute(select(AccountPreference).where(AccountPreference.account_id == account_id))
    pref = result.scalar_one_or_none()
    if not pref:
        pref = AccountPreference(account_id=account_id)
        db.add(pref)

    patch = data.model_dump(exclude_unset=True)
    for key, value in patch.items():
        setattr(pref, key, value)

    await db.commit()
    await db.refresh(pref)
    return pref
