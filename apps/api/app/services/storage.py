from minio import Minio
from minio.error import S3Error
from app.core.config import settings
import io

_client: Minio | None = None


def get_minio() -> Minio:
    global _client
    if _client is None:
        _client = Minio(
            settings.MINIO_ENDPOINT,
            access_key=settings.MINIO_ACCESS_KEY,
            secret_key=settings.MINIO_SECRET_KEY,
            secure=settings.MINIO_SECURE,
        )
    return _client


def ensure_bucket(bucket: str = None):
    bucket = bucket or settings.MINIO_BUCKET
    client = get_minio()
    try:
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)
    except S3Error:
        pass


def upload_bytes(object_key: str, data: bytes, content_type: str, bucket: str = None) -> str:
    bucket = bucket or settings.MINIO_BUCKET
    ensure_bucket(bucket)
    client = get_minio()
    client.put_object(bucket, object_key, io.BytesIO(data), len(data), content_type=content_type)
    return f"http://{settings.MINIO_ENDPOINT}/{bucket}/{object_key}"


def get_presigned_url(object_key: str, bucket: str = None, expires_seconds: int = 3600) -> str:
    from datetime import timedelta
    bucket = bucket or settings.MINIO_BUCKET
    client = get_minio()
    return client.presigned_get_object(bucket, object_key, expires=timedelta(seconds=expires_seconds))


def delete_object(object_key: str, bucket: str = None):
    bucket = bucket or settings.MINIO_BUCKET
    client = get_minio()
    try:
        client.remove_object(bucket, object_key)
    except S3Error:
        pass
