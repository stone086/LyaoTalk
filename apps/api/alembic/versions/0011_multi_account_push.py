"""Allow one browser push endpoint to serve multiple accounts.

Revision ID: 0011_multi_account_push
Revises: 0010_attachment_grants
"""
from alembic import op
import sqlalchemy as sa

revision = "0011_multi_account_push"
down_revision = "0010_attachment_grants"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Batch mode also handles SQLite, where an unnamed UNIQUE constraint
    # cannot be removed with a direct ALTER TABLE.
    naming = {"uq": "uq_%(table_name)s_%(column_0_name)s"}
    with op.batch_alter_table("push_subscriptions", naming_convention=naming) as batch:
        batch.drop_constraint("uq_push_subscriptions_endpoint", type_="unique")
        batch.add_column(sa.Column("node", sa.String(), nullable=True))
        batch.create_unique_constraint(
            "uq_push_subscriptions_account_endpoint", ["account_id", "endpoint"]
        )
        batch.create_unique_constraint("uq_push_subscriptions_node", ["node"])


def downgrade() -> None:
    # The old schema permits only one account per endpoint. Keep one row for
    # each endpoint so the old unique constraint can be restored.
    op.execute(sa.text(
        "DELETE FROM push_subscriptions WHERE id NOT IN "
        "(SELECT MIN(id) FROM push_subscriptions GROUP BY endpoint)"
    ))
    with op.batch_alter_table("push_subscriptions") as batch:
        batch.drop_constraint("uq_push_subscriptions_node", type_="unique")
        batch.drop_constraint("uq_push_subscriptions_account_endpoint", type_="unique")
        batch.drop_column("node")
        batch.create_unique_constraint("uq_push_subscriptions_endpoint", ["endpoint"])
