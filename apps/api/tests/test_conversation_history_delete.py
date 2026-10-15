"""Deleting a chat is account-scoped and removes its indexed records."""
import pytest
from fastapi import HTTPException

from app.api.routers.messages import clear_conversation_history


class _Result:
    rowcount = 2


class _DB:
    def __init__(self):
        self.statements = []
        self.committed = False

    async def execute(self, statement):
        self.statements.append(statement)
        return _Result()

    async def commit(self):
        self.committed = True


@pytest.mark.anyio
async def test_delete_conversation_rejects_another_account():
    db = _DB()
    with pytest.raises(HTTPException) as exc:
        await clear_conversation_history(
            "account-a", "peer@example.com",
            {"role": "user", "account_id": "account-b"}, db,
        )
    assert exc.value.status_code == 403
    assert not db.statements


@pytest.mark.anyio
async def test_delete_conversation_scopes_all_deletes_to_account_and_peer():
    db = _DB()
    result = await clear_conversation_history(
        "account-a", "Peer@Example.com/mobile",
        {"role": "user", "account_id": "account-a"}, db,
    )
    assert result == {"ok": True, "deleted": 2}
    assert db.committed
    assert len(db.statements) == 4
    for statement in db.statements:
        compiled = statement.compile()
        assert "account-a" in compiled.params.values()
        assert "peer@example.com" in compiled.params.values()
