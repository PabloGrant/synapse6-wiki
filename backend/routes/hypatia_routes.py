import os
import glob
import json
import uuid
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict
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


@router.get("/avatar")
def get_avatar(user=Depends(get_current_user)):
    """Returns the Hypatia avatar dict {idle, listening, thinking, talking, action} (any logged-in user)."""
    settings = _load_settings()
    avatars = settings.get("hypatia_avatars", {})
    # backward compat: migrate old single-avatar key
    if not avatars and settings.get("hypatia_avatar"):
        avatars = {"idle": settings["hypatia_avatar"]}
    return {"avatars": avatars}


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

    # Build ordered list of enabled LLM models; fall back to env vars if none configured
    llm_models = [
        m for m in settings.get("llm_models", [])
        if m.get("enabled") and m.get("type", "llm") == "llm"
    ]
    llm_models.sort(key=lambda m: m.get("order", 0))

    if not llm_models:
        llm_models = [{"api_endpoint": LLM_BASE, "api_token": "", "model_name": LLM_MODEL}]

    last_error = None
    async with httpx.AsyncClient(timeout=120) as client:
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
                        "messages": messages,
                        "max_tokens": 1024,
                        "temperature": 0.4,
                        "stream": False,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                return {"reply": data["choices"][0]["message"]["content"], "model_used": model.get("label", model["model_name"])}
            except Exception as e:
                last_error = str(e)
                continue

    raise HTTPException(502, f"All LLM models failed. Last error: {last_error}")


STATIC_DIR = os.environ.get("STATIC_DIR", "/app/static")


@router.get("/avatars", dependencies=[Depends(require_role("superadmin"))])
def list_avatars():
    avatar_dir = os.path.join(STATIC_DIR, "avatars")
    if not os.path.exists(avatar_dir):
        return {"avatars": []}
    files = sorted(
        f for f in os.listdir(avatar_dir)
        if f.lower().endswith(".gif")
    )
    return {"avatars": files}


class AvatarBody(BaseModel):
    avatars: Dict[str, str]  # {idle, listening, thinking, talking, action}


@router.put("/avatar", dependencies=[Depends(require_role("superadmin"))])
def set_avatar(body: AvatarBody):
    settings = _load_settings()
    settings["hypatia_avatars"] = body.avatars
    _save_settings(settings)
    return {"ok": True}


@router.get("/settings", dependencies=[Depends(require_role("superadmin"))])
def get_hypatia_settings():
    settings = _load_settings()
    avatars = settings.get("hypatia_avatars", {})
    if not avatars and settings.get("hypatia_avatar"):
        avatars = {"idle": settings["hypatia_avatar"]}
    return {
        "system_prompt": settings.get("hypatia_system_prompt", _default_system_prompt()),
        "avatars": avatars,
    }


class PromptBody(BaseModel):
    system_prompt: str


@router.put("/settings", dependencies=[Depends(require_role("superadmin"))])
def update_hypatia_settings(body: PromptBody):
    settings = _load_settings()
    settings["hypatia_system_prompt"] = body.system_prompt
    _save_settings(settings)
    return {"ok": True}


# ── Model configuration ────────────────────────────────────────────────────

class ModelConfig(BaseModel):
    id: Optional[str] = None
    label: str
    api_endpoint: str
    api_token: str = ""
    model_name: str = ""
    type: str = "llm"        # "llm" or "embedding"
    provider: str = "hdc"   # "hdc", "openrouter", "pollinations"
    enabled: bool = True
    order: int = 0


class ModelsBody(BaseModel):
    models: List[ModelConfig]


@router.get("/models", dependencies=[Depends(require_role("superadmin"))])
def get_model_configs():
    settings = _load_settings()
    return {"models": settings.get("llm_models", [])}


@router.put("/models", dependencies=[Depends(require_role("superadmin"))])
def save_model_configs(body: ModelsBody):
    settings = _load_settings()
    models = []
    for i, m in enumerate(body.models):
        d = m.dict()
        if not d.get("id"):
            d["id"] = str(uuid.uuid4())
        d["order"] = i
        models.append(d)
    settings["llm_models"] = models
    _save_settings(settings)
    return {"ok": True}


class FetchModelsBody(BaseModel):
    provider: str
    api_endpoint: str = ""
    api_token: str = ""

class TestModelBody(BaseModel):
    api_endpoint: str
    api_token: str = ""
    model_name: str = ""
    type: str = "llm"


@router.post("/test-model", dependencies=[Depends(require_role("superadmin"))])
async def test_model(body: TestModelBody):
    """Send a minimal chat completion to verify the model is reachable."""
    base = body.api_endpoint.rstrip("/")
    headers = {"Content-Type": "application/json"}
    if body.api_token:
        headers["Authorization"] = f"Bearer {body.api_token}"
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            if body.type == "embedding":
                resp = await client.post(
                    f"{base}/v1/embeddings",
                    headers=headers,
                    json={"model": body.model_name, "input": "test"},
                )
                resp.raise_for_status()
                data = resp.json()
                dims = len(data["data"][0]["embedding"])
                return {"ok": True, "reply": f"{dims}-dim vector"}
            else:
                resp = await client.post(
                    f"{base}/v1/chat/completions",
                    headers=headers,
                    json={
                        "model": body.model_name,
                        "messages": [{"role": "user", "content": "Reply with one word: OK"}],
                        "max_tokens": 16,
                        "temperature": 0,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                reply = data["choices"][0]["message"]["content"].strip()
                return {"ok": True, "reply": reply}
        except httpx.TimeoutException:
            raise HTTPException(504, "Connection timed out")
        except httpx.HTTPStatusError as e:
            raise HTTPException(502, f"HTTP {e.response.status_code}: {e.response.text[:200]}")
        except Exception as e:
            raise HTTPException(502, str(e))


@router.post("/fetch-models", dependencies=[Depends(require_role("superadmin"))])
async def fetch_provider_models(body: FetchModelsBody):
    """Proxy request to provider to retrieve available model names."""
    headers = {}
    if body.api_token:
        headers["Authorization"] = f"Bearer {body.api_token}"

    if body.provider == "openrouter":
        url = "https://openrouter.ai/api/v1/models"
    elif body.provider == "pollinations":
        url = "https://text.pollinations.ai/models"
    elif body.provider == "hdc":
        base = body.api_endpoint.rstrip("/")
        if not base:
            raise HTTPException(400, "API endpoint required for HDC provider")
        url = f"{base}/v1/models"
    else:
        raise HTTPException(400, f"Unknown provider: {body.provider}")

    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Could not reach provider: {e}")

    data = resp.json()

    # Normalize to [{id, name}]
    if isinstance(data, list):
        # Pollinations returns array of objects with "name" field, or strings
        if data and isinstance(data[0], str):
            models = [{"id": m, "name": m} for m in data]
        else:
            models = [{"id": m.get("name", m.get("id", "")), "name": m.get("name", m.get("id", ""))} for m in data]
    elif isinstance(data, dict) and "data" in data:
        # OpenAI-compatible format (HDC, OpenRouter)
        models = [{"id": m["id"], "name": m.get("name", m["id"])} for m in data["data"]]
    else:
        models = []

    return {"models": sorted(models, key=lambda m: m["name"].lower())}
