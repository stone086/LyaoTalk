"""Account-wide session fences and cross-account logout isolation."""
import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.core.database import get_db
from app.utils import security
from app.services import prosody_revision


def _pair(jid: str, account_id: str, revision: str | None = None):
    return (
        security.create_access_token(jid, role="user", account_id=account_id, credential_revision=revision),
        security.create_refresh_token(jid, role="user", account_id=account_id, credential_revision=revision),
    )


def test_session_rotation_is_account_scoped():
    alice = _pair("alice@example.com", "alice")
    bob = _pair("bob@example.com", "bob")
    assert security.decode_token(alice[0])["sub"] == "alice@example.com"
    security.rotate_session_version("alice")
    for token, kind in zip(alice, ("access", "refresh")):
        with pytest.raises(HTTPException) as error:
            security.decode_token(token, expected_type=kind)
        assert error.value.status_code == 401
    assert security.decode_token(bob[0])["sub"] == "bob@example.com"
    assert security.decode_token(bob[1], expected_type="refresh")["sub"] == "bob@example.com"


def test_direct_prosody_password_change_invalidates_access_and_refresh(monkeypatch):
    current = {"value": "a" * 64}
    monkeypatch.setattr(prosody_revision, "get_credential_revision", lambda jid: current["value"])
    access, refresh = _pair("alice@example.com", "alice", current["value"])
    assert security.decode_token(access)["cv"] == current["value"]
    current["value"] = "b" * 64
    for token, kind in ((access, "access"), (refresh, "refresh")):
        with pytest.raises(HTTPException) as error:
            security.decode_token(token, expected_type=kind)
        assert error.value.status_code == 401


@pytest.mark.anyio
async def test_multi_account_logout_and_wrong_token_pair():
    alice = _pair("alice@example.com", "alice")
    bob = _pair("bob@example.com", "bob")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        mixed = await client.post(
            "/auth/logout", headers={"Authorization": f"Bearer {alice[0]}"},
            json={"refresh_token": bob[1]},
        )
        assert mixed.status_code == 403
        assert security.decode_token(alice[0])["account_id"] == "alice"
        assert security.decode_token(bob[1], expected_type="refresh")["account_id"] == "bob"

        own = await client.post(
            "/auth/logout", headers={"Authorization": f"Bearer {alice[0]}"},
            json={"refresh_token": alice[1]},
        )
        assert own.status_code == 200
        assert set(own.json()["revoked"]) == {"access", "refresh"}

    for token, kind in ((alice[0], "access"), (alice[1], "refresh")):
        with pytest.raises(HTTPException):
            security.decode_token(token, expected_type=kind)
    assert security.decode_token(bob[0])["account_id"] == "bob"
    assert security.decode_token(bob[1], expected_type="refresh")["account_id"] == "bob"


@pytest.mark.anyio
async def test_refresh_preserves_credential_version_and_rejects_old_password(monkeypatch):
    current = {"value": "a" * 64}
    monkeypatch.setattr(prosody_revision, "get_credential_revision", lambda jid: current["value"])
    access, refresh = _pair("alice@example.com", "alice", current["value"])

    class _Account:
        id = "alice"
        jid = "alice@example.com"
        is_enabled = True

    class _Result:
        def scalar_one_or_none(self):
            return _Account()

    class _DB:
        async def execute(self, *args, **kwargs):
            return _Result()

    async def _fake_db():
        yield _DB()

    app.dependency_overrides[get_db] = _fake_db
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            rotated = await client.post("/auth/refresh", json={"refresh_token": refresh})
            assert rotated.status_code == 200
            new_access = rotated.json()["access_token"]
            new_refresh = rotated.json()["refresh_token"]
            assert security.decode_token(new_access)["cv"] == current["value"]
            reused = await client.post("/auth/refresh", json={"refresh_token": refresh})
            assert reused.status_code == 401
            current["value"] = "b" * 64
            expired = await client.post("/auth/refresh", json={"refresh_token": new_refresh})
            assert expired.status_code == 401
            with pytest.raises(HTTPException):
                security.decode_token(new_access)
    finally:
        app.dependency_overrides.pop(get_db, None)
