from fastapi import APIRouter, Depends, HTTPException, Security
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, List
from app.core.database import get_db
from app.models import Contact
from app.utils.security import bearer_scheme, decode_token
from fastapi.security import HTTPAuthorizationCredentials
import uuid

router = APIRouter()


def _actor(credentials: HTTPAuthorizationCredentials = Security(bearer_scheme)) -> dict[str, str | None]:
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    role = payload.get("role")
    if role not in ("admin", "user"):
        raise HTTPException(status_code=403, detail="Contact access denied")
    return {"role": role, "sub": payload.get("sub"), "account_id": payload.get("account_id")}


def _require_account_access(account_id: str, actor: dict[str, str | None]) -> None:
    if actor.get("role") == "admin":
        return
    if actor.get("account_id") != account_id:
        raise HTTPException(status_code=403, detail="Contact access denied")


class ContactUpsert(BaseModel):
    account_id: str = Field(..., min_length=1, max_length=64)
    jid: str = Field(..., min_length=3, max_length=130)
    nickname: Optional[str] = Field(None, max_length=128)
    group_name: Optional[str] = Field(None, max_length=64)
    avatar_url: Optional[str] = Field(None, max_length=2048)


class ContactResponse(BaseModel):
    id: str
    account_id: str
    jid: str
    nickname: Optional[str]
    group_name: Optional[str]
    last_presence: Optional[str]
    is_blocked: bool

    model_config = ConfigDict(from_attributes=True)


@router.get(
    "/",
    response_model=List[ContactResponse],
    summary="List contacts",
    description="Return all contacts for the given account id.",
)
async def list_contacts(
    account_id: str,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    _require_account_access(account_id, actor)
    result = await db.execute(
        select(Contact).where(Contact.account_id == account_id)
    )
    return result.scalars().all()


@router.post(
    "/",
    response_model=ContactResponse,
    summary="Create or update contact",
    description="Upsert one contact by account id and JID.",
)
async def upsert_contact(
    data: ContactUpsert,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    _require_account_access(data.account_id, actor)
    result = await db.execute(
        select(Contact).where(Contact.account_id == data.account_id, Contact.jid == data.jid)
    )
    contact = result.scalar_one_or_none()
    if contact:
        contact.nickname = data.nickname or contact.nickname
        contact.group_name = data.group_name or contact.group_name
        contact.avatar_url = data.avatar_url or contact.avatar_url
        await db.commit()
        await db.refresh(contact)
        return contact

    contact = Contact(
        id=str(uuid.uuid4()),
        account_id=data.account_id,
        jid=data.jid,
        nickname=data.nickname,
        group_name=data.group_name,
        avatar_url=data.avatar_url,
        is_blocked=False,
    )
    db.add(contact)
    try:
        await db.commit()
        await db.refresh(contact)
        return contact
    except IntegrityError:
        # Concurrent upsert race: another request just inserted the same
        # (account, jid) pair. Roll back and merge our changes into theirs.
        await db.rollback()
        result = await db.execute(
            select(Contact).where(
                Contact.account_id == data.account_id, Contact.jid == data.jid
            )
        )
        existing = result.scalar_one_or_none()
        if not existing:
            raise HTTPException(status_code=409, detail="Conflict updating contact")
        # Apply our updates on top of the row that won the race.
        if data.nickname:
            existing.nickname = data.nickname
        if data.group_name:
            existing.group_name = data.group_name
        if data.avatar_url:
            existing.avatar_url = data.avatar_url
        await db.commit()
        await db.refresh(existing)
        return existing


@router.patch(
    "/{contact_id}/block",
    summary="Update blocked status",
    description="Set or clear contact blocked flag.",
)
async def block_contact(
    contact_id: str,
    blocked: bool,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Contact).where(Contact.id == contact_id))
    contact = result.scalar_one_or_none()
    if not contact:
        raise HTTPException(404, "Contact not found")
    _require_account_access(contact.account_id, actor)
    contact.is_blocked = blocked
    await db.commit()
    return {"ok": True}


@router.delete(
    "/{contact_id}",
    summary="Delete contact",
    description="Delete one contact record by id.",
)
async def delete_contact(
    contact_id: str,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    # Look up first so we can verify ownership before deleting
    result = await db.execute(select(Contact).where(Contact.id == contact_id))
    contact = result.scalar_one_or_none()
    if not contact:
        return {"ok": True}  # idempotent delete
    _require_account_access(contact.account_id, actor)
    await db.execute(delete(Contact).where(Contact.id == contact_id))
    await db.commit()
    return {"ok": True}
