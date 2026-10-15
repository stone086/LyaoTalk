"""webhooks table

Revision ID: 0003_webhooks
Revises: 0002_push_subscriptions
Create Date: 2026-04-22

"""
from alembic import op
import sqlalchemy as sa


revision = "0003_webhooks"
down_revision = "0002_push_subscriptions"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "webhooks",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("conversation_id", sa.String(), nullable=False),
        sa.Column("token", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade():
    op.drop_table("webhooks")
