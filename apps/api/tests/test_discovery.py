"""Tests for discovery / health endpoints."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.core.database import get_db
from app.main import app


@pytest.mark.anyio
async def test_health_returns_version():
    class _CountResult:
        @staticmethod
        def scalar():
            return 0

    class _FakeDB:
        async def execute(self, *args, **kwargs):
            return _CountResult()

    async def _fake_get_db():
        yield _FakeDB()

    app.dependency_overrides[get_db] = _fake_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/discovery/health")
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert resp.status_code == 200
    data = resp.json()
    assert "version" in data
    assert "uptime_seconds" in data
    assert isinstance(data["uptime_seconds"], int)
    assert data["uptime_seconds"] >= 0


@pytest.mark.anyio
async def test_groups_returns_list():
    class _RowsResult:
        def __iter__(self):
            return iter([])

    class _FakeDB:
        async def execute(self, *args, **kwargs):
            return _RowsResult()

    async def _fake_get_db():
        yield _FakeDB()

    app.dependency_overrides[get_db] = _fake_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/discovery/groups")
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
