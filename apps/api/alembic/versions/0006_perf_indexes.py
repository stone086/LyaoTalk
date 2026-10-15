"""add performance indexes

Revision ID: 0006_perf_indexes
Revises: 0005_sso_identities
Create Date: 2026-05-02
"""
from alembic import op


revision = "0006_perf_indexes"
down_revision = "0005_sso_identities"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Heavy-traffic FK columns that were missing indexes
    op.create_index("ix_contacts_account_id", "contacts", ["account_id"])
    op.create_index("ix_conversations_account_id", "conversations", ["account_id"])
    op.create_index("ix_conversations_type", "conversations", ["type"])
    op.create_index("ix_plugin_settings_account_id", "plugin_settings", ["account_id"])
    op.create_index("ix_plugin_settings_plugin_id", "plugin_settings", ["plugin_id"])
    op.create_index("ix_sso_identities_provider", "sso_identities", ["provider"])

    # Composite index for the most common query pattern: list user's conversations
    op.create_index(
        "ix_conversations_account_type",
        "conversations",
        ["account_id", "type"],
    )

    # Composite index for the most common message query pattern:
    # "give me last N messages of conversation X ordered by time"
    op.create_index(
        "ix_messages_conversation_created",
        "messages",
        ["conversation_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_messages_conversation_created")
    op.drop_index("ix_conversations_account_type")
    op.drop_index("ix_sso_identities_provider")
    op.drop_index("ix_plugin_settings_plugin_id")
    op.drop_index("ix_plugin_settings_account_id")
    op.drop_index("ix_conversations_type")
    op.drop_index("ix_conversations_account_id")
    op.drop_index("ix_contacts_account_id")
