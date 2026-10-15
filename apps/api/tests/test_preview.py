"""Tests for link preview endpoint."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.anyio
async def test_preview_rejects_localhost():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/preview", params={"url": "http://localhost/admin"})
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_preview_rejects_private_ip():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/preview", params={"url": "http://192.168.1.1/"})
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_preview_rejects_non_http():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/preview", params={"url": "file:///etc/passwd"})
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_preview_requires_url_param():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/preview")
    assert resp.status_code == 422  # missing required param
