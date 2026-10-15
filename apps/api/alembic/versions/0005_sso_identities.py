"""sso identities

Revision ID: 0005_sso_identities
Revises: 0004_call_logs
Create Date: 2026-05-01
"""
from alembic import op
import sqlalchemy as sa


revision = "0005_sso_identities"
down_revision = "0004_call_logs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sso_identities",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("account_id", sa.String(36), sa.ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),  # "oidc" or "ldap"
        sa.Column("provider_sub", sa.String(512), nullable=False),  # OIDC sub claim or LDAP DN
        sa.Column("provider_email", sa.String(256), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("provider", "provider_sub", name="uq_sso_provider_sub"),
    )
    op.create_index("ix_sso_identities_account_id", "sso_identities", ["account_id"])


def downgrade() -> None:
    op.drop_index("ix_sso_identities_account_id")
    op.drop_table("sso_identities")
