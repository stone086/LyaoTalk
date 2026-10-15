from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from datetime import datetime

class AccountResponse(BaseModel):
    id: str
    jid: str
    domain: str
    display_name: Optional[str] = None
    is_enabled: bool
    model_config = ConfigDict(from_attributes=True)

class ConversationResponse(BaseModel):
    id: str
    account_id: str
    type: str
    peer_jid: str
    title: Optional[str] = None
    unread_count: int
    pinned: bool
    archived: bool
    model_config = ConfigDict(from_attributes=True)

class MessageResponse(BaseModel):
    id: str
    conversation_id: str
    sender_jid: str
    body: Optional[str] = None
    direction: str
    status: str
    created_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
