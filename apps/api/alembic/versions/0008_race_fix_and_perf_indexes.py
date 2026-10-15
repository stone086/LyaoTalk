"""Add UNIQUE constraints to close upsert races + composite indexes for hot paths.

The constraints close concrete races identified in security audit:
  - conversations: a fast double-click on "open chat" produced two rows
    sharing the same (account_id, peer_jid) — UI showed duplicates and
    messages were split between them.
  - contacts: same shape on (account_id, jid) — roster updates from
    concurrent XMPP presence streams duplicated entries.
  - plugin_settings: concurrent settings PUT created multiple rows for
    the same (plugin_id, account_id) — `get` returned arbitrary one.

Existing duplicates need to be reconciled BEFORE adding the constraint.
We pick the most recently-touched row to keep and delete others.

The composite indexes accelerate the hot read paths that were doing
sort-on-the-fly:
  - Conversation list: WHERE account_id = X AND archived = false
                       ORDER BY last_message_at DESC
  - Message list:      WHERE conversation_id = X
                       ORDER BY created_at DESC LIMIT 50

OPERATIONAL WARNING — run during a maintenance window on large databases:
  The dedup DELETEs and the CREATE INDEX statements both hold locks
  (row locks for DELETE, ShareLock on the table for non-CONCURRENT
  CREATE INDEX). On a small DB (<1M messages, <10K conversations) this
  finishes in seconds. On a large production database (10M+ messages)
  the trigram GIN index can take 5-30 minutes and BLOCKS WRITES TO THE
  TABLE during creation. If your database is large enough to feel this:
    1. Stop the API briefly OR
    2. Manually run `CREATE INDEX CONCURRENTLY` for ix_messages_conv_created
       and ix_messages_body_trgm BEFORE running this migration, then
       comment those lines out in this file.
  The dedup DELETEs are typically fast (small tables) but if you've
  accumulated thousands of duplicate plugin_settings rows over months,
  consider pre-deleting them in batches before running this.

Revision ID: 0008_race_fix_and_perf_indexes
Revises: 0007_attach_object_key_idx
"""
from alembic import op
import sqlalchemy as sa


revision = "0008_race_fix_and_perf_indexes"
down_revision = "0007_attach_object_key_idx"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ===== Reconcile existing duplicates BEFORE adding UNIQUE =====
    # Without this, ALTER TABLE will fail on systems that have already
    # accumulated dupes from the race window.

    # conversations: keep the row whose last_message_at is most recent
    # (or created_at if last_message_at is null)
    op.execute(
        """
        DELETE FROM conversations
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY account_id, peer_jid
                           ORDER BY COALESCE(last_message_at, created_at) DESC, id
                       ) AS rn
                FROM conversations
            ) t
            WHERE t.rn > 1
        )
        """
    )

    # contacts: keep the row with newest last_seen_at, ties broken by id
    op.execute(
        """
        DELETE FROM contacts
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY account_id, jid
                           ORDER BY COALESCE(last_seen_at, '1970-01-01'::timestamptz) DESC, id
                       ) AS rn
                FROM contacts
            ) t
            WHERE t.rn > 1
        )
        """
    )

    # plugin_settings: account_id can be NULL (global settings), so handle
    # NULL specially. Use coalesce trick for the partition key.
    op.execute(
        """
        DELETE FROM plugin_settings
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY plugin_id, COALESCE(account_id, '__GLOBAL__')
                           ORDER BY COALESCE(updated_at, '1970-01-01'::timestamptz) DESC, id
                       ) AS rn
                FROM plugin_settings
            ) t
            WHERE t.rn > 1
        )
        """
    )

    # ===== UNIQUE constraints (race protection) =====
    op.create_unique_constraint(
        "uq_conversations_account_peer", "conversations", ["account_id", "peer_jid"]
    )
    op.create_unique_constraint(
        "uq_contacts_account_jid", "contacts", ["account_id", "jid"]
    )
    # plugin_settings.account_id is nullable; UNIQUE in PostgreSQL treats
    # NULLs as distinct (so NULL global rows wouldn't conflict). We instead
    # use a partial unique index for the global case, plus a regular UNIQUE
    # for the per-account case.
    op.create_index(
        "uq_plugin_settings_per_account",
        "plugin_settings",
        ["plugin_id", "account_id"],
        unique=True,
        postgresql_where=sa.text("account_id IS NOT NULL"),
    )
    op.create_index(
        "uq_plugin_settings_global",
        "plugin_settings",
        ["plugin_id"],
        unique=True,
        postgresql_where=sa.text("account_id IS NULL"),
    )

    # ===== Performance indexes =====
    # Hot path: conversation list filtered by account, sorted by recency.
    # The existing per-column index on account_id alone forces a sort on
    # last_message_at; this composite is index-only friendly.
    op.create_index(
        "ix_conversations_account_recency",
        "conversations",
        ["account_id", "archived", sa.text("last_message_at DESC")],
    )

    # Hot path: message list per conversation, newest first.
    op.create_index(
        "ix_messages_conv_created",
        "messages",
        ["conversation_id", sa.text("created_at DESC")],
    )

    # Hot path: messages search uses ilike on body — full table scan.
    # pg_trgm gives ilike a real index. Make extension creation conditional
    # since some hosted Postgres setups (RDS, etc.) require manual extension
    # whitelisting. Wrap in try/except style via DO block.
    op.execute(
        """
        DO $$ BEGIN
            CREATE EXTENSION IF NOT EXISTS pg_trgm;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'pg_trgm not enabled (insufficient privilege); search will be slow without it';
        WHEN undefined_file THEN
            RAISE NOTICE 'pg_trgm contrib package not installed; search will be slow without it';
        END $$;
        """
    )
    # gin_trgm_ops only works if pg_trgm was enabled successfully;
    # otherwise this CREATE INDEX would fail. Wrap defensively.
    op.execute(
        """
        DO $$ BEGIN
            EXECUTE 'CREATE INDEX IF NOT EXISTS ix_messages_body_trgm
                     ON messages USING gin (body gin_trgm_ops)';
        EXCEPTION WHEN undefined_object THEN
            RAISE NOTICE 'gin_trgm_ops unavailable; ilike search will be slow';
        END $$;
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_messages_body_trgm")
    op.drop_index("ix_messages_conv_created", "messages")
    op.drop_index("ix_conversations_account_recency", "conversations")
    op.drop_index("uq_plugin_settings_global", "plugin_settings")
    op.drop_index("uq_plugin_settings_per_account", "plugin_settings")
    op.drop_constraint("uq_contacts_account_jid", "contacts", type_="unique")
    op.drop_constraint("uq_conversations_account_peer", "conversations", type_="unique")
