import os
import glob
import time
import aiofiles
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from auth import require_role, get_current_user

router = APIRouter(prefix="/api/pages")

DATA_DIR = os.environ.get("DATA_DIR", "/data")
CONTENT_DIR = os.path.join(DATA_DIR, "content")


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
        # format: {slug}_{timestamp}_{editor}.md
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


@router.get("/{slug}")
async def get_page(slug: str):
    path = _latest_file(slug)
    if not path:
        raise HTTPException(404, "Page not found")
    async with aiofiles.open(path, "r") as f:
        content = await f.read()
    versions = _list_versions(slug)
    return {
        "slug": slug,
        "content": content,
        "versions": versions[:5],
        "current_version": versions[0] if versions else None,
    }


@router.get("/{slug}/version/{filename}")
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
    return {"ok": True, "filename": new_filename}


@router.delete("/{slug}", dependencies=[Depends(require_role("admin"))])
def delete_page(slug: str):
    import shutil
    d = _page_dir(slug)
    if os.path.exists(d):
        shutil.rmtree(d)
    return {"ok": True}
