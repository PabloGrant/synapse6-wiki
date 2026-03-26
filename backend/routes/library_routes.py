"""
Library File Catalog — backend routes.

Upload pipeline (async, background):
  1. Save original to MinIO (NAS)
  2. Convert to Markdown, save to /data/library/files/{id}.md
  3. Parse into page chunks, batch-embed, upsert to Qdrant
  4. LLM summarize → key points + claims
  5. Save metadata JSON to /data/library/files/{id}.json

Endpoints:
  POST   /api/library/upload          Upload file, returns {job_id, file_id}
  GET    /api/library/jobs/{job_id}   Poll job status
  GET    /api/library/files           List all files (metadata)
  GET    /api/library/files/{id}      Single file detail
  DELETE /api/library/files/{id}      Delete file everywhere
  POST   /api/library/search          Semantic search
"""

import asyncio
import io
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from minio import Minio
from minio.error import S3Error
from pydantic import BaseModel

from auth import get_current_user, require_role

router = APIRouter(prefix="/api/library")

# ── Config ────────────────────────────────────────────────────────────────

DATA_DIR       = os.environ.get("DATA_DIR", "/data")
SETTINGS_FILE  = os.path.join(DATA_DIR, "settings.json")
LIBRARY_DIR    = os.path.join(DATA_DIR, "library", "files")
JOBS_DIR       = os.path.join(DATA_DIR, "library", "jobs")

QDRANT_URL     = os.environ.get("QDRANT_URL", "http://100.66.18.38:6333")
QDRANT_COL     = "synapse6_library"

NAS_MINIO_ENDPOINT   = os.environ.get("NAS_MINIO_ENDPOINT",   "100.111.59.128:9000")
NAS_MINIO_ACCESS_KEY = os.environ.get("NAS_MINIO_ACCESS_KEY", "huxmo")
NAS_MINIO_SECRET_KEY = os.environ.get("NAS_MINIO_SECRET_KEY", "a8427373A*")
NAS_MINIO_BUCKET     = os.environ.get("NAS_MINIO_BUCKET",     "synapse6-library-originals")

SUPPORTED_EXTENSIONS = {
    "pdf", "docx", "doc", "pptx", "xlsx", "xls", "csv", "odt", "txt", "md"
}

MAX_SIZE_MB = 200

# ── Helpers ───────────────────────────────────────────────────────────────

def _ensure_dirs():
    os.makedirs(LIBRARY_DIR, exist_ok=True)
    os.makedirs(JOBS_DIR, exist_ok=True)


def _load_settings() -> dict:
    if not os.path.exists(SETTINGS_FILE):
        return {}
    with open(SETTINGS_FILE) as f:
        return json.load(f)


def _meta_path(file_id: str) -> str:
    return os.path.join(LIBRARY_DIR, f"{file_id}.json")


def _md_path(file_id: str) -> str:
    return os.path.join(LIBRARY_DIR, f"{file_id}.md")


