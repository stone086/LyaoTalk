"""
Tests for the attachment upload endpoint.
Covers: auth requirement, MIME validation, size limit.
"""
import io
import time
import pytest
from starlette.requests import Request
from httpx import ASGITransport, AsyncClient
from unittest.mock import patch, MagicMock

from app.main import app
from app.core.database import get_db
from app.api.routers import auth as auth_router
from app.api.routers import attachments as attachments_router
from app.models import Account, Attachment, AttachmentGrant
from app.utils.security import create_access_token


@pytest.fixture(autouse=True)
def account_exists_for_upload():
    class _DB:
        async def scalar(self, _statement):
            return "test-account-id"

    async def _get_db():
        yield _DB()

    app.dependency_overrides[get_db] = _get_db
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_db, None)


def make_user_token(account_id: str = "test-account-id") -> str:
    return create_access_token("user@test.com", role="user", account_id=account_id)


def make_admin_token() -> str:
    return create_access_token("admin", role="admin")


def make_request(path: str, token: str = "") -> Request:
    return Request({
        "type": "http",
        "method": "GET",
        "path": path,
        "query_string": path.split("?", 1)[1].encode() if "?" in path else b"",
        "headers": [(b"authorization", f"Bearer {token}".encode())] if token else [],
    })


@pytest.mark.anyio
async def test_upload_requires_auth():
    """Upload without token → 401."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/attachments/upload",
            files={"file": ("test.txt", b"hello", "text/plain")},
        )
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_upload_rejects_admin_token():
    """Attachment upload requires user token, not admin token."""
    token = make_admin_token()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/attachments/upload",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": ("test.txt", b"hello", "text/plain")},
        )
    # 403: token valid but wrong role
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_upload_empty_file():
    """Empty file → 400."""
    token = make_user_token()
    transport = ASGITransport(app=app)
    with (
        patch("app.api.routers.attachments.magic") as mock_magic,
        patch("app.api.routers.attachments.minio_client") as mock_minio,
        patch("app.api.routers.attachments.ensure_bucket"),
    ):
        mock_magic.from_buffer.return_value = "text/plain"
        mock_minio.put_object = MagicMock()
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/attachments/upload",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("empty.txt", b"", "text/plain")},
            )
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_upload_rejects_disallowed_mime():
    """Executable file disguised as text → 415."""
    token = make_user_token()
    transport = ASGITransport(app=app)
    with (
        patch("app.api.routers.attachments.magic") as mock_magic,
        patch("app.api.routers.attachments.ensure_bucket"),
    ):
        mock_magic.from_buffer.return_value = "application/x-executable"
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/attachments/upload",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("virus.txt", b"\x7fELF", "text/plain")},
            )
    assert resp.status_code == 415


@pytest.mark.anyio
async def test_upload_size_limit():
    """File over 100 MB → 413."""
    token = make_user_token()
    big_file = b"x" * (101 * 1024 * 1024)
    transport = ASGITransport(app=app)
    with patch("app.api.routers.attachments.ensure_bucket"):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/attachments/upload",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("big.txt", big_file, "text/plain")},
            )
    assert resp.status_code == 413


@pytest.mark.anyio
async def test_download_streams_private_minio_object_with_header_token(monkeypatch):
    token = make_user_token()

    class _Result:
        def scalar_one_or_none(self):
            return None

    class _Db:
        async def execute(self, _stmt):
            return _Result()

    class _Object:
        def stream(self, _size):
            yield b"hello"

        def close(self):
            pass

        def release_conn(self):
            pass

    async def _allowed(_db, object_key, actor):
        return object_key == "uploads/a.txt" and actor["account_id"] == "test-account-id"

    monkeypatch.setattr(attachments_router, "_user_can_access_object", _allowed)
    monkeypatch.setattr(attachments_router.minio_client, "get_object", lambda *_args: _Object())

    response = await attachments_router.download_file(
        "uploads/a.txt",
        make_request("/attachments/download/uploads/a.txt", token),
        _Db(),
    )

    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.anyio
async def test_share_requires_owner_and_active_local_recipient():
    attachment = Attachment(id="file-id", owner_account_id="sender", download_url="https://files.test/files/uploads/a.png")
    recipient = Account(id="recipient", jid="friend@example.test", is_enabled=True)

    class _Db:
        def __init__(self):
            self.added = []

        async def scalar(self, statement):
            sql = str(statement)
            if "FROM attachments" in sql:
                return attachment
            if "FROM accounts" in sql:
                return recipient
            return None

        def add(self, value):
            self.added.append(value)

        async def commit(self):
            pass

    db = _Db()
    with pytest.raises(Exception) as forbidden:
        await attachments_router.share_attachment("file-id", attachments_router.ShareRequest(recipient_jid=recipient.jid), {"account_id": "intruder"}, db)
    assert forbidden.value.status_code == 404
    result = await attachments_router.share_attachment("file-id", attachments_router.ShareRequest(recipient_jid=recipient.jid), {"account_id": "sender"}, db)
    assert result["download_url"] == attachment.download_url
    assert len(db.added) == 1
    assert isinstance(db.added[0], AttachmentGrant)
    assert db.added[0].account_id == "recipient"


@pytest.mark.anyio
async def test_shared_attachment_access_is_account_scoped():
    class _Result:
        def __init__(self, value):
            self.value = value

        def one_or_none(self):
            return ("sender", None)

    class _Db:
        async def execute(self, _statement):
            return _Result(None)

        async def scalar(self, statement):
            return "grant-id" if "attachment_grants.account_id = :account_id_1" in str(statement) and "recipient" in statement.compile().params.values() else None

    db = _Db()
    assert await attachments_router._user_can_access_object(db, "uploads/a.png", {"role": "user", "account_id": "recipient"})
    assert not await attachments_router._user_can_access_object(db, "uploads/a.png", {"role": "user", "account_id": "intruder"})


@pytest.mark.anyio
async def test_encrypted_public_link_requires_owner_and_expires(monkeypatch):
    attachment = Attachment(
        id="encrypted-id", owner_account_id="sender", object_key="uploads/encrypted-id.bin",
        file_name="photo.png", mime_type="application/octet-stream", size_bytes=10,
    )

    class _Db:
        async def scalar(self, _statement):
            return attachment

    db = _Db()
    with pytest.raises(Exception) as forbidden:
        await attachments_router.publish_encrypted_attachment("encrypted-id", {"account_id": "other"}, db)
    assert forbidden.value.status_code == 404
    result = await attachments_router.publish_encrypted_attachment("encrypted-id", {"account_id": "sender"}, db)
    from urllib.parse import urlparse
    parsed = urlparse(result["url"])
    assert not parsed.query
    parts = parsed.path.split("/")
    assert parts[-4] == "encrypted-id"
    expires, signature = int(parts[-3]), parts[-2]
    assert attachments_router.ENCRYPTED_MEDIA_LIFETIME_SECONDS - 60 <= expires - int(time.time()) <= attachments_router.ENCRYPTED_MEDIA_LIFETIME_SECONDS

    class _Object:
        def stream(self, _size):
            yield b"ciphertext"
        def close(self):
            pass
        def release_conn(self):
            pass

    monkeypatch.setattr(attachments_router.minio_client, "get_object", lambda *_: _Object())
    response = await attachments_router.public_encrypted_attachment(
        "encrypted-id", "photo.png", expires, signature, db,
    )
    assert response.headers["access-control-allow-origin"] == "*"
    assert b"".join([chunk async for chunk in response.body_iterator]) == b"ciphertext"
    path_response = await attachments_router.public_encrypted_attachment_path(
        "encrypted-id", expires, signature, "photo.png", db,
    )
    assert b"".join([chunk async for chunk in path_response.body_iterator]) == b"ciphertext"
    monkeypatch.setattr(attachments_router.minio_client, "stat_object", lambda *_: object())
    transport = ASGITransport(app=app)
    previous_db_override = app.dependency_overrides[get_db]
    app.dependency_overrides[get_db] = lambda: db
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # nginx strips /api before forwarding to the FastAPI router.
            api_path = parsed.path.removeprefix("/api")
            head = await client.head(api_path)
            assert head.status_code == 200
            assert head.headers["content-length"] == "10"
            assert head.headers["content-type"] == "application/octet-stream"
            assert head.content == b""
            bad_signature = await client.head(api_path.replace(signature, "0" * 64))
            assert bad_signature.status_code == 404
    finally:
        app.dependency_overrides[get_db] = previous_db_override
    with pytest.raises(Exception) as expired:
        await attachments_router.public_encrypted_attachment(
            "encrypted-id", "photo.png", 1, signature, db,
        )
    assert expired.value.status_code == 404


@pytest.mark.anyio
async def test_remote_media_proxy_rejects_non_partner_hosts():
    with pytest.raises(Exception) as blocked:
        await attachments_router.remote_encrypted_media.__wrapped__(
            make_request("/attachments/remote-encrypted"),
            attachments_router.RemoteMediaRequest(url="https://127.0.0.1/private"),
            {"account_id": "sender"},
        )
    assert blocked.value.status_code == 400
