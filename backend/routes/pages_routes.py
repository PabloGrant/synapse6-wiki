import asyncio
import glob
import json
import os
import re
import time
import uuid

import aiofiles
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from auth import require_role, get_current_user

router = APIRouter(prefix="/api/pages")

DATA_DIR    = os.environ.get("DATA_DIR", "/data")
CONTENT_DIR = os.path.join(DATA_DIR, "content")
META_FILE   = "_meta.json"   # sidecar inside each slug directory


def _page_dir(slug: str) -> str:
    return os.path.join(CONTENT_DIR, slug)


def _list_versions(slug: str) -> list:
    d = _page_dir(slug)
    if not os.path.exists(d):
        return []
    files = sorted(glob.glob(os.path.join(d, "*.md")), reverse=True)
    versions = []
    for f in files:
        fname = os.path.basename(f)
        parts = fname[:-3].split("_", 2)
        versions.append({
            "filename": fname,
            "timestamp": int(parts[1]) if len(parts) > 1 else 0,
            "editor": parts[2] if len(parts) > 2 else "unknown",
        })
    return versions


def _latest_file(slug: str) -> Optional[str]:
    versions = _list_versions(slug)
    if not versions:
        return None
    return os.path.join(_page_dir(slug), versions[0]["filename"])


def _extract_title(content: str, slug: str) -> str:
    m = re.match(r'^#\s+(.+)', content.strip())
    return m.group(1).strip() if m else slug.replace("-", " ").title()


# ── Background indexing pipeline ──────────────────────────────────────────

async def _index_page(slug: str, content: str, timestamp: int, editor: str):
    """
    Background task: embed wiki page chunks into Qdrant + generate summary sidecar.
    Fires on every save. Replaces the previous version's vectors.
    Non-fatal: a failed index never blocks the save response.
    """
    from lib.pipeline import (
        load_settings, embed, summarize, qdrant_upsert,
        qdrant_delete_by, qdrant_ensure_index, chunk_markdown, now_iso,
    )

    settings = load_settings()
    title = _extract_title(content, slug)

    # Ensure the slug payload index exists (idempotent)
    await qdrant_ensure_index("slug")

    # Replace previous vectors for this slug
    try:
        await qdrant_delete_by("slug", slug)
    except Exception:
        pass

    # Chunk and embed
    vectors_count = 0
    chunks = chunk_markdown(content)
    if chunks:
        try:
            texts = [c["content"] for c in chunks]
            vectors = await embed(texts, settings)

            points = []
            for chunk, vector in zip(chunks, vectors):
                points.append({
                    "id": str(uuid.uuid4()),
                    "vector": vector,
                    "payload": {
                        "type": "wiki_page",
                        "slug": slug,
                        "page_title": title,
                        "heading": chunk["heading"],
                        "chunk_index": chunk["chunk_index"],
                        "content": chunk["content"],
                        "editor": editor,
                        "timestamp": timestamp,
                        "indexed_at": now_iso(),
                    },
                })
            await qdrant_upsert(points)
            vectors_count = len(points)
        except Exception:
            pass  # Don't fail the save if embedding/Qdrant is unavailable

    # LLM summary (best-effort)
    try:
        summary_data = await summarize(content, title, settings)
    except Exception:
        summary_data = {"summary": "", "key_points": [], "claims": []}

    # Write sidecar metadata
    meta = {
        "slug": slug,
        "title": title,
        "last_edited_by": editor,
        "last_indexed_at": now_iso(),
        "timestamp": timestamp,
        "qdrant_indexed": vectors_count > 0,
        "vectors_count": vectors_count,
        **summary_data,
    }
    meta_path = os.path.join(_page_dir(slug), META_FILE)
    try:
        with open(meta_path, "w") as f:
            json.dump(meta, f, indent=2)
    except Exception:
        pass


async def _deindex_page(slug: str):
    """Remove all Qdrant vectors for this slug. Best-effort."""
    try:
        from lib.pipeline import qdrant_delete_by
        await qdrant_delete_by("slug", slug)
    except Exception:
        pass


# ── Routes ────────────────────────────────────────────────────────────────

