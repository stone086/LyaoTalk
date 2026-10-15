from fastapi import APIRouter, Depends, HTTPException, Query, Security
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import delete, func, select, update
from pydantic import BaseModel, ConfigDict, Field
from typing import List, Optional
from datetime import datetime
from app.core.database import get_db
from app.models import Attachment, AttachmentGrant, Message, Conversation
from app.utils.security import bearer_scheme, decode_token
from fastapi.security import HTTPAuthorizationCredentials
import uuid

router = APIRouter()


def get_message_actor(
    credentials: HTTPAuthorizationCredentials = Security(bearer_scheme),
) -> dict[str, str | None]:
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    role = payload.get("role")
    if role == "admin":
        return {"role": "admin", "sub": payload["sub"], "account_id": payload.get("account_id")}
    if role == "user" and payload.get("account_id"):
        return {"role": "user", "sub": payload["sub"], "account_id": payload["account_id"]}
    raise HTTPException(status_code=403, detail="Message access denied")


def require_account_access(account_id: str, actor: dict[str, str | None]) -> None:
    if actor.get("role") == "admin":
        return
    if actor.get("account_id") != account_id:
        raise HTTPException(status_code=403, detail="Account access denied")


class MessageCreate(BaseModel):
    conversation_id: str = Field(..., min_length=1, max_length=64)
    sender_jid: str = Field(..., min_length=3, max_length=130)
    receiver_jid: Optional[str] = Field(None, max_length=130)
    body: str = Field(..., max_length=65536)  # 64KB max — enough for any sane message
    body_type: str = Field("text", max_length=16)
    direction: str = Field(..., max_length=16)
    xmpp_stanza_id: Optional[str] = Field(None, max_length=256)
    metadata_json: Optional[dict] = Field(default_factory=dict)


class MessageResponse(BaseModel):
    id: str
    conversation_id: str
    sender_jid: str
    body: Optional[str]
    direction: str
    status: str
    created_at: Optional[datetime]

    model_config = ConfigDict(from_attributes=True)


@router.post(
    "/",
    response_model=MessageResponse,
    summary="Index message",
    description="Persist one message into local searchable storage.",
)
async def index_message(
    data: MessageCreate,
    actor: dict[str, str | None] = Depends(get_message_actor),
    db: AsyncSession = Depends(get_db),
):
    conv_result = await db.execute(
        select(Conversation.account_id).where(Conversation.id == data.conversation_id)
    )
    account_id = conv_result.scalar_one_or_none()
    if not account_id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    require_account_access(account_id, actor)
    msg = Message(
        id=str(uuid.uuid4()),
        conversation_id=data.conversation_id,
        sender_jid=data.sender_jid,
        receiver_jid=data.receiver_jid,
        body=data.body,
        body_type=data.body_type,
        direction=data.direction,
        xmpp_stanza_id=data.xmpp_stanza_id,
        metadata_json=data.metadata_json,
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    return msg


@router.get(
    "/search",
    response_model=List[MessageResponse],
    summary="Search messages",
    description="Search messages by keyword within one account scope.",
)
async def search_messages(
    q: str = Query(..., min_length=1, max_length=200),
    account_id: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
    actor: dict[str, str | None] = Depends(get_message_actor),
    db: AsyncSession = Depends(get_db),
):
    if not account_id:
        raise HTTPException(status_code=400, detail="account_id is required")
    require_account_access(account_id, actor)
    safe_limit = limit  # already bounded by Query(ge=1, le=100)
    # Escape LIKE wildcards so user input matches literally — without this,
    # a user searching for "50%" would return everything containing "50"
    # followed by anything. Use \\ as the escape char.
    escaped_q = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    stmt = (
        select(Message)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Message.body.ilike(f"%{escaped_q}%", escape="\\"),
            Conversation.account_id == account_id,
        )
        .order_by(Message.created_at.desc())
        .limit(safe_limit)
    )
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get(
    "/conversation/{conversation_id}",
    response_model=List[MessageResponse],
    summary="List conversation messages",
    description="Return paginated messages for one conversation.",
)
async def get_conversation_messages(
    conversation_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=100_000),
    actor: dict[str, str | None] = Depends(get_message_actor),
    db: AsyncSession = Depends(get_db),
):
    conv_result = await db.execute(
        select(Conversation.account_id).where(Conversation.id == conversation_id)
    )
    account_id = conv_result.scalar_one_or_none()
    if not account_id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    require_account_access(account_id, actor)
    stmt = (
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(stmt)
    return result.scalars().all()


@router.delete(
    "/conversation-history",
    summary="Delete one conversation and its indexed messages",
)
async def clear_conversation_history(
    account_id: str = Query(..., min_length=1),
    peer_jid: str = Query(..., min_length=3, max_length=130),
    actor: dict[str, str | None] = Depends(get_message_actor),
    db: AsyncSession = Depends(get_db),
):
    require_account_access(account_id, actor)
    peer = peer_jid.strip().lower().split("/", 1)[0]
    conv_ids = select(Conversation.id).where(
        Conversation.account_id == account_id,
        func.lower(Conversation.peer_jid) == peer,
    )
    message_ids = select(Message.id).where(Message.conversation_id.in_(conv_ids))
    attachment_ids = select(Attachment.id).where(Attachment.message_id.in_(message_ids))
    await db.execute(delete(AttachmentGrant).where(AttachmentGrant.attachment_id.in_(attachment_ids)))
    await db.execute(delete(Attachment).where(Attachment.message_id.in_(message_ids)))
    result = await db.execute(delete(Message).where(Message.conversation_id.in_(conv_ids)))
    await db.execute(delete(Conversation).where(Conversation.id.in_(conv_ids)))
    await db.commit()
    return {"ok": True, "deleted": result.rowcount or 0}


@router.delete(
    "/history",
    summary="Clear account message history",
    description="Delete server-side indexed messages for one account and clear conversation history summaries.",
)
async def clear_account_history(
    account_id: str = Query(..., min_length=1),
    actor: dict[str, str | None] = Depends(get_message_actor),
    db: AsyncSession = Depends(get_db),
):
    require_account_access(account_id, actor)
    conv_ids = select(Conversation.id).where(Conversation.account_id == account_id)
    message_ids = select(Message.id).where(Message.conversation_id.in_(conv_ids))
    await db.execute(
        delete(Attachment)
        .where(Attachment.message_id.in_(message_ids))
        .execution_options(synchronize_session=False)
    )
    result = await db.execute(
        delete(Message)
        .where(Message.conversation_id.in_(conv_ids))
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        update(Conversation)
        .where(Conversation.account_id == account_id)
        .values(last_message_id=None, last_message_at=None, unread_count=0)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    return {"ok": True, "deleted": result.rowcount or 0}
