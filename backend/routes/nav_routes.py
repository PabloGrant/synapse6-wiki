import json
import os
import re
from datetime import date
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional
from auth import require_role

router = APIRouter(prefix="/api/nav")

DATA_DIR = os.environ.get("DATA_DIR", "/data")
NAV_FILE = os.path.join(DATA_DIR, "nav.json")


def _load_nav() -> dict:
    if not os.path.exists(NAV_FILE):
        return {"categories": []}
    with open(NAV_FILE) as f:
        return json.load(f)


def _save_nav(nav: dict):
    os.makedirs(os.path.dirname(NAV_FILE), exist_ok=True)
    with open(NAV_FILE, "w") as f:
        json.dump(nav, f, indent=2)


def _slugify(name: str) -> str:
    s = re.sub(r"[^\w\s-]", "", name.lower())
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s


def _display_name(name: str) -> str:
    """Strip leading sort prefix like '01 ' or '01-' from display."""
    return re.sub(r"^\d+[\s\-\.]+", "", name).strip()


def _sort_items(items: list) -> list:
    return sorted(items, key=lambda x: x["name"].lower())


def _enrich(items: list) -> list:
    """Add display_name to each item recursively."""
    out = []
    for item in _sort_items(items):
        i = dict(item)
        i["display_name"] = _display_name(item["name"])
        if "pages" in i:
            i["pages"] = _enrich(i["pages"])
        if "subpages" in i:
            i["subpages"] = _enrich(i["subpages"])
        out.append(i)
    return out


@router.get("", dependencies=[Depends(require_role("user"))])
def get_nav():
    nav = _load_nav()
    nav["categories"] = _enrich(nav.get("categories", []))
    return nav


class CategoryBody(BaseModel):
    name: str


class PageBody(BaseModel):
    name: str
    category_slug: str
    parent_slug: Optional[str] = None  # if set, creates a subpage under this page


class RenameBody(BaseModel):
    name: str


@router.post("/category", dependencies=[Depends(require_role("editor"))])
def add_category(body: CategoryBody):
    nav = _load_nav()
    slug = _slugify(body.name)
    if any(c["slug"] == slug for c in nav["categories"]):
        slug = slug + "-2"
    nav["categories"].append({"name": body.name, "slug": slug, "pages": []})
    _save_nav(nav)
    return {"ok": True, "slug": slug}


@router.delete("/category/{slug}", dependencies=[Depends(require_role("admin"))])
def delete_category(slug: str):
    nav = _load_nav()
    nav["categories"] = [c for c in nav["categories"] if c["slug"] != slug]
    _save_nav(nav)
    return {"ok": True}


@router.post("/page", dependencies=[Depends(require_role("editor"))])
def add_page(body: PageBody):
    nav = _load_nav()
    slug = date.today().strftime("%Y%m%d") + "-" + _slugify(body.name)
    for cat in nav["categories"]:
        if cat["slug"] == body.category_slug:
            if body.parent_slug:
                # subpage
                for pg in cat["pages"]:
                    if pg["slug"] == body.parent_slug:
                        if "subpages" not in pg:
                            pg["subpages"] = []
                        pg["subpages"].append({"name": body.name, "slug": slug})
                        break
            else:
                cat["pages"].append({"name": body.name, "slug": slug, "subpages": []})
            break
    _save_nav(nav)
    return {"ok": True, "slug": slug}


@router.delete("/page/{slug}", dependencies=[Depends(require_role("admin"))])
def delete_page(slug: str):
    nav = _load_nav()
    for cat in nav["categories"]:
        cat["pages"] = [p for p in cat["pages"] if p["slug"] != slug]
        for pg in cat["pages"]:
            if "subpages" in pg:
                pg["subpages"] = [s for s in pg["subpages"] if s["slug"] != slug]
    _save_nav(nav)
    return {"ok": True}


@router.patch("/page/{slug}/rename", dependencies=[Depends(require_role("editor"))])
def rename_page(slug: str, body: RenameBody):
    nav = _load_nav()
    for cat in nav["categories"]:
        for pg in cat["pages"]:
            if pg["slug"] == slug:
                pg["name"] = body.name
            if "subpages" in pg:
                for sp in pg["subpages"]:
                    if sp["slug"] == slug:
                        sp["name"] = body.name
    _save_nav(nav)
    return {"ok": True}
