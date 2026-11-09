"""Keep one device notification subscription per account.

Revision ID: 0014_one_push_per_account
Revises: 0013_ntfy_subscriptions
"""
from alembic import op
import sqlalchemy as sa

revision = "0014_one_push_per_account"
down_revision = "0013_ntfy_subscriptions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("""
        DELETE FROM push_subscriptions WHERE id IN (
            SELECT id FROM (
                SELECT id, row_number() OVER (
                    PARTITION BY account_id ORDER BY created_at DESC, id DESC
                ) AS position FROM push_subscriptions
            ) ranked WHERE position > 1
        )
    """))
    # ntfy topics can be followed by multiple devices and cannot be revoked
    # independently. Users can enable the device-specific PWA subscription.
    op.execute(sa.text("DELETE FROM ntfy_subscriptions"))
    op.create_unique_constraint("uq_push_subscriptions_one_per_account", "push_subscriptions", ["account_id"])


def downgrade() -> None:
    op.drop_constraint("uq_push_subscriptions_one_per_account", "push_subscriptions", type_="unique")
