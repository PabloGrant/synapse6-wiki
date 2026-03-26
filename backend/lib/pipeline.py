"""
Shared AI pipeline utilities.

Used by pages_routes (wiki indexing) and hypatia_routes (semantic retrieval).
library_routes has its own copies — migrate those here in a future cleanup pass.
"""

import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx

DATA_DIR      = os.environ.get("DATA_DIR", "/data")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
QDRANT_URL    = os.environ.get("QDRANT_URL", "http://100.66.18.38:6333")
QDRANT_COL    = "synapse6_library"


# ── Settings ──────────────────────────────────────────────────────────────

def load_settings() -> dict:
    if not os.path.exists(SETTINGS_FILE):
        return {}
    with open(SETTINGS_FILE) as f:
        return json.load(f)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Embedding ─────────────────────────────────────────────────────────────

async def embed(texts: list[str], settings: dict) -> list[list[float]]:
    """Batch-embed texts using the configured embedding model hierarchy."""
    models = sorted(
        [m for m in settings.get("llm_models", [])
         if m.get("enabled") and m.get("type") == "embedding"],
        key=lambda m: m.get("order", 0),
    )
    if not models:
        raise RuntimeError("No embedding model configured.")

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


# ── LLM summarization ─────────────────────────────────────────────────────

async def summarize(content: str, title: str, settings: dict) -> dict:
    """Ask the LLM to produce a structured summary: summary, key_points, claims."""
    truncated = content[:60_000]
    system = (
        "You are a document analyst. Read the content and return ONLY valid JSON "
        "in this exact structure:\n"
        '{"summary":"...","key_points":["..."],"claims":["..."]}\n'
        "summary: 3-5 sentence overview. "
        "key_points: up to 8 important facts or findings. "
        "claims: specific assertions or conclusions the document makes."
    )
    user_msg = f"Title: {title}\n\n{truncated}"

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
                raw = resp.json()["choices"][0]["message"]["content"].strip()
                m = re.search(r"\{.*\}", raw, re.DOTALL)
                if m:
                    return json.loads(m.group())
                return {"summary": raw, "key_points": [], "claims": []}
            except Exception as e:
                last_err = str(e)
    return {"summary": f"Unavailable: {last_err}", "key_points": [], "claims": []}


# ── Qdrant ────────────────────────────────────────────────────────────────

async def qdrant_upsert(points: list[dict]):
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.put(
            f"{QDRANT_URL}/collections/{QDRANT_COL}/points",
            json={"points": points},
        )
        resp.raise_for_status()


async def qdrant_delete_by(field: str, value: str):
    """Delete all points where payload[field] == value."""
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{QDRANT_URL}/collections/{QDRANT_COL}/points/delete",
            json={"filter": {"must": [{"key": field, "match": {"value": value}}]}},
        )
        resp.raise_for_status()


async def qdrant_search(
    vector: list[float],
    limit: int = 20,
    must: Optional[list[dict]] = None,
    must_not: Optional[list[dict]] = None,
    score_threshold: float = 0.20,
) -> list[dict]:
    payload: dict = {
        "vector": vector,
        "limit": limit,
        "with_payload": True,
        "score_threshold": score_threshold,
    }
    f: dict = {}
    if must:
        f["must"] = must
    if must_not:
        f["must_not"] = must_not
    if f:
        payload["filter"] = f

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{QDRANT_URL}/collections/{QDRANT_COL}/points/search",
            json=payload,
        )
        resp.raise_for_status()
        return resp.json().get("result", [])


async def qdrant_ensure_index(field_name: str, field_type: str = "keyword"):
    """Create a payload index if it doesn't exist (idempotent, non-fatal)."""
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            await client.put(
                f"{QDRANT_URL}/collections/{QDRANT_COL}/index",
                json={"field_name": field_name, "field_schema": field_type},
            )
        except Exception:
            pass


# ── Text chunking ─────────────────────────────────────────────────────────

def chunk_markdown(text: str, max_chars: int = 1500, min_chars: int = 80) -> list[dict]:
    """
    Split markdown into indexable chunks by heading sections.
    Falls back to paragraph splitting for large sections.
    Returns list of {chunk_index, heading, content}.
    """
    # Split on h1/h2/h3 headings
    sections = re.split(r'\n(?=#{1,3} )', text)

    chunks = []
    idx = 0
    current_heading = ""

    for section in sections:
        section = section.strip()
        if not section:
            continue

        heading_match = re.match(r'^#{1,3}\s+(.+)', section)
        if heading_match:
            current_heading = heading_match.group(1).strip()

        if len(section) <= max_chars:
            if len(section) >= min_chars:
                chunks.append({"chunk_index": idx, "heading": current_heading, "content": section})
                idx += 1
        else:
            # Large section: split by paragraphs
            paragraphs = [p.strip() for p in section.split('\n\n') if p.strip()]
            buf = ""
            for para in paragraphs:
                if len(buf) + len(para) > max_chars and len(buf) >= min_chars:
                    chunks.append({"chunk_index": idx, "heading": current_heading, "content": buf})
                    idx += 1
                    buf = para
                else:
                    buf = (buf + "\n\n" + para).strip() if buf else para
            if buf and len(buf) >= min_chars:
                chunks.append({"chunk_index": idx, "heading": current_heading, "content": buf})
                idx += 1

    return chunks