def _job_path(job_id: str) -> str:
    return os.path.join(JOBS_DIR, f"{job_id}.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_job(job_id: str, data: dict):
    data["updated_at"] = _now()
    with open(_job_path(job_id), "w") as f:
        json.dump(data, f, indent=2)


def _read_job(job_id: str) -> dict | None:
    p = _job_path(job_id)
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def _nas_client() -> Minio:
    return Minio(
        NAS_MINIO_ENDPOINT,
        access_key=NAS_MINIO_ACCESS_KEY,
        secret_key=NAS_MINIO_SECRET_KEY,
        secure=False,
    )


# ── Embedding + LLM helpers ───────────────────────────────────────────────

async def _embed(texts: list[str], settings: dict) -> list[list[float]]:
    """Batch-embed texts using the configured embedding model hierarchy."""
    models = sorted(
        [m for m in settings.get("llm_models", [])
         if m.get("enabled") and m.get("type") == "embedding"],
        key=lambda m: m.get("order", 0),
    )
    if not models:
        raise RuntimeError("No embedding model configured in wiki settings.")

    last_err = None
    async with httpx.AsyncClient(timeout=180) as client:
        for model in models:
            base = model["api_endpoint"].rstrip("/")
            headers = {}
            if model.get("api_token"):
                headers["Authorization"] = f"Bearer {model['api_token']}"
            try:
                resp = await client.post(
                    f"{base}/v1/embeddings",
                    headers=headers,
                    json={"model": model["model_name"], "input": texts},
                )
                resp.raise_for_status()
                data = resp.json()
                items = sorted(data["data"], key=lambda x: x["index"])
                return [item["embedding"] for item in items]
            except Exception as e:
                last_err = str(e)
    raise RuntimeError(f"All embedding models failed. Last: {last_err}")


async def _summarize(markdown: str, filename: str, settings: dict) -> dict:
    """Ask the LLM to produce a structured summary of the document."""
    truncated = markdown[:60_000]  # ~15k tokens, enough for summary
    system = (
        "You are a document analyst. Read the document and return ONLY valid JSON "
        "in this exact structure:\n"
        '{"summary":"...","key_points":["..."],"claims":["..."]}\n'
        "summary: 3-5 sentence overview. "
        "key_points: up to 8 important facts or findings. "
        "claims: specific assertions or conclusions the document makes."
    )
    user_msg = f"Document filename: {filename}\n\n{truncated}"

    llm_models = sorted(
        [m for m in settings.get("llm_models", [])
         if m.get("enabled") and m.get("type", "llm") == "llm"],
        key=lambda m: m.get("order", 0),
    )
    if not llm_models:
        return {"summary": "", "key_points": [], "claims": []}

    last_err = None
    async with httpx.AsyncClient(timeout=300) as client:
        for model in llm_models:
            base = model["api_endpoint"].rstrip("/")
            headers = {}
            if model.get("api_token"):
                headers["Authorization"] = f"Bearer {model['api_token']}"
            try:
                resp = await client.post(
                    f"{base}/v1/chat/completions",
                    headers=headers,
                    json={
                        "model": model["model_name"],
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": user_msg},
                        ],
                        "max_tokens": 1024,
                        "temperature": 0.1,
                        "stream": False,
                    },
                )
                resp.raise_for_status()
                content = resp.json()["choices"][0]["message"]["content"].strip()
                m = re.search(r"\{.*\}", content, re.DOTALL)
                if m:
                    return json.loads(m.group())
                return {"summary": content, "key_points": [], "claims": []}
            except Exception as e:
                last_err = str(e)
    return {"summary": f"Summary unavailable: {last_err}", "key_points": [], "claims": []}


# ── Qdrant helpers ────────────────────────────────────────────────────────

async def _qdrant_upsert(points: list[dict]):
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.put(
            f"{QDRANT_URL}/collections/{QDRANT_COL}/points",
            json={"points": points},
        )
        resp.raise_for_status()


async def _qdrant_delete_by_file(file_id: str):
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{QDRANT_URL}/collections/{QDRANT_COL}/points/delete",
            json={"filter": {"must": [{"key": "file_id", "match": {"value": file_id}}]}},
        )
        resp.raise_for_status()


async def _qdrant_search(vector: list[float], limit: int = 20,
                         file_id: str = None) -> list[dict]:
    payload: dict = {
        "vector": vector,
        "limit": limit,
        "with_payload": True,
        "score_threshold": 0.25,
    }
    if file_id:
        payload["filter"] = {
            "must": [{"key": "file_id", "match": {"value": file_id}}]
        }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{QDRANT_URL}/collections/{QDRANT_COL}/points/search",
            json=payload,
        )
        resp.raise_for_status()
        return resp.json().get("result", [])


async def _qdrant_search_exclude_file(vector: list[float], exclude_file_id: str,
                                      limit: int = 30) -> list[dict]:
    """Search Qdrant excluding all chunks from a specific file."""
    payload: dict = {
        "vector": vector,
        "limit": limit,
        "with_payload": True,
        "score_threshold": 0.40,
        "filter": {
            "must_not": [{"key": "file_id", "match": {"value": exclude_file_id}}]
        },
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{QDRANT_URL}/collections/{QDRANT_COL}/points/search",
            json=payload,
        )
        resp.raise_for_status()
        return resp.json().get("result", [])


# ── Background pipeline ───────────────────────────────────────────────────

