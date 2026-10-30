import asyncio

import pytest
from fastapi import HTTPException

from app.api.routers import push
from app.models import NtfySubscription
from app.services import ntfy


class FakeResult:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value

    def scalars(self):
        return self

    def all(self):
        return []


class FakeDB:
    def __init__(self, row=None):
        self.row = row
        self.committed = False

    async def get(self, model, account_id):
        return self.row if self.row and self.row.account_id == account_id else None

    def add(self, row):
        self.row = row

    async def commit(self):
        self.committed = True

    async def execute(self, query):
        return FakeResult(self.row if self.row and "ntfy_subscriptions" in str(query) else None)


def test_ntfy_enable_is_per_account_and_idempotent(monkeypatch):
    monkeypatch.setattr(push, "ntfy_ready", lambda: True)
    monkeypatch.setattr(push.settings, "NTFY_PUBLIC_URL", "https://ntfy.example.com")
    db = FakeDB()
    user = {"account_id": "alice"}
    first = asyncio.run(push.ntfy_enable.__wrapped__(request=None, db=db, current_user=user))
    second = asyncio.run(push.ntfy_enable.__wrapped__(request=None, db=db, current_user=user))
    assert db.committed
    assert first == second
    assert first["topic"].startswith("lt_") and len(first["topic"]) == 35
    assert first["node"].startswith("ntfy_")
    assert first["topic"] != first["node"]
    assert asyncio.run(push.ntfy_status(db=db, current_user={"account_id": "bob"})) == {"enabled": False}


def test_ntfy_test_requires_own_subscription(monkeypatch):
    called = []

    async def publish(topic):
        called.append(topic)
        return True

    monkeypatch.setattr(push, "publish_ntfy", publish)
    db = FakeDB(NtfySubscription(account_id="alice", topic="lt_" + "a" * 32, node="ntfy_" + "b" * 32))
    with pytest.raises(HTTPException) as error:
        asyncio.run(push.ntfy_test.__wrapped__(request=None, db=db, current_user={"account_id": "bob"}))
    assert error.value.status_code == 404 and called == []
    asyncio.run(push.ntfy_test.__wrapped__(request=None, db=db, current_user={"account_id": "alice"}))
    assert called == ["lt_" + "a" * 32]


def test_notify_dispatches_ntfy_without_web_subscription(monkeypatch):
    calls = []

    async def publish(topic, *, message_id=None):
        calls.append(topic)
        return False  # Failure must not turn a valid Prosody request into 500.

    monkeypatch.setattr(push, "publish_ntfy", publish)
    monkeypatch.setattr(push.settings, "PUSH_SHARED_SECRET", "test-secret")
    row = NtfySubscription(account_id="alice", topic="lt_" + "a" * 32, node="ntfy_" + "b" * 32)
    db = FakeDB(row)
    result = asyncio.run(push.notify(push.PushNotifyRequest(node=row.node, title="Sender", body="private message", secret="test-secret"), db=db))
    assert result == {"status": "no_subscriptions", "ntfy_sent": False}
    assert calls == [row.topic]


def test_ntfy_deduplicates_only_matching_message_ids(monkeypatch):
    monkeypatch.setattr(ntfy.settings, "NTFY_INTERNAL_URL", "http://127.0.0.1:2586")
    monkeypatch.setattr(ntfy.settings, "NTFY_PUBLIC_URL", "https://ntfy.example.com")
    monkeypatch.setattr(ntfy.settings, "NTFY_PUBLISH_TOKEN", "test-token")
    sent = []
    keys = set()

    class Cache:
        async def set(self, key, value, ex, nx):
            assert ex == 86400 and nx is True
            if key in keys:
                return False
            keys.add(key)
            return True

    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, *args, **kwargs):
            sent.append(1)
            return type("Response", (), {"status_code": 200})()

    async def cache(): return Cache()
    monkeypatch.setattr(ntfy, "get_redis", cache)
    monkeypatch.setattr(ntfy.httpx, "AsyncClient", Client)
    topic = "lt_" + "a" * 32
    first = "a" * 64
    second = "b" * 64
    assert asyncio.run(ntfy.publish_ntfy(topic, message_id=first))
    assert asyncio.run(ntfy.publish_ntfy(topic, message_id=first))
    assert asyncio.run(ntfy.publish_ntfy(topic, message_id=second))
    assert sent == [1, 1]


def test_ntfy_publisher_sends_generic_content_only(monkeypatch):
    monkeypatch.setattr(ntfy.settings, "NTFY_INTERNAL_URL", "http://127.0.0.1:2586")
    monkeypatch.setattr(ntfy.settings, "NTFY_PUBLIC_URL", "https://ntfy.example.com")
    monkeypatch.setattr(ntfy.settings, "NTFY_PUBLISH_TOKEN", "test-token")
    monkeypatch.setattr(ntfy.settings, "FRONTEND_URL", "https://example.com")
    sent = []

    class Response:
        status_code = 200

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, content, headers):
            sent.append((url, content, headers))
            return Response()

    monkeypatch.setattr(ntfy.httpx, "AsyncClient", Client)
    assert asyncio.run(ntfy.publish_ntfy("lt_" + "a" * 32))
    assert sent[0][1] == "你有新消息"
    assert sent[0][2]["Click"] == "https://example.com/"
    assert not asyncio.run(ntfy.publish_ntfy("someone-elses-topic"))
