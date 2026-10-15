"""Initial schema

Revision ID: 0001_initial
Revises: 
Create Date: 2025-01-01 00:00:00.000000
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "accounts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("jid", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("domain", sa.String(), nullable=False),
        sa.Column("display_name", sa.String()),
        sa.Column("avatar_url", sa.String()),
        sa.Column("is_enabled", sa.Boolean(), default=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )

    op.create_table(
        "account_preferences",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("account_id", sa.String(), sa.ForeignKey("accounts.id"), unique=True),
        sa.Column("auto_login", sa.Boolean(), default=False),
        sa.Column("default_presence", sa.String(), default="available"),
        sa.Column("theme_override", sa.String()),
        sa.Column("notifications_enabled", sa.Boolean(), default=True),
        sa.Column("config_json", sa.JSON(), default=dict),
    )

    op.create_table(
        "contacts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("account_id", sa.String(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("jid", sa.String(), nullable=False, index=True),
        sa.Column("nickname", sa.String()),
        sa.Column("avatar_url", sa.String()),
        sa.Column("group_name", sa.String()),
        sa.Column("tags", sa.JSON(), default=list),
        sa.Column("last_presence", sa.String()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True)),
        sa.Column("is_blocked", sa.Boolean(), default=False),
    )

    op.create_table(
        "conversations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("account_id", sa.String(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("peer_jid", sa.String(), nullable=False, index=True),
        sa.Column("title", sa.String()),
        sa.Column("avatar_url", sa.String()),
        sa.Column("last_message_id", sa.String()),
        sa.Column("last_message_at", sa.DateTime(timezone=True)),
        sa.Column("unread_count", sa.Integer(), default=0),
        sa.Column("pinned", sa.Boolean(), default=False),
        sa.Column("archived", sa.Boolean(), default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "messages",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("conversation_id", sa.String(), sa.ForeignKey("conversations.id"), nullable=False, index=True),
        sa.Column("xmpp_stanza_id", sa.String(), index=True),
        sa.Column("sender_jid", sa.String(), nullable=False),
        sa.Column("receiver_jid", sa.String()),
        sa.Column("body", sa.Text()),
        sa.Column("body_type", sa.String(), default="text"),
        sa.Column("direction", sa.String(), nullable=False),
        sa.Column("status", sa.String(), default="sent"),
        sa.Column("reply_to_message_id", sa.String()),
        sa.Column("metadata_json", sa.JSON(), default=dict),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("edited_at", sa.DateTime(timezone=True)),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )

    op.create_table(
        "attachments",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("message_id", sa.String(), sa.ForeignKey("messages.id")),
        sa.Column("object_key", sa.String(), nullable=False),
        sa.Column("file_name", sa.String()),
        sa.Column("mime_type", sa.String()),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("width", sa.Integer()),
        sa.Column("height", sa.Integer()),
        sa.Column("duration_sec", sa.Integer()),
        sa.Column("preview_url", sa.String()),
        sa.Column("download_url", sa.String()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "plugins",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), unique=True, nullable=False),
        sa.Column("version", sa.String()),
        sa.Column("entrypoint", sa.String()),
        sa.Column("is_enabled", sa.Boolean(), default=False),
        sa.Column("permission_json", sa.JSON(), default=list),
        sa.Column("config_schema_json", sa.JSON(), default=dict),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "plugin_settings",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("plugin_id", sa.String(), sa.ForeignKey("plugins.id"), nullable=False),
        sa.Column("account_id", sa.String()),
        sa.Column("config_json", sa.JSON(), default=dict),
        sa.Column("updated_at", sa.DateTime(timezone=True)),
    )

    op.create_table(
        "ai_jobs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("account_id", sa.String()),
        sa.Column("conversation_id", sa.String()),
        sa.Column("plugin_name", sa.String()),
        sa.Column("task_type", sa.String()),
        sa.Column("input_ref", sa.String()),
        sa.Column("status", sa.String(), default="pending"),
        sa.Column("result_json", sa.JSON()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
    )

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("actor", sa.String()),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("target_type", sa.String()),
        sa.Column("target_id", sa.String()),
        sa.Column("detail_json", sa.JSON(), default=dict),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    for table in ["audit_logs", "ai_jobs", "plugin_settings", "plugins",
                  "attachments", "messages", "conversations", "contacts",
                  "account_preferences", "accounts"]:
        op.drop_table(table)
