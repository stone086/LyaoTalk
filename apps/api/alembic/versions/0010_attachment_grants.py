"""Grant explicitly shared attachments to a recipient account.

Revision ID: 0010_attachment_grants
Revises: 0009_attachment_owner_account
"""
from alembic import op
import sqlalchemy as sa

revision = "0010_attachment_grants"
down_revision = "0009_attachment_owner_account"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "attachment_grants",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("attachment_id", sa.String(), sa.ForeignKey("attachments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("account_id", sa.String(), sa.ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False),
        sa.UniqueConstraint("attachment_id", "account_id", name="uq_attachment_grant_account"),
    )
    op.create_index("ix_attachment_grants_attachment_id", "attachment_grants", ["attachment_id"])
    op.create_index("ix_attachment_grants_account_id", "attachment_grants", ["account_id"])


def downgrade() -> None:
    op.drop_index("ix_attachment_grants_account_id", table_name="attachment_grants")
    op.drop_index("ix_attachment_grants_attachment_id", table_name="attachment_grants")
    op.drop_table("attachment_grants")
