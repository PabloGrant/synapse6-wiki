import json
import os
import time
import uuid
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from auth import require_role, get_current_user

router = APIRouter(prefix="/api/comments")

DATA_DIR = os.environ.get("DATA_DIR", "/data")
COMMENTS_DIR = os.path.join(DATA_DIR, "comments")


def _file(slug: str) -> str:
    return os.path.join(COMMENTS_DIR, f"{slug}.json")


def _load(slug: str) -> list:
    f = _file(slug)
    if not os.path.exists(f):
        return []
    with open(f) as fh:
        return json.load(fh)


def _save(slug: str, comments: list):
    os.makedirs(COMMENTS_DIR, exist_ok=True)
    with open(_file(slug), "w") as fh:
        json.dump(comments, fh, indent=2)


@router.get("/{slug}")
def get_comments(slug: str):
    return _load(slug)


class CommentBody(BaseModel):
    text: str


@router.post("/{slug}", dependencies=[Depends(get_current_user)])
def add_comment(slug: str, body: CommentBody, user=Depends(get_current_user)):
    if not body.text.strip():
        raise HTTPException(400, "Comment cannot be empty")
    comments = _load(slug)
    comments.append({
        "id": str(uuid.uuid4()),
        "author": user["sub"],   # email address
        "text": body.text.strip(),
        "created_at": int(time.time()),
    })
    _save(slug, comments)
    return {"ok": True}


@router.delete("/{slug}/{comment_id}", dependencies=[Depends(require_role("admin"))])
def delete_comment(slug: str, comment_id: str):
    comments = _load(slug)
    comments = [c for c in comments if c["id"] != comment_id]
    _save(slug, comments)
    return {"ok": True}
