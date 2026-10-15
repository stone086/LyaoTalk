from fastapi import APIRouter, Depends, HTTPException, Security
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, List
from app.core.database import get_db
from app.models import Conversation, Message
from app.utils.security import bearer_scheme, decode_token
from fastapi.security import HTTPAuthorizationCredentials
import uuid

router = APIRouter()


def _actor(credentials: HTTPAuthorizationCredentials = Security(bearer_scheme)) -> dict[str, str | None]:
    """Resolve the calling actor.

    Required on every conversations endpoint. Without this, anyone could:
      - GET /conversations/?account_id=X     enumerate someone else's chat list
      - POST /conversations/                  create conversations on their behalf
      - PATCH /conversations/{id}/pin         re-arrange someone else's UI
      - PATCH /conversations/{id}/archive     hide messages from another user
      - PATCH /conversations/{id}/read        forge "read" status (privacy break)
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    role = payload.get("role")
    if role not in ("admin", "user"):
        raise HTTPException(status_code=403, detail="Conversation access denied")
    return {"role": role, "sub": payload.get("sub"), "account_id": payload.get("account_id")}


def _require_account_access(account_id: str, actor: dict[str, str | None]) -> None:
    if actor.get("role") == "admin":
        return
    if actor.get("account_id") != account_id:
        raise HTTPException(status_code=403, detail="Conversation access denied")


async def _conv_account_id(db: AsyncSession, conv_id: str) -> Optional[str]:
    """Return the account_id that owns a conversation, or None if it doesn't exist."""
    result = await db.execute(
        select(Conversation.account_id).where(Conversation.id == conv_id)
    )
    return result.scalar_one_or_none()


class ConversationCreate(BaseModel):
    account_id: str = Field(..., min_length=1, max_length=64)
    type: str = Field(..., max_length=16)  # private/group/system
    peer_jid: str = Field(..., min_length=3, max_length=130)
    title: Optional[str] = Field(None, max_length=256)
    avatar_url: Optional[str] = Field(None, max_length=2048)


class ConversationResponse(BaseModel):
    id: str
    account_id: str
    type: str
    peer_jid: str
    title: Optional[str]
    unread_count: int
    pinned: bool
    archived: bool

    model_config = ConfigDict(from_attributes=True)


@router.get(
    "/",
    response_model=List[ConversationResponse],
    summary="List conversations",
    description="List active (non-archived) conversations for an account.",
)
async def list_conversations(
    account_id: str,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    _require_account_access(account_id, actor)
    result = await db.execute(
        select(Conversation)
        .where(Conversation.account_id == account_id, Conversation.archived == False)
        .order_by(Conversation.last_message_at.desc())
    )
    return result.scalars().all()


@router.post(
    "/",
    response_model=ConversationResponse,
    summary="Create or get conversation",
    description="Return existing conversation for peer JID or create a new one.",
)
async def create_or_get_conversation(
    data: ConversationCreate,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    _require_account_access(data.account_id, actor)
    # Check if exists
    result = await db.execute(
        select(Conversation).where(
            Conversation.account_id == data.account_id,
            Conversation.peer_jid == data.peer_jid,
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        return existing

    conv = Conversation(
        id=str(uuid.uuid4()),
        account_id=data.account_id,
        type=data.type,
        peer_jid=data.peer_jid,
        title=data.title,
        avatar_url=data.avatar_url,
        unread_count=0,
        pinned=False,
        archived=False,
    )
    db.add(conv)
    try:
        await db.commit()
        await db.refresh(conv)
        return conv
    except IntegrityError:
        # A concurrent request beat us to inserting the same (account, peer)
        # pair. The UNIQUE constraint added in migration 0008 caught it.
        # Roll back and return the row the other request created.
        await db.rollback()
        result = await db.execute(
            select(Conversation).where(
                Conversation.account_id == data.account_id,
                Conversation.peer_jid == data.peer_jid,
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            return existing
        # Constraint fired but no row found — shouldn't happen, but signal
        # cleanly rather than 500 with a confusing rollback error.
        raise HTTPException(status_code=409, detail="Conflict creating conversation")


@router.patch(
    "/{conv_id}/pin",
    summary="Pin conversation",
    description="Set pinned status on a conversation.",
)
async def pin_conversation(
    conv_id: str,
    pinned: bool,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    owner = await _conv_account_id(db, conv_id)
    if owner is None:
        raise HTTPException(404, "Conversation not found")
    _require_account_access(owner, actor)
    await db.execute(update(Conversation).where(Conversation.id == conv_id).values(pinned=pinned))
    await db.commit()
    return {"ok": True}


@router.patch(
    "/{conv_id}/archive",
    summary="Archive conversation",
    description="Set archived status on a conversation.",
)
async def archive_conversation(
    conv_id: str,
    archived: bool,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    owner = await _conv_account_id(db, conv_id)
    if owner is None:
        raise HTTPException(404, "Conversation not found")
    _require_account_access(owner, actor)
    await db.execute(update(Conversation).where(Conversation.id == conv_id).values(archived=archived))
    await db.commit()
    return {"ok": True}


@router.patch(
    "/{conv_id}/read",
    summary="Mark conversation read",
    description="Reset unread counter for a conversation.",
)
async def mark_read(
    conv_id: str,
    actor: dict[str, str | None] = Depends(_actor),
    db: AsyncSession = Depends(get_db),
):
    owner = await _conv_account_id(db, conv_id)
    if owner is None:
        raise HTTPException(404, "Conversation not found")
    _require_account_access(owner, actor)
    await db.execute(update(Conversation).where(Conversation.id == conv_id).values(unread_count=0))
    await db.commit()
    return {"ok": True}
