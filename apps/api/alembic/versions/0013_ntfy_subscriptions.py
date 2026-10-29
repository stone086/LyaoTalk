"""Add per-account ntfy topics and XMPP push nodes.

Revision ID: 0013_ntfy_subscriptions
Revises: 0012_webhook_signing_secrets
"""
from alembic import op
import sqlalchemy as sa

revision = "0013_ntfy_subscriptions"
down_revision = "0012_webhook_signing_secrets"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ntfy_subscriptions",
        sa.Column("account_id", sa.String(), sa.ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("topic", sa.String(length=64), nullable=False, unique=True),
        sa.Column("node", sa.String(length=128), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("ntfy_subscriptions")
