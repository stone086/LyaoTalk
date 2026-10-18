import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.api.routers.push import PushSubscriptionRequest, _notification_tag, subscribe


def test_notification_tag_is_stable_and_isolates_nodes():
    first = _notification_tag("device-a", "shared-secret")
    assert first == _notification_tag("device-a", "shared-secret")
    assert first != _notification_tag("device-b", "shared-secret")
    assert first != _notification_tag("device-a", "rotated-secret")
    assert "device-a" not in first
    assert len(first) <= 32


def test_concurrent_node_claim_returns_conflict_and_rolls_back():
    class Result:
        def scalar_one_or_none(self):
            return None

    class DB:
        rolled_back = False

        async def execute(self, statement):
            return Result()

        def add(self, item):
            pass

        async def commit(self):
            raise IntegrityError("INSERT", {}, Exception("unique violation"))

        async def rollback(self):
            self.rolled_back = True

    db = DB()
    payload = PushSubscriptionRequest(
        endpoint="https://fcm.googleapis.com/test",
        node="device_a",
        p256dh="key",
        auth="auth",
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(subscribe.__wrapped__(
            request=None,
            payload=payload,
            db=db,
            current_user={"account_id": "account-a"},
        ))
    assert caught.value.status_code == 409
    assert db.rolled_back
