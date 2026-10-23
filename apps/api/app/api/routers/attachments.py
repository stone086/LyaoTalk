from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
import logging
from app.core.database import get_db
from app.core.config import settings
from app.models import Account, Attachment, AttachmentGrant, Conversation, Message
from app.utils.security import get_current_user, decode_token
from minio import Minio
from minio.error import S3Error
from urllib.parse import quote
import uuid
import hashlib
import hmac
import time
from urllib.parse import urlparse
import httpx
from app.core.rate_limit import limiter
from app.api.routers.preview import PublicIPTransport
try:
    import magic
except Exception:  # pragma: no cover
    magic = None

router = APIRouter()
logger = logging.getLogger("lyaotalk.attachments")

minio_client = Minio(
    settings.MINIO_ENDPOINT,
    access_key=settings.MINIO_ACCESS_KEY,
    secret_key=settings.MINIO_SECRET_KEY,
    secure=settings.MINIO_SECURE,
)

# Allowed MIME types for upload. application/octet-stream is included so that
# OMEMO Media Sharing (XEP-0454) clients can upload AES-GCM-encrypted blobs;
# the decrypted content type is enforced client-side via the URL fragment.
ALLOWED_MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heif",
    "audio/webm",
    "video/webm",
    "video/mp4",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-matroska",
    "video/mpeg",
    "video/3gpp",
    "video/3gpp2",
    "video/x-ms-wmv",
    "audio/ogg",
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/x-m4a",
    "audio/aac",
    "audio/flac",
    "audio/x-flac",
    "audio/x-wav",
    "audio/3gpp",
    "audio/3gpp2",
    "audio/x-ms-wma",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "text/csv",
    "text/markdown",
    "application/json",
    "application/rtf",
    "text/rtf",
    "application/zip",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "application/x-rar-compressed",
    "application/gzip",
    "application/x-gzip",
    "application/x-tar",
    "application/octet-stream",  # encrypted (aesgcm://) blobs
    "text/plain",
}


def base_media_type(value: str | None) -> str:
    """MIME parameters such as ``codecs=opus`` do not change the media type."""
    return (value or "application/octet-stream").split(";", 1)[0].strip().lower()


MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024


def ensure_bucket():
    try:
        if not minio_client.bucket_exists(settings.MINIO_BUCKET):
            minio_client.make_bucket(settings.MINIO_BUCKET)
    except Exception as e:
        logger.warning(f"ensure_bucket_failed: {type(e).__name__}: {e}")


class UploadResponse(BaseModel):
    id: str
    object_key: str
    download_url: str
    file_name: str
    mime_type: str
    size_bytes: int


class ShareRequest(BaseModel):
    recipient_jid: str


class RemoteMediaRequest(BaseModel):
    url: str


def _public_media_signature(attachment_id: str, expires: int) -> str:
    message = f"media:{attachment_id}:{expires}".encode()
    return hmac.new(settings.SECRET_KEY.encode(), message, hashlib.sha256).hexdigest()


ENCRYPTED_MEDIA_LIFETIME_SECONDS = 3 * 24 * 3600


