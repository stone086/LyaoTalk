"""call logs

Revision ID: 0004_call_logs
Revises: 0003_webhooks
Create Date: 2026-04-22
"""
from alembic import op
import sqlalchemy as sa


revision = "0004_call_logs"
down_revision = "0003_webhooks"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "call_logs",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("account_id", sa.String(), nullable=False),
        sa.Column("peer_jid", sa.String(), nullable=False),
        sa.Column("direction", sa.String(), nullable=False),
        sa.Column("media_types", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_call_logs_account_id", "call_logs", ["account_id"])
    op.create_index("ix_call_logs_started_at", "call_logs", ["started_at"])


def downgrade():
    op.drop_index("ix_call_logs_started_at", table_name="call_logs")
    op.drop_index("ix_call_logs_account_id", table_name="call_logs")
    op.drop_table("call_logs")
