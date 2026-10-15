"""Keep router unit tests independent of production PostgreSQL and Redis."""
import pytest
from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials

from app.main import app
from app.utils import security
from app.api.routers import auth as auth_router
from app.services import prosody_revision


class _TokenStore:
    def __init__(self):
        self.values = {}

    def exists(self, key):
        return key in self.values

    def get(self, key):
        return self.values.get(key)

    def setnx(self, key, value):
        if key in self.values:
            return False
        self.values[key] = value
        return True

    def set(self, key, value, ex=None):
        self.values[key] = value
        return True


@pytest.fixture(autouse=True)
def isolated_auth_backend(monkeypatch):
    store = _TokenStore()
    monkeypatch.setattr(security, "_get_redis", lambda: store)
    monkeypatch.setattr(auth_router, "get_credential_revision", lambda jid: "a" * 64)
    monkeypatch.setattr(prosody_revision, "get_credential_revision", lambda jid: "a" * 64)

    async def _test_user(
        credentials: HTTPAuthorizationCredentials = Security(security.bearer_scheme),
    ):
        if not credentials:
            raise HTTPException(status_code=401, detail="Not authenticated")
        payload = security.decode_token(credentials.credentials)
        if payload.get("role") != "user":
            raise HTTPException(status_code=403, detail="User token required")
        return {"sub": payload["sub"], "account_id": payload["account_id"]}

    app.dependency_overrides[security.get_current_user] = _test_user
    try:
        yield
    finally:
        app.dependency_overrides.pop(security.get_current_user, None)