@router.post("/{attachment_id}/publish-encrypted", summary="Publish a temporary encrypted media link")
async def publish_encrypted_attachment(
    attachment_id: str,
    actor: dict[str, str] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attachment = await db.scalar(select(Attachment).where(Attachment.id == attachment_id))
    if not attachment or attachment.owner_account_id != actor["account_id"]:
        raise HTTPException(status_code=404, detail="Attachment not found")
    if attachment.mime_type != "application/octet-stream":
        raise HTTPException(status_code=415, detail="Only encrypted media may be published")
    expires = int(time.time()) + ENCRYPTED_MEDIA_LIFETIME_SECONDS
    signature = _public_media_signature(attachment_id, expires)
    name = quote(attachment.file_name, safe="")
    # Keep the signed capability in path segments. Some XEP-0454 clients
    # misidentify a media URL when a query string precedes the #IV+key.
    return {"url": f"https://{settings.PUBLIC_DOMAIN}/api/attachments/public-encrypted/{attachment_id}/{expires}/{signature}/{name}"}


@router.get("/public-encrypted/{attachment_id}/{expires}/{sig}/{file_name}", summary="Download temporary encrypted media")
async def public_encrypted_attachment_path(
    attachment_id: str,
    expires: int,
    sig: str,
    file_name: str,
    db: AsyncSession = Depends(get_db),
):
    return await public_encrypted_attachment(attachment_id, file_name, expires, sig, db)


@router.head("/public-encrypted/{attachment_id}/{expires}/{sig}/{file_name}", summary="Inspect temporary encrypted media")
async def head_public_encrypted_attachment_path(
    attachment_id: str,
    expires: int,
    sig: str,
    file_name: str,
    db: AsyncSession = Depends(get_db),
):
    attachment = await _validate_public_encrypted_attachment(attachment_id, file_name, expires, sig, db)
    try:
        minio_client.stat_object(settings.MINIO_BUCKET, attachment.object_key)
    except S3Error:
        raise HTTPException(status_code=404, detail="Not found")
    return Response(status_code=200, media_type="application/octet-stream", headers={
        "Content-Length": str(attachment.size_bytes),
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
    })


@router.get("/public-encrypted/{attachment_id}/{file_name}", summary="Download temporary encrypted media")
async def public_encrypted_attachment(
    attachment_id: str,
    file_name: str,
    expires: int,
    sig: str,
    db: AsyncSession = Depends(get_db),
):
    attachment = await _validate_public_encrypted_attachment(attachment_id, file_name, expires, sig, db)
    try:
        obj = minio_client.get_object(settings.MINIO_BUCKET, attachment.object_key)
    except S3Error:
        raise HTTPException(status_code=404, detail="Not found")

    def stream_object():
        try:
            yield from obj.stream(32 * 1024)
        finally:
            obj.close()
            obj.release_conn()

    return StreamingResponse(stream_object(), media_type="application/octet-stream", headers={
        "Content-Length": str(attachment.size_bytes),
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
    })


async def _validate_public_encrypted_attachment(
    attachment_id: str,
    file_name: str,
    expires: int,
    sig: str,
    db: AsyncSession,
) -> Attachment:
    if expires < time.time() or expires > time.time() + ENCRYPTED_MEDIA_LIFETIME_SECONDS + 60:
        raise HTTPException(status_code=404, detail="Not found")
    expected = _public_media_signature(attachment_id, expires)
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=404, detail="Not found")
    attachment = await db.scalar(select(Attachment).where(Attachment.id == attachment_id))
    if not attachment or attachment.mime_type != "application/octet-stream" or attachment.file_name != file_name:
        raise HTTPException(status_code=404, detail="Not found")
    return attachment


