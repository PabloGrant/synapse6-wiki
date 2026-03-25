import os
import uuid
import mimetypes
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from minio import Minio
from minio.error import S3Error
from auth import require_role

router = APIRouter(prefix="/api/upload")

MINIO_ENDPOINT = os.environ.get("MINIO_ENDPOINT", "minio.workspace.pablogrant.com")
MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY", "")
MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY", "")
MINIO_BUCKET = os.environ.get("MINIO_BUCKET", "synapse6-wiki")
MINIO_PUBLIC_URL = os.environ.get("MINIO_PUBLIC_URL", f"https://minio.workspace.pablogrant.com/{MINIO_BUCKET}")

ALLOWED_TYPES = {
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
    "video/mp4", "video/webm", "video/quicktime",
    "application/pdf",
}

MAX_SIZE_MB = 100


def _client() -> Minio:
    return Minio(
        MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=True,
    )


@router.post("", dependencies=[Depends(require_role("editor"))])
async def upload_file(file: UploadFile = File(...)):
    content_type = file.content_type or mimetypes.guess_type(file.filename)[0] or ""
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"File type not allowed: {content_type}")

    data = await file.read()
    if len(data) > MAX_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"File too large (max {MAX_SIZE_MB}MB)")

    ext = os.path.splitext(file.filename)[1] if file.filename else ""
    object_name = f"uploads/{uuid.uuid4().hex}{ext}"

    client = _client()

    # Ensure bucket exists with public policy
    try:
        if not client.bucket_exists(MINIO_BUCKET):
            client.make_bucket(MINIO_BUCKET)
            _set_public_policy(client, MINIO_BUCKET)
    except S3Error as e:
        raise HTTPException(500, f"Storage error: {e}")

    import io
    client.put_object(
        MINIO_BUCKET,
        object_name,
        io.BytesIO(data),
        length=len(data),
        content_type=content_type,
    )

    public_url = f"{MINIO_PUBLIC_URL}/{object_name}"
    return {"ok": True, "url": public_url, "filename": file.filename}


def _set_public_policy(client: Minio, bucket: str):
    import json
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"AWS": ["*"]},
                "Action": ["s3:GetObject"],
                "Resource": [f"arn:aws:s3:::{bucket}/*"],
            }
        ],
    }
    client.set_bucket_policy(bucket, json.dumps(policy))
