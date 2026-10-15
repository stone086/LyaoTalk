"""add object_key index for auth-check

Revision ID: 0007_attach_object_key_idx
Revises: 0006_perf_indexes
Create Date: 2026-05-07
"""
from alembic import op


revision = "0007_attach_object_key_idx"
down_revision = "0006_perf_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Used by /api/attachments/auth-check called on every /files/* request.
    # Without this, every download triggers a full sequential scan of attachments.
    op.create_index(
        "ix_attachments_object_key",
        "attachments",
        ["object_key"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_attachments_object_key")