@router.post("/remote-encrypted", summary="Fetch external encrypted media without sharing a bearer token")
@limiter.limit("30/minute")
async def remote_encrypted_media(
    request: Request,
    payload: RemoteMediaRequest,
    actor: dict[str, str] = Depends(get_current_user),
):
    # Limit proxying to the known federation partner. PublicIPTransport also
    # pins DNS to a public IP, and redirects are disabled to prevent SSRF.
    parsed = urlparse(payload.url)
    if parsed.scheme != "https" or parsed.hostname != "upload.chat.52nbc.com" or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.fragment:
        raise HTTPException(status_code=400, detail="Remote media host not allowed")
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=False, trust_env=False,
                                     transport=PublicIPTransport()) as client:
            async with client.stream("GET", payload.url) as response:
                if response.status_code != 200:
                    raise HTTPException(status_code=502, detail="Remote media unavailable")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_UPLOAD_SIZE_BYTES:
                        raise HTTPException(status_code=413, detail="Remote media too large")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Remote media unavailable")
    return Response(content=bytes(data), media_type="application/octet-stream", headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/{attachment_id}/share", summary="Share an attachment with a local account")
async def share_attachment(
    attachment_id: str,
    payload: ShareRequest,
    actor: dict[str, str] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attachment = await db.scalar(select(Attachment).where(Attachment.id == attachment_id))
    if attachment is None or attachment.owner_account_id != actor["account_id"]:
        raise HTTPException(status_code=404, detail="Attachment not found")
    recipient_jid = payload.recipient_jid.split("/", 1)[0].lower()
    recipient = await db.scalar(select(Account).where(Account.jid == recipient_jid, Account.is_enabled.is_(True)))
    if recipient is None:
        raise HTTPException(status_code=422, detail="Recipient must have an active Lyao Talk account")
    existing = await db.scalar(select(AttachmentGrant.id).where(
        AttachmentGrant.attachment_id == attachment_id,
        AttachmentGrant.account_id == recipient.id,
    ))
    if not existing:
        db.add(AttachmentGrant(attachment_id=attachment_id, account_id=recipient.id))
        await db.commit()
    return {"download_url": attachment.download_url}


@router.post(
    "/upload",
    response_model=UploadResponse,
    summary="Upload attachment",
    description="Validate MIME and size, store file in MinIO, and persist metadata.",
)
# 100 MB per request with no ceiling means one IP can fill the bucket; nginx
# only caps request rate at 300 r/m across all of /api/. Throttle uploads
# specifically, per client IP, at a rate a real user never hits.
@limiter.limit("120/hour")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    # message_id MUST use Form() so FastAPI parses it from the multipart body.
    # Without Form(), FastAPI treats it as a query parameter, which mismatches
    # how the frontend sends it (inside FormData) and produces obscure 422s.
    message_id: Optional[str] = Form(None),
    current_user: dict[str, str] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ensure_bucket()
    account_exists = await db.scalar(
        select(Account.id).where(Account.id == current_user["account_id"])
    )
    if not account_exists:
        raise HTTPException(status_code=403, detail="Account access denied")

    file_id = str(uuid.uuid4())
    # Sanitize filename: strip path components, limit characters
    raw_name = file.filename or "unnamed"
    safe_name = raw_name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]  # strip path
    safe_name = "".join(c for c in safe_name if c.isalnum() or c in "._- ").strip()
    safe_name = safe_name[:200] or "file"
    ext = safe_name.rsplit(".", 1)[-1] if "." in safe_name else "bin"
    object_key = f"uploads/{file_id}.{ext}"

    # UploadFile is spooled to disk by Starlette for large bodies. Inspect its
    # size and a small header without copying the entire upload into RAM.
    await file.seek(0)
    file.file.seek(0, 2)
    size = file.file.tell()
    await file.seek(0)
    if size == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    if size > MAX_UPLOAD_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 100MB)")
    if magic is None:
        # libmagic not installed — fall back to client-declared content_type.
        # Less safe but better than silent 500 in environments without libmagic1.
        detected_mime = base_media_type(file.content_type)
        logger.warning("libmagic_unavailable_using_client_content_type")
    else:
        detected_mime = base_media_type(magic.from_buffer(await file.read(8192), mime=True))
        await file.seek(0)

    if detected_mime not in ALLOWED_MIME_TYPES:
        logger.info(f"upload_rejected_mime detected={detected_mime} name={safe_name}")
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {detected_mime}")

    try:
        minio_client.put_object(
            settings.MINIO_BUCKET,
            object_key,
            file.file,
            length=size,
            content_type=detected_mime,
        )
    except S3Error as e:
        logger.error(f"minio_put_failed key={object_key} error={e}")
        raise HTTPException(status_code=500, detail=f"Storage error: {e}")

    download_host = settings.FILES_PUBLIC_DOMAIN or settings.PUBLIC_DOMAIN
    download_url = f"https://{download_host}/files/{object_key}"

    attachment = Attachment(
        id=file_id,
        message_id=message_id,
        owner_account_id=current_user.get("account_id"),
        object_key=object_key,
        file_name=safe_name,
        mime_type=detected_mime,
        size_bytes=size,
        download_url=download_url,
    )
    db.add(attachment)
    await db.commit()

    logger.info(f"upload_ok id={file_id} mime={detected_mime} size={size} name={safe_name}")
    return UploadResponse(
        id=file_id,
        object_key=object_key,
        download_url=download_url,
        file_name=safe_name,
        mime_type=detected_mime,
        size_bytes=size,
    )


async def _user_can_access_object(
    db: AsyncSession,
    object_key: str,
    actor: dict[str, str],
) -> bool:
    """Check if the given user has the right to read this MinIO object.

    Admins, owners, conversation owners, and explicitly granted local
    recipient accounts may access an object.
    """
    if actor.get("role") == "admin":
        return True
    user_account_id = actor.get("account_id")
    if not user_account_id:
        return False

    # Find the attachment by object_key
    stmt = (
        select(Attachment.owner_account_id, Conversation.account_id)
        .select_from(Attachment)
        .outerjoin(Message, Message.id == Attachment.message_id)
        .outerjoin(Conversation, Conversation.id == Message.conversation_id)
        .where(Attachment.object_key == object_key)
    )
    result = await db.execute(stmt)
    row = result.one_or_none()
    if row is None:
        return False

    owner_account_id, conversation_account_id = row
    if owner_account_id == user_account_id or conversation_account_id == user_account_id:
        return True

    grant = await db.scalar(select(AttachmentGrant.id).join(
        Attachment, Attachment.id == AttachmentGrant.attachment_id
    ).where(Attachment.object_key == object_key, AttachmentGrant.account_id == user_account_id))
    if grant:
        return True

    return False


