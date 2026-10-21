from sqlalchemy import Column, String, Boolean, Integer, DateTime, Text, JSON, ForeignKey, BigInteger, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.core.database import Base
import uuid


def gen_uuid():
    return str(uuid.uuid4())


class Account(Base):
    __tablename__ = "accounts"
    id = Column(String, primary_key=True, default=gen_uuid)
    jid = Column(String, unique=True, nullable=False, index=True)
    domain = Column(String, nullable=False)
    display_name = Column(String)
    avatar_url = Column(String)
    is_enabled = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    preferences = relationship("AccountPreference", back_populates="account", uselist=False)
    conversations = relationship("Conversation", back_populates="account")


class AccountPreference(Base):
    __tablename__ = "account_preferences"
    id = Column(String, primary_key=True, default=gen_uuid)
    account_id = Column(String, ForeignKey("accounts.id"), unique=True)
    auto_login = Column(Boolean, default=False)
    default_presence = Column(String, default="available")
    theme_override = Column(String)
    notifications_enabled = Column(Boolean, default=True)
    config_json = Column(JSON, default=dict)

    account = relationship("Account", back_populates="preferences")


class Contact(Base):
    __tablename__ = "contacts"
    __table_args__ = (
        # Same race-fix as Conversation: concurrent presence updates on
        # the same JID created duplicate rows.
        UniqueConstraint("account_id", "jid", name="uq_contacts_account_jid"),
    )
    id = Column(String, primary_key=True, default=gen_uuid)
    account_id = Column(String, ForeignKey("accounts.id"), nullable=False, index=True)
    jid = Column(String, nullable=False, index=True)
    nickname = Column(String)
    avatar_url = Column(String)
    group_name = Column(String)
    tags = Column(JSON, default=list)
    last_presence = Column(String)
    last_seen_at = Column(DateTime(timezone=True))
    is_blocked = Column(Boolean, default=False)


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (
        # Close the SELECT-then-INSERT race in create_or_get_conversation:
        # without this, two concurrent "open chat with X" requests created
        # duplicate rows. Migration 0008 added this; the model declaration
        # makes SQLAlchemy aware so IntegrityError fires from this path.
        UniqueConstraint("account_id", "peer_jid", name="uq_conversations_account_peer"),
    )
    id = Column(String, primary_key=True, default=gen_uuid)
    account_id = Column(String, ForeignKey("accounts.id"), nullable=False, index=True)
    type = Column(String, nullable=False, index=True)  # private/group/system
    peer_jid = Column(String, nullable=False, index=True)
    title = Column(String)
    avatar_url = Column(String)
    last_message_id = Column(String)
    last_message_at = Column(DateTime(timezone=True))
    unread_count = Column(Integer, default=0)
    pinned = Column(Boolean, default=False)
    archived = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    account = relationship("Account", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation")


class Message(Base):
    __tablename__ = "messages"
    id = Column(String, primary_key=True, default=gen_uuid)
    conversation_id = Column(String, ForeignKey("conversations.id"), nullable=False, index=True)
    xmpp_stanza_id = Column(String, index=True)
    sender_jid = Column(String, nullable=False)
    receiver_jid = Column(String)
    body = Column(Text)
    body_type = Column(String, default="text")  # text/html/markdown
    direction = Column(String, nullable=False)  # in/out/system
    status = Column(String, default="sent")  # pending/sent/delivered/read/failed
    reply_to_message_id = Column(String)
    metadata_json = Column(JSON, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    edited_at = Column(DateTime(timezone=True))
    deleted_at = Column(DateTime(timezone=True))

    conversation = relationship("Conversation", back_populates="messages")
    attachments = relationship("Attachment", back_populates="message")


class Attachment(Base):
    __tablename__ = "attachments"
    id = Column(String, primary_key=True, default=gen_uuid)
    message_id = Column(String, ForeignKey("messages.id"))
    owner_account_id = Column(String, ForeignKey("accounts.id"), index=True)
    object_key = Column(String, nullable=False, index=True)
    file_name = Column(String)
    mime_type = Column(String)
    size_bytes = Column(BigInteger)
    width = Column(Integer)
    height = Column(Integer)
    duration_sec = Column(Integer)
    preview_url = Column(String)
    download_url = Column(String)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    message = relationship("Message", back_populates="attachments")


class AttachmentGrant(Base):
    __tablename__ = "attachment_grants"
    __table_args__ = (UniqueConstraint("attachment_id", "account_id", name="uq_attachment_grant_account"),)
    id = Column(String, primary_key=True, default=gen_uuid)
    attachment_id = Column(String, ForeignKey("attachments.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id = Column(String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)


class Plugin(Base):
    __tablename__ = "plugins"
    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, unique=True, nullable=False)
    version = Column(String)
    entrypoint = Column(String)
    is_enabled = Column(Boolean, default=False)
    permission_json = Column(JSON, default=list)
    config_schema_json = Column(JSON, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PluginSetting(Base):
    __tablename__ = "plugin_settings"
    id = Column(String, primary_key=True, default=gen_uuid)
    plugin_id = Column(String, ForeignKey("plugins.id"), nullable=False, index=True)
    account_id = Column(String, nullable=True, index=True)
    config_json = Column(JSON, default=dict)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(String, primary_key=True, default=gen_uuid)
    actor = Column(String)
    action = Column(String, nullable=False)
    target_type = Column(String)
    target_id = Column(String)
    detail_json = Column(JSON, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PushSubscription(Base):
    """Web Push subscription for PWA push notifications."""
    __tablename__ = "push_subscriptions"
    __table_args__ = (UniqueConstraint("account_id", "endpoint", name="uq_push_subscriptions_account_endpoint"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    account_id = Column(String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    endpoint = Column(String, nullable=False)
    node = Column(String, unique=True, nullable=True)
    p256dh = Column(String, nullable=False)
    auth = Column(String, nullable=False)
    user_agent = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Webhook(Base):
    """Inbound webhooks for posting messages from external services."""
    __tablename__ = "webhooks"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False)
    conversation_id = Column(String, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    token = Column(String, nullable=False)
    # Keys the request signature. Never part of a URL, so a leaked/logged
    # webhook URL cannot be used to forge or tamper with a delivery.
    signing_secret = Column(String, nullable=True)
    previous_signing_secret = Column(String, nullable=True)
    previous_secret_expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class CallLog(Base):
    """Per-account record of audio/video calls."""
    __tablename__ = "call_logs"

    id = Column(String, primary_key=True, default=gen_uuid)
    account_id = Column(String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    peer_jid = Column(String, nullable=False)
    direction = Column(String, nullable=False)
    media_types = Column(String, nullable=False)
    status = Column(String, nullable=False)
    duration_seconds = Column(Integer, nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=False)
    ended_at = Column(DateTime(timezone=True), nullable=True)


class SsoIdentity(Base):
    """Maps external SSO identities (OIDC sub, LDAP DN) to local accounts."""
    __tablename__ = "sso_identities"
    __table_args__ = (UniqueConstraint("provider", "provider_sub", name="uq_sso_provider_sub"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    account_id = Column(String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    provider = Column(String(32), nullable=False)       # "oidc" or "ldap"
    provider_sub = Column(String(512), nullable=False)   # OIDC sub claim or LDAP DN
    provider_email = Column(String(256), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
