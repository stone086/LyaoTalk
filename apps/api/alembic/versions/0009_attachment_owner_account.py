"""Track attachment owner account for unlinked uploads.

Revision ID: 0009_attachment_owner_account
Revises: 0008_race_fix_and_perf_indexes
"""
from alembic import op
import sqlalchemy as sa


revision = "0009_attachment_owner_account"
down_revision = "0008_race_fix_and_perf_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("attachments", sa.Column("owner_account_id", sa.String(), nullable=True))
    op.create_index("ix_attachments_owner_account_id", "attachments", ["owner_account_id"])
    op.create_foreign_key(
        "fk_attachments_owner_account_id_accounts",
        "attachments",
        "accounts",
        ["owner_account_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_attachments_owner_account_id_accounts", "attachments", type_="foreignkey")
    op.drop_index("ix_attachments_owner_account_id", table_name="attachments")
    op.drop_column("attachments", "owner_account_id")
