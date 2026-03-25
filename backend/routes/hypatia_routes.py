import os
import glob
import json
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List
from auth import get_current_user, require_role

router = APIRouter(prefix="/api/hypatia")

DATA_DIR = os.environ.get("DATA_DIR", "/data")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
CONTENT_DIR = os.path.join(DATA_DIR, "content")

LLM_BASE = os.environ.get("LLM_BASE", "http://10.42.42.3:8011")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-oss-120b")
LLM_MAX_CONTEXT_CHARS = 80_000  # ~20k tokens safety ceiling


def _load_settings() -> dict:
    if not os.path.exists(SETTINGS_FILE):
        return {}
    with open(SETTINGS_FILE) as f:
        return json.load(f)


def _save_settings(s: dict):
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(s, f, indent=2)


def _default_system_prompt() -> str:
    return (
        "You are Hypatia, the internal knowledge assistant for Synapse6. "
        "You have access to the company's full knowledge base as context below. "
        "Answer questions clearly and concisely. If something isn't in the knowledge base, say so. "
        "Be direct, professional, and helpful. Do not hallucinate facts about the company."
    )


def _gather_kb_context() -> str:
    """Read the latest version of every page and concatenate as context."""
    slugs = []
    if os.path.exists(CONTENT_DIR):
        slugs = [
            d for d in os.listdir(CONTENT_DIR)
            if os.path.isdir(os.path.join(CONTENT_DIR, d))
        ]

    chunks = []
    total = 0
    for slug in sorted(slugs):
        d = os.path.join(CONTENT_DIR, slug)
        files = sorted(glob.glob(os.path.join(d, "*.md")), reverse=True)
        if not files:
            continue
        with open(files[0]) as f:
            content = f.read()
        chunk = f"\n\n---\n# Page: {slug}\n\n{content}"
        if total + len(chunk) > LLM_MAX_CONTEXT_CHARS:
            break
        chunks.append(chunk)
        total += len(chunk)

    return "".join(chunks)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatBody(BaseModel):
    messages: List[ChatMessage]


@router.post("/chat", dependencies=[Depends(get_current_user)])
async def chat(body: ChatBody):
    settings = _load_settings()
    system_prompt = settings.get("hypatia_system_prompt", _default_system_prompt())
    kb_context = _gather_kb_context()

    full_system = system_prompt
    if kb_context:
        full_system += f"\n\n## Knowledge Base\n{kb_context}"

    messages = [{"role": "system", "content": full_system}]
    messages += [{"role": m.role, "content": m.content} for m in body.messages]

    async with httpx.AsyncClient(timeout=120) as client:
        try:
            resp = await client.post(
                f"{LLM_BASE}/v1/chat/completions",
                json={
                    "model": LLM_MODEL,
                    "messages": messages,
                    "max_tokens": 1024,
                    "temperature": 0.4,
                    "stream": False,
                },
            )
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(502, f"LLM unreachable: {e}")

    data = resp.json()
    reply = data["choices"][0]["message"]["content"]
    return {"reply": reply}


@router.get("/settings", dependencies=[Depends(require_role("superadmin"))])
def get_hypatia_settings():
    settings = _load_settings()
    return {
        "system_prompt": settings.get("hypatia_system_prompt", _default_system_prompt())
    }


class PromptBody(BaseModel):
    system_prompt: str


@router.put("/settings", dependencies=[Depends(require_role("superadmin"))])
def update_hypatia_settings(body: PromptBody):
    settings = _load_settings()
    settings["hypatia_system_prompt"] = body.system_prompt
    _save_settings(settings)
    return {"ok": True}
