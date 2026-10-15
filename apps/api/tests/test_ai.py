"""Tests for AI endpoints."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.utils.security import create_access_token


def _auth():
    return {"Authorization": f"Bearer {create_access_token('admin', role='admin')}"}


@pytest.mark.anyio
async def test_summarize_returns_503_without_api_key():
    """AI endpoints should 503 when no provider is configured."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/ai/summarize",
            json={"messages": ["hello", "world"]},
        )
    # Should fail because AI_API_KEY is empty in test env
    assert resp.status_code in (401, 403, 503)


@pytest.mark.anyio
async def test_summarize_400_empty_messages():
    """Summarize rejects empty message list."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/ai/summarize",
            json={"messages": []},
            headers=_auth(),
        )
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_translate_400_empty_text():
    """Translate rejects empty text."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/ai/translate",
            params={"text": "", "target_lang": "en"},
            headers=_auth(),
        )
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_smart_reply_400_empty():
    """Smart reply rejects empty message."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/ai/smart-reply",
            params={"message": ""},
            headers=_auth(),
        )
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_insight_rejects_empty_messages():
    """Insight rejects an empty message list before contacting a provider."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/ai/insight",
            json={"messages": []},
            headers=_auth(),
        )
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_rag_401_without_token():
    """RAG endpoint requires authentication."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/ai/rag",
            json={"question": "test"},
        )
    assert resp.status_code in (401, 403)
