"""push subscriptions table

Revision ID: 0002_push_subscriptions
Revises: 0001_initial
Create Date: 2026-04-22

"""
from alembic import op
import sqlalchemy as sa


revision = "0002_push_subscriptions"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("account_id", sa.String(), nullable=False),
        sa.Column("endpoint", sa.String(), nullable=False),
        sa.Column("p256dh", sa.String(), nullable=False),
        sa.Column("auth", sa.String(), nullable=False),
        sa.Column("user_agent", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("endpoint"),
    )
    op.create_index("ix_push_subscriptions_account_id", "push_subscriptions", ["account_id"])


def downgrade():
    op.drop_index("ix_push_subscriptions_account_id", table_name="push_subscriptions")
    op.drop_table("push_subscriptions")
