import json
import os
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from auth import require_role

router = APIRouter(prefix="/api/settings")

DATA_DIR = os.environ.get("DATA_DIR", "/data")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")


def _load() -> dict:
    if not os.path.exists(SETTINGS_FILE):
        return {}
    with open(SETTINGS_FILE) as f:
        return json.load(f)


def _save(s: dict):
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(s, f, indent=2)


@router.get("", dependencies=[Depends(require_role("superadmin"))])
def get_settings():
    return _load()


class SettingsBody(BaseModel):
    site_name: str = "Synapse6 Wiki"
    site_tagline: str = "Internal Knowledge Base"


@router.put("", dependencies=[Depends(require_role("superadmin"))])
def update_settings(body: SettingsBody):
    s = _load()
    s.update(body.dict())
    _save(s)
    return {"ok": True}


@router.get("/public")  # intentionally unauthenticated — only returns site name/tagline for login page
def get_public_settings():
    s = _load()
    return {
        "site_name": s.get("site_name", "Synapse6 Wiki"),
        "site_tagline": s.get("site_tagline", "Internal Knowledge Base"),
    }