async def _run_pipeline(
    job_id: str,
    file_id: str,
    data: bytes,
    original_filename: str,
    extension: str,
    mime_type: str,
    uploaded_by: str,
):
    from lib.document_converter import (
        SUPPORTED_EXTENSIONS, convert, extract_file_date, parse_chunks
    )

    _ensure_dirs()
    job = _read_job(job_id)

    def _stage(status: str, stage: str):
        job.update({"status": status, "stage": stage})
        _write_job(job_id, job)

    try:
        settings = _load_settings()

        # ── 1. Upload original to MinIO (NAS) ─────────────────────────────
        _stage("running", "Uploading original to storage…")
        minio_path = f"{uploaded_by}/{datetime.now().strftime('%Y-%m')}/{file_id}/{original_filename}"

        def _do_minio_upload():
            client = _nas_client()
            if not client.bucket_exists(NAS_MINIO_BUCKET):
                client.make_bucket(NAS_MINIO_BUCKET)
            client.put_object(
                NAS_MINIO_BUCKET,
                minio_path,
                io.BytesIO(data),
                length=len(data),
                content_type=mime_type,
            )

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_minio_upload)

        # ── 2. Convert to Markdown ─────────────────────────────────────────
        convertible = extension.lower().lstrip(".") in SUPPORTED_EXTENSIONS
        markdown = ""
        file_date = None
        page_count = 0

        if convertible:
            _stage("running", "Converting document to Markdown…")

            def _do_convert():
                with tempfile.NamedTemporaryFile(
                    suffix=f".{extension}", delete=False
                ) as tmp:
                    tmp.write(data)
                    tmp_path = tmp.name
                try:
                    md = convert(tmp_path, extension)
                    fd = extract_file_date(tmp_path, extension)
                    return md, fd
                finally:
                    os.unlink(tmp_path)

            markdown, file_date = await loop.run_in_executor(None, _do_convert)

            # Save markdown to volume
            with open(_md_path(file_id), "w") as f:
                f.write(markdown)

            page_count = len(parse_chunks(markdown))

        # ── 3. Index in Qdrant ─────────────────────────────────────────────
        vectors_count = 0
        if markdown:
            _stage("running", "Generating embeddings and indexing…")
            chunks = parse_chunks(markdown)

            if chunks:
                texts = [c["content"] for c in chunks]
                vectors = await _embed(texts, settings)

                points = []
                for chunk, vector in zip(chunks, vectors):
                    points.append({
                        "id": str(uuid.uuid4()),
                        "vector": vector,
                        "payload": {
                            "type": "library_page",
                            "file_id": file_id,
                            "original_filename": original_filename,
                            "uploaded_by": uploaded_by,
                            "page_number": chunk["page_number"],
                            "page_type": chunk["page_type"],
                            "page_title": chunk["page_title"],
                            "content": chunk["content"],
                            "content_length": len(chunk["content"]),
                            "indexed_at": _now(),
                        },
                    })

                await _qdrant_upsert(points)
                vectors_count = len(points)

        # ── 4. Summarize ───────────────────────────────────────────────────
        summary_data = {"summary": "", "key_points": [], "claims": []}
        if markdown:
            _stage("running", "Generating summary…")
            summary_data = await _summarize(markdown, original_filename, settings)

        # ── 5. Save metadata ───────────────────────────────────────────────
        meta = {
            "id": file_id,
            "original_filename": original_filename,
            "extension": extension.lower().lstrip("."),
            "mime_type": mime_type,
            "file_size_bytes": len(data),
            "file_date": file_date,
            "upload_date": job["created_at"],
            "uploaded_by": uploaded_by,
            "version": 1,
            "minio_path": minio_path,
            "page_count": page_count,
            "qdrant_indexed": vectors_count > 0,
            "vectors_count": vectors_count,
            **summary_data,
        }
        with open(_meta_path(file_id), "w") as f:
            json.dump(meta, f, indent=2)

        job.update({"status": "done", "stage": "Complete"})
        _write_job(job_id, job)

    except Exception as e:
        job.update({"status": "failed", "stage": "Failed", "error": str(e)})
        _write_job(job_id, job)
        raise


# ── Routes ────────────────────────────────────────────────────────────────

@router.post("/upload", dependencies=[Depends(require_role("editor"))])
async def upload_file(
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    _ensure_dirs()

    # Validate extension
    filename = file.filename or "upload"
    ext = os.path.splitext(filename)[1].lstrip(".").lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type: .{ext}")

    data = await file.read()
    if len(data) > MAX_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"File too large (max {MAX_SIZE_MB}MB)")

    mime_type = file.content_type or "application/octet-stream"
    file_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())

    # Create job record
    job = {
        "job_id": job_id,
        "file_id": file_id,
        "status": "pending",
        "stage": "Queued",
        "error": None,
        "original_filename": filename,
        "created_at": _now(),
        "updated_at": _now(),
    }
    _write_job(job_id, job)

    # Launch pipeline in background
    asyncio.create_task(_run_pipeline(
        job_id=job_id,
        file_id=file_id,
        data=data,
        original_filename=filename,
        extension=ext,
        mime_type=mime_type,
        uploaded_by=user["sub"],
    ))

    return {"job_id": job_id, "file_id": file_id}


