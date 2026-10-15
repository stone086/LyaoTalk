"""Tests for webhook endpoints."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.core.database import get_db


@pytest.mark.anyio
async def test_trigger_webhook_401_invalid_token():
    """Webhook trigger rejects invalid webhook_id/token."""
    class _Result:
        def scalar_one_or_none(self):
            return None

    class _DB:
        async def execute(self, _statement):
            return _Result()

    async def _get_db():
        yield _DB()

    app.dependency_overrides[get_db] = _get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/webhooks/fake-id/fake-token",
                json={"message": "test"},
            )
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_create_webhook_requires_admin():
    """Creating a webhook requires admin auth."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/webhooks",
            json={"name": "test", "conversation_id": "fake"},
        )
    assert resp.status_code in (401, 403)