@router.get(
    "/presign/{object_key:path}",
    summary="Get presigned URL",
    description="Return temporary signed download URL for one object key. "
                "Caller must own the conversation containing this attachment.",
)
async def get_presigned_url(
    object_key: str,
    actor: dict[str, str] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not await _user_can_access_object(db, object_key, actor):
        # Use 404 not 403 so we don't leak whether the object exists
        raise HTTPException(status_code=404, detail="Not found")
    try:
        url = minio_client.presigned_get_object(settings.MINIO_BUCKET, object_key)
        return {"url": url}
    except S3Error as e:
        raise HTTPException(status_code=404, detail=str(e))


def _actor_from_download_request(request: Request) -> dict[str, str]:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = auth_header[len("Bearer "):]

    payload = decode_token(token)
    role = payload.get("role")
    account_id = payload.get("account_id")
    if role not in ("admin", "user"):
        raise HTTPException(status_code=403, detail="Invalid token role")
    if role == "user" and not account_id:
        raise HTTPException(status_code=403, detail="Invalid user token payload")
    return {"role": role, "account_id": account_id, "sub": payload.get("sub", "")}


def _content_disposition_attachment(file_name: str) -> str:
    safe_name = (
        file_name
        .replace("\\", "_")
        .replace("/", "_")
        .replace('"', "")
        .replace("\r", "")
        .replace("\n", "")
    ).strip() or "download"
    fallback_name = safe_name.encode("ascii", "ignore").decode("ascii").strip() or "download"
    encoded_name = quote(safe_name, safe="")
    return f'attachment; filename="{fallback_name}"; filename*=UTF-8\'\'{encoded_name}'


@router.get(
    "/download/{object_key:path}",
    summary="Download attachment",
    description="Stream a private MinIO object after token-based ownership checks.",
)
async def download_file(
    object_key: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    actor = _actor_from_download_request(request)
    if not await _user_can_access_object(db, object_key, actor):
        raise HTTPException(status_code=404, detail="Not found")

    stmt = select(Attachment).where(Attachment.object_key == object_key)
    result = await db.execute(stmt)
    attachment = result.scalar_one_or_none()
    media_type = attachment.mime_type if attachment else "application/octet-stream"
    file_name = attachment.file_name if attachment else object_key.rsplit("/", 1)[-1]

    try:
        obj = minio_client.get_object(settings.MINIO_BUCKET, object_key)
    except S3Error as e:
        raise HTTPException(status_code=404, detail=str(e))

    def stream_object():
        try:
            yield from obj.stream(32 * 1024)
        finally:
            obj.close()
            obj.release_conn()

    return StreamingResponse(
        stream_object(),
        media_type=media_type,
        headers={
            "Content-Disposition": _content_disposition_attachment(file_name),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )


@router.get(
    "/auth-check",
    summary="nginx auth_request endpoint for /files/* downloads",
    description="Returns 200 if the bearer token in the Authorization header "
                "is allowed to read X-Original-URI's object_key. "
                "Used by nginx auth_request to gate MinIO proxy access. "
                "Returns 401/403/404 to deny.",
    include_in_schema=False,
)
async def auth_check(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    # nginx passes the original URI (e.g. "/files/uploads/abc123.jpg") via header
    original_uri = request.headers.get("X-Original-URI", "")
    # Strip the "/files/" prefix to match how object_key is stored in DB
    if not original_uri.startswith("/files/"):
        return Response(status_code=404)
    object_key = original_uri[len("/files/"):].split("?", 1)[0]
    if not object_key:
        return Response(status_code=404)

    # Media is fetched through the authenticated API and converted to a local
    # blob URL by the frontend. Never accept reusable JWTs in query strings.
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return Response(status_code=401)
    token = auth_header[len("Bearer "):]

    try:
        payload = decode_token(token)
    except HTTPException:
        return Response(status_code=401)

    role = payload.get("role")
    account_id = payload.get("account_id")
    if role not in ("admin", "user"):
        return Response(status_code=403)
    if role == "user" and not account_id:
        return Response(status_code=403)

    actor = {"role": role, "account_id": account_id, "sub": payload.get("sub", "")}
    allowed = await _user_can_access_object(db, object_key, actor)
    return Response(status_code=200 if allowed else 404)
