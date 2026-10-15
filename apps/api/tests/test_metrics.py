"""Tests for metrics endpoints."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.anyio
async def test_web_vitals_accepts_valid_batch():
    """Web vitals endpoint accepts valid reports."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/metrics/web-vitals",
            json={
                "reports": [
                    {
                        "name": "LCP",
                        "value": 1200.5,
                        "rating": "good",
                        "url": "https://chat.example.com/",
                        "timestamp": 1700000000,
                    }
                ]
            },
        )
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_web_vitals_rejects_invalid_name():
    """Web vitals endpoint rejects unknown metric names."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/metrics/web-vitals",
            json={
                "reports": [
                    {
                        "name": "FAKE_METRIC",
                        "value": 100,
                        "rating": "good",
                        "url": "https://chat.example.com/",
                        "timestamp": 1700000000,
                    }
                ]
            },
        )
    assert resp.status_code == 422