@router.get("/jobs/{job_id}", dependencies=[Depends(get_current_user)])
def get_job(job_id: str):
    job = _read_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@router.get("/files", dependencies=[Depends(get_current_user)])
def list_files():
    _ensure_dirs()
    files = []
    for fname in os.listdir(LIBRARY_DIR):
        if not fname.endswith(".json"):
            continue
        with open(os.path.join(LIBRARY_DIR, fname)) as f:
            try:
                files.append(json.load(f))
            except Exception:
                continue
    files.sort(key=lambda x: x.get("upload_date", ""), reverse=True)
    # Return lightweight list (no summary body)
    return {"files": [
        {k: v for k, v in f.items()
         if k not in ("summary", "key_points", "claims")}
        for f in files
    ]}


@router.get("/files/{file_id}", dependencies=[Depends(get_current_user)])
def get_file(file_id: str):
    p = _meta_path(file_id)
    if not os.path.exists(p):
        raise HTTPException(404, "File not found")
    with open(p) as f:
        return json.load(f)


@router.get("/files/{file_id}/markdown", dependencies=[Depends(get_current_user)])
def get_file_markdown(file_id: str):
    p = _md_path(file_id)
    if not os.path.exists(p):
        raise HTTPException(404, "Markdown not available for this file")
    with open(p) as f:
        return {"markdown": f.read()}


@router.get("/files/{file_id}/overlaps", dependencies=[Depends(get_current_user)])
async def get_overlaps(file_id: str):
    """Find library files with overlapping content via Qdrant similarity."""
    p = _meta_path(file_id)
    if not os.path.exists(p):
        raise HTTPException(404, "File not found")
    with open(p) as f:
        meta = json.load(f)

    # Build a query from the summary + key points for broader overlap coverage
    summary = meta.get("summary", "")
    key_points = " ".join(meta.get("key_points", []))
    query_text = f"{summary} {key_points}".strip()

    if not query_text:
        return {"library": []}

    settings = _load_settings()
    try:
        vectors = await _embed([query_text], settings)
    except RuntimeError:
        return {"library": []}

    results = await _qdrant_search_exclude_file(vectors[0], exclude_file_id=file_id)

    # Deduplicate — keep best-scoring chunk per unique file
    seen: dict[str, dict] = {}
    for r in results:
        fid = r["payload"].get("file_id")
        if not fid or fid in seen:
            continue
        seen[fid] = {
            "file_id": fid,
            "original_filename": r["payload"].get("original_filename", ""),
            "score": round(r["score"], 3),
            "page_number": r["payload"].get("page_number"),
            "page_title": r["payload"].get("page_title"),
            "snippet": r["payload"].get("content", "")[:300],
        }

    return {"library": list(seen.values())[:6]}


@router.delete("/files/{file_id}", dependencies=[Depends(require_role("editor"))])
async def delete_file(file_id: str):
    p = _meta_path(file_id)
    if not os.path.exists(p):
        raise HTTPException(404, "File not found")

    with open(p) as f:
        meta = json.load(f)

    # Remove from Qdrant
    try:
        await _qdrant_delete_by_file(file_id)
    except Exception:
        pass

    # Remove from MinIO (NAS) — best effort
    try:
        def _do_delete():
            client = _nas_client()
            client.remove_object(NAS_MINIO_BUCKET, meta.get("minio_path", ""))
        await asyncio.get_event_loop().run_in_executor(None, _do_delete)
    except Exception:
        pass

    # Remove local files
    for path in (_meta_path(file_id), _md_path(file_id)):
        if os.path.exists(path):
            os.unlink(path)

    return {"ok": True}


class SearchBody(BaseModel):
    query: str
    limit: int = 20
    file_id: Optional[str] = None


@router.post("/search", dependencies=[Depends(get_current_user)])
async def search(body: SearchBody):
    if not body.query.strip():
        raise HTTPException(400, "Query cannot be empty")

    settings = _load_settings()

    try:
        vectors = await _embed([body.query], settings)
    except RuntimeError as e:
        raise HTTPException(502, str(e))

    results = await _qdrant_search(
        vector=vectors[0],
        limit=body.limit,
        file_id=body.file_id,
    )

    return {
        "results": [
            {
                "score": r["score"],
                "file_id": r["payload"].get("file_id"),
                "original_filename": r["payload"].get("original_filename"),
                "page_number": r["payload"].get("page_number"),
                "page_type": r["payload"].get("page_type"),
                "page_title": r["payload"].get("page_title"),
                "snippet": r["payload"].get("content", "")[:400],
            }
            for r in results
        ]
    }
