"""Tests for message search endpoint."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.core.database import get_db
from app.main import app
from app.utils.security import create_access_token


def make_admin_token() -> str:
    return create_access_token("admin", role="admin")


@pytest.mark.anyio
async def test_search_requires_account_id():
    token = make_admin_token()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(
            "/messages/search",
            params={"q": "hello"},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 400
    assert "account_id" in resp.json().get("detail", "").lower()


@pytest.mark.anyio
async def test_search_requires_auth():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(
            "/messages/search",
            params={"q": "hello", "account_id": "some-id"},
        )
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_search_with_valid_params_returns_list():
    class _Scalars:
        @staticmethod
        def all():
            return []

    class _Result:
        @staticmethod
        def scalars():
            return _Scalars()

    class _FakeDB:
        async def execute(self, *args, **kwargs):
            return _Result()

    async def _fake_get_db():
        yield _FakeDB()

    token = make_admin_token()
    app.dependency_overrides[get_db] = _fake_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(
                "/messages/search",
                params={"q": "test_query_xyz_no_results", "account_id": "nonexistent-account"},
                headers={"Authorization": f"Bearer {token}"},
            )
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
