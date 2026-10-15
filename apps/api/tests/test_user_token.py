"""Tests for the /auth/user-token endpoint."""
from unittest.mock import MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.config import settings
from app.core.database import get_db
from app.main import app
from app.models import Account


@pytest.fixture(autouse=True)
def xmpp_domain_settings():
    original_xmpp_domain = settings.XMPP_DOMAIN
    original_public_domain = settings.PUBLIC_DOMAIN
    settings.XMPP_DOMAIN = "test.com"
    settings.PUBLIC_DOMAIN = "test.com"
    try:
        yield
    finally:
        settings.XMPP_DOMAIN = original_xmpp_domain
        settings.PUBLIC_DOMAIN = original_public_domain


def _mock_account(enabled: bool = True):
    acc = MagicMock(spec=Account)
    acc.id = "acc-123"
    acc.jid = "alice@test.com"
    acc.is_enabled = enabled
    return acc


@pytest.mark.anyio
async def test_user_token_requires_password():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/auth/user-token",
            json={"jid": "alice@test.com", "password": ""},
        )
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_user_token_rejects_wrong_password():
    transport = ASGITransport(app=app)
    with patch("app.api.routers.auth._verify_xmpp_sasl_plain", return_value=False):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/auth/user-token",
                json={"jid": "alice@test.com", "password": "wrongpass"},
            )
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_user_token_creates_unknown_local_account():
    class _MissingResult:
        @staticmethod
        def scalar_one_or_none():
            return None

    class _FakeDB:
        def __init__(self):
            self.added = []

        async def execute(self, *args, **kwargs):
            return _MissingResult()

        def add(self, obj):
            self.added.append(obj)

        async def commit(self):
            return None

        async def rollback(self):
            return None

        async def refresh(self, obj):
            return None

    fake_db = _FakeDB()

    async def _fake_get_db():
        yield fake_db

    app.dependency_overrides[get_db] = _fake_get_db
    transport = ASGITransport(app=app)
    try:
        with patch("app.api.routers.auth._verify_xmpp_sasl_plain", return_value=True):
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/auth/user-token",
                    json={"jid": "nobody@test.com", "password": "password123"},
                )
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert resp.status_code == 200
    assert resp.json()["jid"] == "nobody@test.com"
    assert len(fake_db.added) == 2


@pytest.mark.anyio
async def test_user_token_rejects_disabled_account():
    disabled_account = _mock_account(enabled=False)

    class _DisabledResult:
        @staticmethod
        def scalar_one_or_none():
            return disabled_account

    class _FakeDB:
        async def execute(self, *args, **kwargs):
            return _DisabledResult()

    async def _fake_get_db():
        yield _FakeDB()

    app.dependency_overrides[get_db] = _fake_get_db
    transport = ASGITransport(app=app)
    try:
        with patch("app.api.routers.auth._verify_xmpp_sasl_plain", return_value=True):
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/auth/user-token",
                    json={"jid": "alice@test.com", "password": "correctpass"},
                )
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert resp.status_code == 403
