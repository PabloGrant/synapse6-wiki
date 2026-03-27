import glob
import json
import os
import re
from fastapi import APIRouter, Depends
from auth import require_role

router = APIRouter(prefix="/api")

DATA_DIR     = os.environ.get("DATA_DIR", "/data")
CONTENT_DIR  = os.path.join(DATA_DIR, "content")
COMMENTS_DIR = os.path.join(DATA_DIR, "comments")
LIBRARY_DIR  = os.path.join(DATA_DIR, "library", "files")
NAV_FILE     = os.path.join(DATA_DIR, "nav.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
META_FILE    = "_meta.json"


def _load_nav() -> dict:
    if not os.path.exists(NAV_FILE):
        return {"categories": []}
    with open(NAV_FILE) as f:
        return json.load(f)


def _load_settings() -> dict:
    if not os.path.exists(SETTINGS_FILE):
        return {}
    with open(SETTINGS_FILE) as f:
        return json.load(f)


def _nav_page_map(nav: dict) -> dict:
    """Return {slug: page_name} for all pages in nav."""
    mapping = {}
    for cat in nav.get("categories", []):
        for pg in cat.get("pages", []):
            mapping[pg["slug"]] = pg.get("name", pg["slug"])
            for sp in pg.get("subpages", []):
                mapping[sp["slug"]] = sp.get("name", sp["slug"])
    return mapping


def _walk_nav_pages(nav: dict) -> list:
    """Return flat list of all page slugs from nav."""
    slugs = []
    for cat in nav.get("categories", []):
        for pg in cat.get("pages", []):
            slugs.append(pg["slug"])
            for sp in pg.get("subpages", []):
                slugs.append(sp["slug"])
    return slugs


def _title_from_meta_or_slug(slug: str) -> str:
    meta_path = os.path.join(CONTENT_DIR, slug, META_FILE)
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as f:
                m = json.load(f)
            if m.get("title"):
                return m["title"]
        except Exception:
            pass
    return slug.replace("-", " ").title()


def _latest_version(slug: str):
    """Return (timestamp, editor) for the most recent .md file in slug dir."""
    d = os.path.join(CONTENT_DIR, slug)
    if not os.path.isdir(d):
        return None
    md_files = sorted(
        [f for f in os.listdir(d) if f.endswith(".md") and f != META_FILE],
        reverse=True
    )
    if not md_files:
        return None
    fname = md_files[0]
    parts = fname[:-3].split("_", 2)
    ts = int(parts[1]) if len(parts) > 1 else 0
    editor = parts[2] if len(parts) > 2 else "unknown"
    return ts, editor


@router.get("/dashboard", dependencies=[Depends(require_role("user"))])
def get_dashboard():
    nav = _load_nav()
    settings = _load_settings()

    # ── stats ─────────────────────────────────────────────────────────────
    # pages: count subdirs in CONTENT_DIR
    pages_count = 0
    if os.path.isdir(CONTENT_DIR):
        pages_count = sum(
            1 for e in os.scandir(CONTENT_DIR)
            if e.is_dir()
        )

    # categories: from nav.json
    cats_count = len(nav.get("categories", []))

    # files: count .json files in LIBRARY_DIR
    files_count = 0
    if os.path.isdir(LIBRARY_DIR):
        files_count = sum(1 for f in os.listdir(LIBRARY_DIR) if f.endswith(".json"))

    # ── recent pages ──────────────────────────────────────────────────────
    recent_pages = []
    if os.path.isdir(CONTENT_DIR):
        for entry in os.scandir(CONTENT_DIR):
            if not entry.is_dir():
                continue
            slug = entry.name
            ver = _latest_version(slug)
            if ver is None:
                continue
            ts, editor = ver
            title = _title_from_meta_or_slug(slug)
            recent_pages.append({
                "slug": slug,
                "title": title,
                "editor": editor,
                "timestamp": ts,
            })
    recent_pages.sort(key=lambda x: x["timestamp"], reverse=True)
    recent_pages = recent_pages[:10]

    # ── recent files ──────────────────────────────────────────────────────
    recent_files = []
    if os.path.isdir(LIBRARY_DIR):
        for fname in os.listdir(LIBRARY_DIR):
            if not fname.endswith(".json"):
                continue
            try:
                with open(os.path.join(LIBRARY_DIR, fname)) as f:
                    m = json.load(f)
                recent_files.append({
                    "id": m.get("id", ""),
                    "original_filename": m.get("original_filename", ""),
                    "summary": m.get("summary", ""),
                    "upload_date": m.get("upload_date", ""),
                    "uploaded_by": m.get("uploaded_by", ""),
                })
            except Exception:
                continue
    recent_files.sort(key=lambda x: x["upload_date"], reverse=True)
    recent_files = recent_files[:10]

    # ── recent comments ───────────────────────────────────────────────────
    page_map = _nav_page_map(nav)
    all_comments = []
    if os.path.isdir(COMMENTS_DIR):
        for fname in os.listdir(COMMENTS_DIR):
            if not fname.endswith(".json"):
                continue
            slug = fname[:-5]
            try:
                with open(os.path.join(COMMENTS_DIR, fname)) as f:
                    comments = json.load(f)
                page_title = page_map.get(slug, slug.replace("-", " ").title())
                for c in comments:
                    all_comments.append({
                        "slug": slug,
                        "page_title": page_title,
                        "author": c.get("author", ""),
                        "text": c.get("text", ""),
                        "created_at": c.get("created_at", 0),
                    })
            except Exception:
                continue
    all_comments.sort(key=lambda x: x["created_at"], reverse=True)
    all_comments = all_comments[:10]

    # ── team & customers ──────────────────────────────────────────────────
    team = settings.get("dashboard_team", [])
    customers = settings.get("dashboard_customers", [])

    return {
        "stats": {
            "pages": pages_count,
            "categories": cats_count,
            "files": files_count,
        },
        "recent_pages": recent_pages,
        "recent_files": recent_files,
        "recent_comments": all_comments,
        "team": team,
        "customers": customers,
    }
