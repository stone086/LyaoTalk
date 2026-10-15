"""Tests for plugin access and toggles."""
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.routers import plugins as plugins_router
from app.core.database import get_db
from app.main import app
from app.utils.security import create_access_token


def _user_headers() -> dict[str, str]:
    token = create_access_token("alice@example.com", role="user", account_id="acc-1")
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.anyio
async def test_plugins_require_login():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/plugins/")
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_user_token_can_list_plugins(monkeypatch):
    plugin = SimpleNamespace(
        id="ai-summary",
        name="AI Summary",
        version="1.0.0",
        is_enabled=False,
        permission_json=["messages.read", "api.ai"],
    )

    class _Scalars:
        @staticmethod
        def all():
            return [plugin]

    class _Result:
        @staticmethod
        def scalars():
            return _Scalars()

    class _FakeDB:
        async def execute(self, *args, **kwargs):
            return _Result()

    async def _fake_ensure_plugins(db):
        return None

    async def _fake_get_db():
        yield _FakeDB()

    monkeypatch.setattr(plugins_router, "ensure_plugins", _fake_ensure_plugins)
    app.dependency_overrides[get_db] = _fake_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/plugins/", headers=_user_headers())
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert resp.status_code == 200
    assert resp.json()[0]["id"] == "ai-summary"


@pytest.mark.anyio
async def test_user_token_cannot_enable_plugin():
    plugin = SimpleNamespace(id="ai-summary", is_enabled=False)

    class _Result:
        @staticmethod
        def scalar_one_or_none():
            return plugin

    class _FakeDB:
        def __init__(self):
            self.committed = False

        async def execute(self, *args, **kwargs):
            return _Result()

        async def commit(self):
            self.committed = True

    fake_db = _FakeDB()

    async def _fake_get_db():
        yield fake_db

    app.dependency_overrides[get_db] = _fake_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/plugins/ai-summary/enable", headers=_user_headers())
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert resp.status_code == 403
    assert plugin.is_enabled is False
    assert fake_db.committed is False
