import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.core.database import get_db
from app.utils.security import create_access_token
from app.api.routers import attachments as attachments_router


@pytest.fixture(autouse=True)
def account_exists_for_upload():
    class _DB:
        async def scalar(self, _statement):
            return "acc-1"

    async def _get_db():
        yield _DB()

    app.dependency_overrides[get_db] = _get_db
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.anyio
async def test_protected_router_requires_auth():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/accounts/")
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_health_routes_are_public():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r1 = await client.get("/health")
        r2 = await client.get("/api/health")
    assert r1.status_code == 200
    assert r2.status_code == 200


@pytest.mark.anyio
async def test_attachment_upload_requires_user_token():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/attachments/upload",
            files={"file": ("a.txt", b"hello", "text/plain")},
        )
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_attachment_upload_rejects_unsupported_mime(monkeypatch):
    class _Magic:
        @staticmethod
        def from_buffer(_content: bytes, mime: bool = True):
            return "application/x-msdownload" if mime else "application/x-msdownload"

    monkeypatch.setattr(attachments_router, "magic", _Magic())
    token = create_access_token("user@example.com", role="user", account_id="acc-1")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/attachments/upload",
            files={"file": ("bad.exe", b"MZ", "application/octet-stream")},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 415


@pytest.mark.anyio
async def test_attachment_upload_rejects_empty_file(monkeypatch):
    class _Magic:
        @staticmethod
        def from_buffer(_content: bytes, mime: bool = True):
            return "text/plain" if mime else "text/plain"

    monkeypatch.setattr(attachments_router, "magic", _Magic())
    token = create_access_token("user@example.com", role="user", account_id="acc-1")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/attachments/upload",
            files={"file": ("empty.txt", b"", "text/plain")},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_attachment_upload_rejects_too_large(monkeypatch):
    class _Magic:
        @staticmethod
        def from_buffer(_content: bytes, mime: bool = True):
            return "text/plain" if mime else "text/plain"

    monkeypatch.setattr(attachments_router, "magic", _Magic())
    monkeypatch.setattr(attachments_router, "MAX_UPLOAD_SIZE_BYTES", 5)
    token = create_access_token("user@example.com", role="user", account_id="acc-1")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/attachments/upload",
            files={"file": ("big.txt", b"123456", "text/plain")},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 413


@pytest.mark.anyio
async def test_attachment_upload_fails_when_magic_unavailable(monkeypatch):
    monkeypatch.setattr(attachments_router, "magic", None)
    token = create_access_token("user@example.com", role="user", account_id="acc-1")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/attachments/upload",
            files={"file": ("a.txt", b"hello", "text/plain")},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 500


@pytest.mark.anyio
async def test_message_search_requires_account_id_with_admin_token():
    token = create_access_token("admin")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(
            "/messages/search",
            params={"q": "hello"},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 400