@router.get("/{slug}", dependencies=[Depends(require_role("user"))])
async def get_page(slug: str):
    path = _latest_file(slug)
    if not path:
        raise HTTPException(404, "Page not found")
    async with aiofiles.open(path, "r") as f:
        content = await f.read()
    versions = _list_versions(slug)

    # Attach sidecar metadata if available
    meta = {}
    meta_path = os.path.join(_page_dir(slug), META_FILE)
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as mf:
                meta = json.load(mf)
        except Exception:
            pass

    return {
        "slug": slug,
        "content": content,
        "versions": versions[:5],
        "current_version": versions[0] if versions else None,
        "meta": meta,
    }


@router.get("/{slug}/version/{filename}", dependencies=[Depends(require_role("user"))])
async def get_version(slug: str, filename: str):
    path = os.path.join(_page_dir(slug), filename)
    if not os.path.exists(path):
        raise HTTPException(404, "Version not found")
    async with aiofiles.open(path, "r") as f:
        content = await f.read()
    return {"slug": slug, "filename": filename, "content": content}


class SaveBody(BaseModel):
    content: str


@router.put("/{slug}", dependencies=[Depends(require_role("editor"))])
async def save_page(slug: str, body: SaveBody, user=Depends(require_role("editor"))):
    d = _page_dir(slug)
    os.makedirs(d, exist_ok=True)
    ts = int(time.time())
    editor = user["sub"].replace("_", "-")
    filename = f"{slug}_{ts}_{editor}.md"
    path = os.path.join(d, filename)
    async with aiofiles.open(path, "w") as f:
        await f.write(body.content)

    # Prune: keep only latest 20 versions on disk
    versions = _list_versions(slug)
    for old in versions[20:]:
        try:
            os.remove(os.path.join(d, old["filename"]))
        except OSError:
            pass

    # Fire-and-forget: index into Qdrant + generate summary
    asyncio.create_task(_index_page(slug, body.content, ts, editor))

    return {"ok": True, "filename": filename}


@router.post("/{slug}/rollback/{filename}", dependencies=[Depends(require_role("editor"))])
async def rollback(slug: str, filename: str, user=Depends(require_role("editor"))):
    src = os.path.join(_page_dir(slug), filename)
    if not os.path.exists(src):
        raise HTTPException(404, "Version not found")
    async with aiofiles.open(src, "r") as f:
        content = await f.read()
    ts = int(time.time())
    editor = user["sub"].replace("_", "-")
    new_filename = f"{slug}_{ts}_{editor}.md"
    dest = os.path.join(_page_dir(slug), new_filename)
    async with aiofiles.open(dest, "w") as f:
        await f.write(content)

    # Re-index the rolled-back content
    asyncio.create_task(_index_page(slug, content, ts, editor))

    return {"ok": True, "filename": new_filename}


@router.delete("/{slug}/version/{filename}", dependencies=[Depends(require_role("superadmin"))])
async def delete_version(slug: str, filename: str):
    """Delete a single version file. If it was the current version, re-index from the new latest."""
    # Safety: filename must look like a valid version file, no path traversal
    if "/" in filename or "\\" in filename or not filename.endswith(".md"):
        raise HTTPException(400, "Invalid filename")
    path = os.path.join(_page_dir(slug), filename)
    if not os.path.exists(path):
        raise HTTPException(404, "Version not found")

    versions_before = _list_versions(slug)
    was_current = versions_before and versions_before[0]["filename"] == filename

    os.remove(path)

    if was_current:
        versions_after = _list_versions(slug)
        if versions_after:
            # Re-index from the new latest version
            new_path = os.path.join(_page_dir(slug), versions_after[0]["filename"])
            try:
                async with aiofiles.open(new_path, "r") as f:
                    content = await f.read()
                asyncio.create_task(_index_page(
                    slug, content,
                    versions_after[0]["timestamp"],
                    versions_after[0]["editor"],
                ))
            except Exception:
                pass
        else:
            # No versions left — remove from Qdrant entirely
            await _deindex_page(slug)

    return {"ok": True}


@router.delete("/{slug}", dependencies=[Depends(require_role("admin"))])
async def delete_page(slug: str):
    import shutil
    # Remove from Qdrant first (best-effort)
    await _deindex_page(slug)
    # Remove all local files
    d = _page_dir(slug)
    if os.path.exists(d):
        shutil.rmtree(d)
    return {"ok": True}
