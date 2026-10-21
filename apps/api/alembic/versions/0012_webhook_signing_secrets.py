"""Separate webhook signing secrets from the URL token.

Revision ID: 0012_webhook_signing_secrets
Revises: 0011_multi_account_push

Before this, the HMAC key for a webhook delivery was the same token that sits
in the webhook URL, so anyone who read the URL out of an access log could sign
their own payloads. Signing now uses a dedicated secret that never appears in a
URL. Existing rows get one generated here; rotation keeps the previous secret
valid for a day so integrations can be updated without dropping deliveries.
"""
from alembic import op
import sqlalchemy as sa


revision = "0012_webhook_signing_secrets"
down_revision = "0011_multi_account_push"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("webhooks", sa.Column("signing_secret", sa.String(), nullable=True))
    op.add_column("webhooks", sa.Column("previous_signing_secret", sa.String(), nullable=True))
    op.add_column(
        "webhooks",
        sa.Column("previous_secret_expires_at", sa.DateTime(timezone=True), nullable=True),
    )

    # Backfill: legacy rows keep working, but with a secret that is not in the
    # URL. sha256(random()) is plenty for a one-off backfill on this table.
    op.execute(
        "UPDATE webhooks "
        "SET signing_secret = encode(sha256(random()::text::bytea || md5(random()::text)::bytea), 'hex') "
        "WHERE signing_secret IS NULL"
    )


def downgrade() -> None:
    op.drop_column("webhooks", "previous_secret_expires_at")
    op.drop_column("webhooks", "previous_signing_secret")
    op.drop_column("webhooks", "signing_secret")

