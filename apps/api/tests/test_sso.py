"""Tests for SSO endpoints."""
import os
import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import patch

from app.main import app


@pytest.mark.anyio
async def test_sso_providers_returns_disabled_by_default():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/sso/providers")
    assert resp.status_code == 200
    data = resp.json()
    assert data["oidc"] is False
    assert data["ldap"] is False


@pytest.mark.anyio
async def test_oidc_login_404_when_disabled():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/sso/oidc/login")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_ldap_login_400_no_password():
    with patch.dict(os.environ, {"LDAP_ENABLED": "true", "LDAP_SERVER": "ldap://x"}):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/sso/ldap/login",
                json={"username": "alice", "password": ""},
            )
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_ldap_login_404_when_disabled():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/sso/ldap/login",
            json={"username": "alice", "password": "x"},
        )
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_oidc_exchange_invalid_code_returns_401():
    """Exchange endpoint rejects invalid/expired codes."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/sso/oidc/exchange",
            params={"code": "nonexistent-code"},
        )
    assert resp.status_code == 401


def test_oidc_jid_collision_resistance():
    """Two users with same display name but different sub get different JIDs."""
    from app.api.routers.sso import _oidc_jid
    jid_a = _oidc_jid("sub-user-aaa-111", "John Smith")
    jid_b = _oidc_jid("sub-user-bbb-222", "John Smith")
    assert jid_a != jid_b
    # Both should contain the sanitized name
    assert "john_smith" in jid_a
    assert "john_smith" in jid_b


def test_sanitize_username():
    """Username sanitizer handles edge cases."""
    from app.api.routers.sso import _sanitize_username
    assert _sanitize_username("John Smith") == "john_smith"
    assert _sanitize_username("  Über Héro!  ") == "ber_hro"
    assert _sanitize_username("") == "user"
    assert len(_sanitize_username("a" * 200)) <= 64


@pytest.mark.anyio
async def test_sso_providers_labels():
    """Provider list returns configured labels."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/sso/providers")
    data = resp.json()
    assert "oidc_label" in data
    assert "ldap_label" in data
