import asyncio

import pytest
from fastapi import HTTPException

from app.api.routers import auth as auth_router, devices
from app.core.config import settings
from app.utils.security import create_access_token, decode_token, set_device_active


def test_device_access_token_fails_after_revoke():
    set_device_active("account-1", "grant-1", True)
    token = create_access_token("alice@example.org", role="user", account_id="account-1", device_id="grant-1")
    assert decode_token(token)["device_id"] == "grant-1"
    set_device_active("account-1", "grant-1", False)
    with pytest.raises(HTTPException) as exc:
        decode_token(token)
    assert exc.value.status_code == 401


def test_device_issue_requires_valid_account_password(monkeypatch):
    monkeypatch.setattr(devices, "_verify_xmpp_sasl_plain", lambda *args: False)
    called = False

    async def prosody(*args):
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr(devices, "_prosody", prosody)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(devices.issue_device.__wrapped__(
            request=None,
            data=devices.DeviceCreate(name="Phone", password="wrong"),
            user={"sub": "alice@example.org", "account_id": "account-1"},
        ))
    assert exc.value.status_code == 401
    assert not called


def test_password_change_revokes_devices_before_rotation(monkeypatch):
    from types import SimpleNamespace

    calls = []
    monkeypatch.setattr(settings, "DEVICE_AUTH_SECRET", "x" * 40)
    monkeypatch.setattr(auth_router, "_verify_xmpp_sasl_plain", lambda *args: True)

    async def revoke_all(user):
        calls.append("revoke")
        return {"revoked": 1}

    def change(*args):
        calls.append("change")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(devices, "revoke_all_for_user", revoke_all)
    monkeypatch.setattr(auth_router, "_change_password_with_prosody", change)
    result = asyncio.run(auth_router.change_password.__wrapped__(
        request=None,
        data=auth_router.ChangePasswordRequest(old_password="old-secret", new_password="new-secret"),
        current_user={"sub": f"alice@{settings.XMPP_DOMAIN}", "account_id": "account-1"},
    ))
    assert result == {"ok": True}
    assert calls == ["revoke", "change"]
