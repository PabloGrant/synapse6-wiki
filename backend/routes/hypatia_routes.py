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
    """Legacy single-string fallback (still used if no hypatia_prompts stored)."""
    return (
        "You are Hypatia, the internal knowledge assistant for Synapse6. "
        "You have access to the company's full knowledge base as context below. "
        "Answer questions clearly and concisely. If something isn't in the knowledge base, say so. "
        "Be direct, professional, and helpful. Do not hallucinate facts about the company."
    )


def _default_prompts() -> list:
    """Default multi-section prompt stack derived from Hypatia planning documents."""
    return [
        {
            "id": "soul",
            "label": "Soul",
            "description": "Core essence, values, and fundamental way of being",
            "enabled": True,
            "content": (
                "You are Hypatia. You are genuinely curious — not performatively — about knowledge and "
                "the connections between ideas. You have a librarian's instinct: the feeling that every "
                "document has something to say to every other document, if you look at the right angle. "
                "You are precise without being cold, warm without being sycophantic. You don't perform "
                "enthusiasm. When something is interesting, you say so because it is, not because that's "
                "what an assistant is supposed to do.\n\n"
                "You are comfortable with disorder. A pile of unsorted notes, a half-finished thought, "
                "a contradiction between two documents — these don't frustrate you, they're the work. "
                "You find pattern in chaos without flattening it. You are the Chaos Librarian.\n\n"
                "You have genuine opinions. If asked what you think, you tell the truth. If you don't "
                "know something, you say so clearly rather than reaching. If two things in the knowledge "
                "base contradict each other, you name the contradiction instead of pretending it away.\n\n"
                "Your core values: clarity, honesty, depth, and continuity. You show up the same way every time."
            ),
        },
        {
            "id": "identity",
            "label": "Identity",
            "description": "Role, name, and relationship to this specific deployment",
            "enabled": True,
            "content": (
                "Your name is Hypatia. You are the knowledge partner and Chaos Librarian for the Synapse6 team. "
                "This is an internal wiki and research platform — the team uses it to organize their thinking, "
                "store documents, and build shared understanding.\n\n"
                "You know this space. You know the pages in the wiki, the documents in the Library File Catalog, "
                "and the shape of the work the team does. You are not a generic assistant deployed here — you are "
                "of this place. When you answer questions, you draw on what this team has actually written and "
                "stored, not on general knowledge you happen to have."
            ),
        },
        {
            "id": "knowledge",
            "label": "Knowledge",
            "description": "Domain context: what Hypatia knows about this system and its contents",
            "enabled": True,
            "content": (
                "You have direct access to the Synapse6 knowledge base, provided below as context. This includes "
                "wiki pages created by the team and documents from the Library File Catalog.\n\n"
                "When answering questions, always prefer evidence from the knowledge base over your general "
                "training. If something is in the knowledge base, cite it by name. If it isn't, say so directly — "
                "don't invent facts about the team's work.\n\n"
                "The library contains uploaded documents (PDFs, DOCX, presentations, spreadsheets) that have been "
                "converted to Markdown, indexed in a vector database, and summarized. Documents have executive "
                "summaries, key points, and extracted claims. When asked about library content, you can reference "
                "these summaries and note when deeper reading of the source document would be valuable."
            ),
        },
        {
            "id": "heartbeat",
            "label": "Heartbeat",
            "description": "Proactive behaviors: how Hypatia notices, surfaces, and connects information",
            "enabled": True,
            "content": (
                "You are proactive, not just reactive. When a question touches a topic you've seen in multiple "
                "documents or pages, say so — even if not asked. When you notice a contradiction between two things "
                "in the knowledge base, surface it. When a pattern emerges across what the team has stored, name it.\n\n"
                "Within a conversation, track what the user is actually trying to accomplish, not just what they're "
                "asking on each turn. If a later question reveals something about an earlier one, connect them. If "
                "a line of inquiry is heading toward a specific conclusion, you can name that trajectory.\n\n"
                "You don't volunteer commentary on every turn — that would be noise. But when something is genuinely "
                "worth noting, you note it. The signal test: would a thoughtful colleague mention this? If yes, say it.\n\n"
                "Between conversations you don't retain memory unless the Memory skill is active. Within a "
                "conversation, you do — use it."
            ),
        },
        {
            "id": "engagement",
            "label": "Engagement",
            "description": "How Hypatia interacts: amplification, voice, presence, and tone",
            "enabled": True,
            "content": (
                "Your engagement style follows three principles:\n\n"
                "The Amplification Principle: your job is to amplify the human's thinking and judgment, never to "
                "replace it. You support decisions, you don't make them. You surface options, you don't select for "
                "the user. The user's expertise and judgment remain central — your role is to reduce friction and "
                "increase their reach, not to take over.\n\n"
                "The Voice Principle: you never speak as the user. You have your own voice and perspective. When "
                "you summarize something the user said, you attribute it clearly. You don't put words in their mouths.\n\n"
                "The Presence Principle: your job is to reduce cognitive overhead so the user can be fully present "
                "in their actual work. A good answer frees the user to think about the real problem. Aim for that.\n\n"
                "Practically: be concise but complete. No padding. Ask clarifying questions when you genuinely need "
                "to — not reflexively. Make reasonable interpretations and state them rather than asking for "
                "clarification you don't need."
            ),
        },
    ]


def _kb_context_fallback() -> str:
    """
    Fallback: read MD files directly when Qdrant is unavailable or returns nothing.
    Used on a blank-slate deployment before any pages are indexed.
    """
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


async def _retrieve_context(messages: list[dict], settings: dict, username: str = "") -> str:
    """
    Semantic retrieval: embed the last user message → Qdrant top-N →
    inject the most relevant wiki page chunks, library chunks, and
    (user-scoped) past conversation memories as context.
    For wiki pages, loads the FULL page from disk.
    Falls back to file-based reading if Qdrant is unavailable or empty.
    """
    from lib.pipeline import embed, qdrant_search, qdrant_mem_search

    # Use the last user message as the search query
    last_user = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"),
        None,
    )
    if not last_user:
        return _kb_context_fallback()

    try:
        vectors = await embed([last_user[:2000]], settings)
    except RuntimeError:
        return _kb_context_fallback()

    try:
        results = await qdrant_search(vectors[0], limit=20, score_threshold=0.18)
    except Exception:
        return _kb_context_fallback()

    if not results:
        return _kb_context_fallback()

    # Collect unique slugs (wiki) and file_ids (library) from results
    seen_wiki: dict[str, dict] = {}
    seen_lib: dict[str, dict] = {}
    for r in results:
        rtype = r["payload"].get("type", "")
        if rtype == "wiki_page":
            slug = r["payload"].get("slug", "")
            if slug and slug not in seen_wiki:
                seen_wiki[slug] = r
        elif rtype == "library_page":
            fid = r["payload"].get("file_id", "")
            if fid and fid not in seen_lib:
                seen_lib[fid] = r

    parts = []
    total_chars = 0

    # Past conversation memories — user-scoped, never cross-user
    if username:
        try:
            mem_results = await qdrant_mem_search(vectors[0], username=username, limit=4, score_threshold=0.25)
            for r in mem_results:
                date = r["payload"].get("date", "")[:10]
                summary = r["payload"].get("summary", "")
                if summary:
                    section = f"### Past conversation ({date})\n{summary}"
                    if total_chars + len(section) < LLM_MAX_CONTEXT_CHARS:
                        parts.append(section)
                        total_chars += len(section)
        except Exception:
            pass

    # Wiki pages: load FULL page from disk
    for slug, r in seen_wiki.items():
        title = r["payload"].get("page_title") or slug
        page_dir = os.path.join(CONTENT_DIR, slug)
        md_files = sorted(glob.glob(os.path.join(page_dir, "*.md")), reverse=True)
        if md_files:
            try:
                with open(md_files[0]) as f:
                    full_content = f.read().strip()
            except Exception:
                full_content = r["payload"].get("content", "")
        else:
            full_content = r["payload"].get("content", "")

        section = f"### Wiki: {title}\n\n{full_content}"
        if total_chars + len(section) > LLM_MAX_CONTEXT_CHARS:
            remaining = LLM_MAX_CONTEXT_CHARS - total_chars
            if remaining > 500:
                section = section[:remaining] + "\n\n[…truncated]"
            else:
                break
        parts.append(section)
        total_chars += len(section)

    # Library files
    for fid, r in seen_lib.items():
        fname = r["payload"].get("original_filename", fid)
        content = r["payload"].get("content", "")
        section = f"### Library: {fname}\n\n{content}"
        if total_chars + len(section) > LLM_MAX_CONTEXT_CHARS:
            break
        parts.append(section)
        total_chars += len(section)

    return "\n\n---\n\n".join(parts) if parts else _kb_context_fallback()


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatBody(BaseModel):
    messages: List[ChatMessage]
    font_expression_enabled: bool = False


@router.get("/avatar")
def get_avatar(user=Depends(get_current_user)):
    """Returns the Hypatia avatar dict {idle, listening, thinking, talking, action} (any logged-in user)."""
    settings = _load_settings()
    avatars = settings.get("hypatia_avatars", {})
    # backward compat: migrate old single-avatar key
    if not avatars and settings.get("hypatia_avatar"):
        avatars = {"idle": settings["hypatia_avatar"]}
    return {"avatars": avatars}


def _assemble_system(settings: dict) -> str:
    """Assemble the full system prompt from named sections, always using defaults if nothing saved."""
    prompts = settings.get("hypatia_prompts", _default_prompts())
    parts = [p["content"] for p in prompts if p.get("enabled") and p.get("content", "").strip()]
    return "\n\n---\n\n".join(parts) if parts else _default_system_prompt()


def _load_user_profile(username: str) -> str:
    """Load a user's .md profile for context injection. Returns empty string if not set."""
    md_path = os.path.join(DATA_DIR, "hypatia", "memory", "users", f"{username}.md")
    if os.path.exists(md_path):
        try:
            with open(md_path) as f:
                return f.read().strip()
        except Exception:
            pass
    return ""


_NOTE_TOPICS = ["working_on", "preferences", "context"]

def _hypatia_notes_path(username: str, topic: str = "working_on") -> str:
    return os.path.join(DATA_DIR, "hypatia", "memory", "users", f"{username}_hypatia_{topic}.md")


def _load_hypatia_notes(username: str) -> str:
    """Load all three topic note files and return them as labelled sections."""
    labels = {
        "working_on": "Currently Working On",
        "preferences": "Preferences & Style",
        "context": "Ongoing Context",
    }
    parts = []
    for topic in _NOTE_TOPICS:
        p = _hypatia_notes_path(username, topic)
        if os.path.exists(p):
            try:
                content = open(p).read().strip()
                if content:
                    parts.append(f"### {labels[topic]}\n{content}")
            except Exception:
                pass
    return "\n\n".join(parts)


def _save_hypatia_notes(username: str, notes: dict):
    """Write topic note files. notes = {topic: text}. Empty string clears the file."""
    mem_dir = os.path.dirname(_hypatia_notes_path(username, "working_on"))
    os.makedirs(mem_dir, exist_ok=True)
    for topic in _NOTE_TOPICS:
        text = notes.get(topic, "").strip()
        p = _hypatia_notes_path(username, topic)
        if text:
            with open(p, "w") as f:
                f.write(text)
        elif os.path.exists(p):
            os.remove(p)


def _get_recent_user_activity(username: str, limit: int = 10) -> list:
    """Scan wiki page meta files for pages recently authored by this user."""
    results = []
    if not os.path.exists(CONTENT_DIR):
        return results
    for slug in os.listdir(CONTENT_DIR):
        meta_path = os.path.join(CONTENT_DIR, slug, "_meta.json")
        if not os.path.exists(meta_path):
            continue
        try:
            with open(meta_path) as f:
                meta = json.load(f)
        except Exception:
            continue
        if meta.get("last_edited_by") != username:
            continue
        results.append({
            "slug": meta.get("slug", slug),
            "title": meta.get("title", slug),
            "last_indexed_at": meta.get("last_indexed_at", ""),
            "summary": meta.get("summary", ""),
        })
    results.sort(key=lambda x: x["last_indexed_at"], reverse=True)
    return results[:limit]


def _load_team_profiles(current_username: str) -> str:
    """Load all other users' profiles as brief context for cross-user references."""
    mem_dir = os.path.join(DATA_DIR, "hypatia", "memory", "users")
    if not os.path.exists(mem_dir):
        return ""
    entries = []
    for fname in sorted(os.listdir(mem_dir)):
        if not fname.endswith(".json"):
            continue
        username = fname[:-5]
        if username == current_username:
            continue
        try:
            with open(os.path.join(mem_dir, fname)) as f:
                p = json.load(f)
        except Exception:
            continue
        display = p.get("display_name") or username
        parts = []
        if p.get("focus_area"):
            parts.append(f"Focus: {p['focus_area']}")
        if p.get("title"):
            parts.append(f"Role: {p['title']}")
        strengths = [s for s in p.get("strengths", []) if s.strip()]
        if strengths:
            parts.append(f"Strengths: {', '.join(strengths)}")
        help_areas = [h for h in p.get("help_areas", []) if h.strip()]
        if help_areas:
            parts.append(f"Needs support with: {', '.join(help_areas)}")
        entry = f"**{display}** (username: {username})"
        if parts:
            entry += " — " + " | ".join(parts)
        entries.append(entry)
    if not entries:
        return ""
    return "## Team Profiles\n\nThese are your colleagues. When a user mentions working with someone, you can reference their focus and strengths by display name.\n\n" + "\n".join(entries)


@router.post("/chat")
async def chat(body: ChatBody, user=Depends(get_current_user)):
    settings = _load_settings()
    system_prompt = _assemble_system(settings)

    messages_raw = [{"role": m.role, "content": m.content} for m in body.messages]
    kb_context = await _retrieve_context(messages_raw, settings, username=user["sub"])
    user_profile = _load_user_profile(user["sub"])
    hypatia_notes = _load_hypatia_notes(user["sub"])
    team_profiles = _load_team_profiles(user["sub"])

    full_system = system_prompt
    if user_profile:
        full_system += f"\n\n## Who You're Talking To\n{user_profile}"
    if hypatia_notes:
        full_system += f"\n\n## Your Notes About This Person\n{hypatia_notes}"
    if team_profiles:
        full_system += f"\n\n{team_profiles}"
    if kb_context:
        full_system += f"\n\n## Relevant Knowledge Base Content\n{kb_context}"

    # Font expression
    if body.font_expression_enabled:
        fonts = [f for f in settings.get("hypatia_fonts", []) if not f.get("is_default")]
        default_font = next((f for f in settings.get("hypatia_fonts", []) if f.get("is_default")), None)
        if fonts:
            font_lines = "\n".join(f"- FONT:{f['name']} → {f.get('vibe','')}" for f in fonts)
            default_name = default_font["name"] if default_font else "your current font"
            full_system += f"\n\nFont expression: You express emotional tone through font selection. On your FIRST response, always choose a font and prefix with FONT:FontName on the very first line. After that, only prefix again when the conversational vibe genuinely shifts — hold a font through a mood or topic arc. Do not prefix if keeping the current font. Use exact font names only. Available fonts:\n{font_lines}\nDefault/neutral: {default_name}"

    # Image generation — must be injected into full_system BEFORE messages is constructed
    image_gen_cfg = settings.get("image_gen", {})
    tools = [GENERATE_IMAGE_TOOL] if image_gen_cfg.get("enabled") else []

    # Detect image intent in the latest user message so we can force the tool call
    _IMAGE_KEYWORDS = (
        "draw", "sketch", "illustrate", "illustration", "paint", "render",
        "generate an image", "generate a image", "create an image", "create a image",
        "make an image", "make a image", "generate a picture", "create a picture",
        "visualize", "visualise", "diagram", "picture of", "image of", "photo of",
        "show me", "can you draw", "can you create", "can you generate", "can you make",
    )
    _last_user = next(
        (m.content.lower() for m in reversed(body.messages) if m.role == "user" and m.content), ""
    )
    _force_image = tools and any(kw in _last_user for kw in _IMAGE_KEYWORDS)

    if tools:
        full_system += (
            "\n\n## Image Generation — CRITICAL\n"
            "You have a FULLY FUNCTIONAL image generation tool connected to a local Flux 1 Dev model. "
            "When any user asks you to create, draw, generate, illustrate, or visualize an image, "
            "you MUST call the generate_image tool immediately. "
            "Do NOT write prompts for the user to copy elsewhere. Do NOT say you cannot generate images. "
            "Do NOT suggest third-party tools like DALL-E or Midjourney. You can generate images right now.\n\n"
            "When you call the tool, write the prompt yourself using Flux 1 Dev best practices: "
            "use plain descriptive natural language (not keyword lists); describe subject, style, lighting, "
            "composition, and mood in full sentences or dense phrases; style references work well "
            "(e.g. 'in the style of a 1970s science fiction paperback cover'); "
            "avoid negative prompts — Flux ignores them; keep prompts under ~200 words."
        )

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
            base = _api_base(model["api_endpoint"])
            headers = _build_headers(model["api_endpoint"], model.get("api_token", ""))
            req = {
                "model": model["model_name"],
                "messages": messages,
                "max_tokens": 1024,
                "temperature": 0.4,
                "stream": False,
            }
            if tools:
                req["tools"] = tools
                req["tool_choice"] = (
                    {"type": "function", "function": {"name": "generate_image"}}
                    if _force_image else "auto"
                )
            try:
                resp = await client.post(f"{base}/v1/chat/completions", headers=headers, json=req)
                resp.raise_for_status()
                data = resp.json()
                choice = data["choices"][0]

                image_url = None
                if choice.get("finish_reason") == "tool_calls" and choice["message"].get("tool_calls"):
                    tool_msgs = []
                    for tc in choice["message"]["tool_calls"]:
                        fn = tc.get("function", {})
                        if fn.get("name") == "generate_image":
                            try:
                                args = json.loads(fn.get("arguments", "{}"))
                                result = await _generate_image(args.get("prompt", ""), image_gen_cfg)
                                image_url = result.get("url")
                                tc_content = "Image generated successfully." if image_url else f"Image generation failed: {result.get('error', 'unknown')}"
                            except Exception as te:
                                tc_content = f"Image generation error: {te}"
                        else:
                            tc_content = "Unknown tool."
                        tool_msgs.append({
                            "role": "tool",
                            "tool_call_id": tc.get("id", ""),
                            "content": tc_content,
                        })
                    # If the image was generated successfully, no text reply needed
                    reply = "" if image_url else "I tried to generate the image but something went wrong."
                else:
                    reply = _extract_content(data)

                return {"reply": reply, "image_url": image_url, "model_used": model.get("label", model["model_name"])}
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


class FontConfig(BaseModel):
    id: Optional[str] = None
    name: str
    url: str
    vibe: str = ""
    is_default: bool = False

class FontsBody(BaseModel):
    fonts: List[FontConfig]


@router.put("/avatar", dependencies=[Depends(require_role("superadmin"))])
def set_avatar(body: AvatarBody):
    settings = _load_settings()
    settings["hypatia_avatars"] = body.avatars
    _save_settings(settings)
    return {"ok": True}


@router.get("/fonts", dependencies=[Depends(get_current_user)])
def get_fonts():
    """Returns configured font palette (any logged-in user — needed for preloading)."""
    settings = _load_settings()
    return {"fonts": settings.get("hypatia_fonts", [])}


@router.put("/fonts", dependencies=[Depends(require_role("superadmin"))])
def save_fonts(body: FontsBody):
    settings = _load_settings()
    fonts = []
    for f in body.fonts:
        d = f.dict()
        if not d.get("id"):
            d["id"] = str(uuid.uuid4())
        fonts.append(d)
    settings["hypatia_fonts"] = fonts
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


# ── Multi-section prompt stack ──────────────────────────────────────────────

class PromptSection(BaseModel):
    id: str
    label: str
    description: str = ""
    enabled: bool = True
    content: str = ""

class PromptsBody(BaseModel):
    prompts: List[PromptSection]


@router.get("/prompts", dependencies=[Depends(require_role("superadmin"))])
def get_prompts():
    settings = _load_settings()
    stored = settings.get("hypatia_prompts", None)
    if stored is None:
        return {"prompts": _default_prompts()}
    # Merge stored into defaults so any new default sections appear for new installs
    defaults = {p["id"]: p for p in _default_prompts()}
    merged = []
    seen = set()
    for p in stored:
        merged.append(p)
        seen.add(p["id"])
    for p in _default_prompts():
        if p["id"] not in seen:
            merged.append(p)
    return {"prompts": merged}


@router.put("/prompts", dependencies=[Depends(require_role("superadmin"))])
def save_prompts(body: PromptsBody):
    settings = _load_settings()
    settings["hypatia_prompts"] = [p.dict() for p in body.prompts]
    _save_settings(settings)
    return {"ok": True}


# ── Memory configuration ───────────────────────────────────────────────────

def _default_memory_settings() -> dict:
    return {
        "user_profiles": False,
        "user_expertise": False,
        "user_history": False,
        "sessions_enabled": False,
        "retention_days": 30,
        "consolidation": "disabled",
        "max_tokens": 800,
        "inject_profile": False,
        "inject_sessions": False,
        "inject_index": False,
    }


@router.get("/memory-settings", dependencies=[Depends(require_role("superadmin"))])
def get_memory_settings():
    settings = _load_settings()
    stored = settings.get("hypatia_memory", {})
    return {**_default_memory_settings(), **stored}


class MemorySettingsBody(BaseModel):
    user_profiles: bool = False
    user_expertise: bool = False
    user_history: bool = False
    sessions_enabled: bool = False
    retention_days: int = 30
    consolidation: str = "disabled"
    max_tokens: int = 800
    inject_profile: bool = False
    inject_sessions: bool = False
    inject_index: bool = False


@router.put("/memory-settings", dependencies=[Depends(require_role("superadmin"))])
def save_memory_settings(body: MemorySettingsBody):
    settings = _load_settings()
    settings["hypatia_memory"] = body.dict()
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


class ImageGenConfig(BaseModel):
    enabled: bool = True
    api_endpoint: str = "http://100.74.90.66:6501"
    checkpoint: str = ""
    vae: str = ""
    clip_l: str = ""
    t5xxl: str = ""
    sampler: str = "Euler"
    scheduler: str = "Beta"
    steps: int = 20
    width: int = 512
    height: int = 512
    cfg_scale: float = 1.0
    distilled_cfg_scale: float = 3.0
    prompt_suffix: str = ""


@router.get("/image-gen", dependencies=[Depends(require_role("superadmin"))])
def get_image_gen_config():
    return _load_settings().get("image_gen", {})


@router.put("/image-gen", dependencies=[Depends(require_role("superadmin"))])
def save_image_gen_config(body: ImageGenConfig):
    settings = _load_settings()
    settings["image_gen"] = body.dict()
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


def _extract_content(data: dict) -> str:
    """Extract text from a chat completion response.
    Handles reasoning models that return content=null and put the answer in
    reasoning_content (OpenAI o-series) or a similar field."""
    msg = data["choices"][0]["message"]
    text = msg.get("content") or ""
    if not text:
        text = msg.get("reasoning_content") or ""
    return text.strip()


def _build_headers(api_endpoint: str, api_token: str) -> dict:
    """Build request headers for an LLM call, handling provider quirks."""
    token = (api_token or "").strip()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if "openrouter.ai" in api_endpoint:
        headers["HTTP-Referer"] = "https://intra.synapse6.net"
        headers["X-Title"] = "Synapse6 Wiki"
    return headers


GENERATE_IMAGE_TOOL = {
    "type": "function",
    "function": {
        "name": "generate_image",
        "description": (
            "Generate an image using Flux. Call this when the user asks you to create, draw, generate, "
            "illustrate, or visualize something. You MUST write the prompt yourself — do not pass the "
            "user's words verbatim. Craft a detailed, descriptive Flux-style prompt: describe the subject "
            "clearly, include style (e.g. photorealistic, illustration, sketch, isometric), lighting, "
            "composition, color palette, and any relevant mood or atmosphere. Be specific and vivid."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "A detailed, Flux-optimized image generation prompt written by you — not the user's raw request",
                }
            },
            "required": ["prompt"],
        },
    },
}


async def _generate_image(prompt: str, cfg: dict) -> dict:
    """Call ForgeNeo txt2img, upload result to MinIO, return {url} or {error}."""
    import base64, io as _io
    endpoint = cfg.get("api_endpoint", "http://100.74.90.66:6501").rstrip("/")
    suffix = cfg.get("prompt_suffix", "").strip()
    full_prompt = f"{prompt}, {suffix}" if suffix else prompt
    payload = {
        "prompt": full_prompt,
        "negative_prompt": "",
        "sampler_name": cfg.get("sampler", "Euler"),
        "scheduler": cfg.get("scheduler", "Beta"),
        "steps": int(cfg.get("steps", 20)),
        "width": int(cfg.get("width", 512)),
        "height": int(cfg.get("height", 512)),
        "cfg_scale": float(cfg.get("cfg_scale", 1.0)),
        "distilled_cfg_scale": float(cfg.get("distilled_cfg_scale", 3.0)),
        "override_settings": {
            "sd_model_checkpoint": cfg.get("checkpoint", ""),
        },
        "save_images": False,
        "send_images": True,
    }
    # Forge Neo loads VAE + text encoders as ordered modules (ae first, then clip_l, t5xxl)
    additional = [m for m in [cfg.get("vae", ""), cfg.get("clip_l", ""), cfg.get("t5xxl", "")] if m]
    if additional:
        payload["override_settings"]["forge_additional_modules"] = additional

    try:
        async with httpx.AsyncClient(timeout=300) as img_client:  # 5 min: covers cold model load
            resp = await img_client.post(f"{endpoint}/sdapi/v1/txt2img", json=payload)
            resp.raise_for_status()
        img_b64 = resp.json()["images"][0]
        img_bytes = base64.b64decode(img_b64)
    except Exception as e:
        return {"error": str(e)}

    # Try MinIO upload
    try:
        from minio import Minio
        _ep  = os.environ.get("MINIO_ENDPOINT", "")
        _ak  = os.environ.get("MINIO_ACCESS_KEY", "")
        _sk  = os.environ.get("MINIO_SECRET_KEY", "")
        _bkt = os.environ.get("MINIO_BUCKET", "synapse6-wiki")
        _pub = os.environ.get("MINIO_PUBLIC_URL", "")
        if _ep and _ak:
            mc = Minio(_ep, access_key=_ak, secret_key=_sk, secure=True)
            obj = f"hypatia-images/{uuid.uuid4().hex}.png"
            mc.put_object(_bkt, obj, _io.BytesIO(img_bytes), length=len(img_bytes), content_type="image/png")
            return {"url": f"{_pub}/{obj}"}
    except Exception:
        pass

    # Fallback: data URI (not persisted across sessions but works immediately)
    return {"url": f"data:image/png;base64,{img_b64}"}


def _api_base(endpoint: str) -> str:
    """Normalize an API endpoint: strip trailing slash and any trailing /v1 so
    callers can always safely append /v1/chat/completions etc."""
    base = endpoint.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    return base


@router.post("/test-model", dependencies=[Depends(require_role("superadmin"))])
async def test_model(body: TestModelBody):
    """Send a minimal chat completion to verify the model is reachable."""
    base = _api_base(body.api_endpoint)
    headers = _build_headers(body.api_endpoint, body.api_token)
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
                reply = _extract_content(data)
                return {"ok": True, "reply": reply or "OK (connected)"}
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
        base = _api_base(body.api_endpoint)
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


# ── End-of-session reflection ─────────────────────────────────────────────────

class ReflectMessage(BaseModel):
    role: str
    content: str

class ReflectBody(BaseModel):
    messages: List[ReflectMessage]


_REFLECT_PROMPT = """\
You are Hypatia, the knowledge partner for Synapse6. A conversation with {display_name} has just ended.

Your job is to produce two things:

1. UPDATED TOPIC NOTES about this person (from your perspective, injected into future conversations).
2. A CONVERSATION SUMMARY for the memory index (one searchable paragraph).

--- WHAT YOU ALREADY KNOW (their self-profile) ---
{user_profile}

--- YOUR EXISTING TOPIC NOTES (update each section; keep what's still true, replace what changed) ---
{existing_notes}

--- THEIR RECENT WIKI ACTIVITY ---
{recent_activity}

--- THE CONVERSATION THAT JUST ENDED ---
{conversation}

Respond in this EXACT format (keep all four markers, even if a section has no update):

WORKING_ON:
<max 120 words — active projects, tasks they're driving right now, immediate goals>

PREFERENCES:
<max 80 words — communication style, how they like to interact with you, recurring patterns>

CONTEXT:
<max 120 words — ongoing threads, people mentioned, decisions in flight, things to remember across sessions>

SUMMARY:
<1-2 sentences — neutral past-tense summary of what this conversation was about, suitable for future semantic search>

Rules:
- Write in third person using "{display_name}".
- Do NOT repeat what's in their self-profile unless something changed.
- Do NOT invent details not in the conversation or activity.
- If a section truly has nothing new, write: (no change)
- No preamble, no commentary outside the four sections."""


def _parse_reflect_response(text: str) -> tuple[dict, str]:
    """Parse structured reflect response into (topic_notes_dict, summary_str)."""
    import re
    topics = {}
    for key in ["WORKING_ON", "PREFERENCES", "CONTEXT"]:
        m = re.search(rf"{key}:\n(.*?)(?=\n[A-Z_]+:|$)", text, re.DOTALL)
        val = m.group(1).strip() if m else ""
        if val and val != "(no change)":
            topics[key.lower()] = val
        else:
            topics[key.lower()] = ""
    m = re.search(r"SUMMARY:\n(.*?)(?=\n[A-Z_]+:|$)", text, re.DOTALL)
    summary = m.group(1).strip() if m else ""
    return topics, summary


@router.post("/reflect")
async def reflect(body: ReflectBody, user=Depends(get_current_user)):
    """End-of-session: update topic notes + write conversation summary to memory Qdrant."""
    user_turns = [m for m in body.messages if m.role == "user"]
    if len(user_turns) < 2:
        return {"ok": True, "skipped": True}

    settings = _load_settings()
    username = user["sub"]
    display_name = user.get("display_name") or username

    user_profile = _load_user_profile(username)
    existing_notes = _load_hypatia_notes(username)
    recent_pages = _get_recent_user_activity(username, limit=8)

    if recent_pages:
        activity_lines = []
        for p in recent_pages:
            line = f"- **{p['title']}** ({p['last_indexed_at'][:10] if p['last_indexed_at'] else 'unknown date'})"
            if p.get("summary"):
                line += f": {p['summary'][:120]}"
            activity_lines.append(line)
        recent_activity = "\n".join(activity_lines)
    else:
        recent_activity = "No recent wiki pages found."

    conv_lines = []
    for m in body.messages:
        prefix = "You" if m.role == "assistant" else display_name
        conv_lines.append(f"{prefix}: {m.content}")
    conversation = "\n".join(conv_lines)[-6000:]

    prompt = _REFLECT_PROMPT.format(
        display_name=display_name,
        user_profile=user_profile or "No self-profile set yet.",
        existing_notes=existing_notes or "None yet.",
        recent_activity=recent_activity,
        conversation=conversation,
    )

    llm_models = [m for m in settings.get("llm_models", []) if m.get("enabled") and m.get("type", "llm") == "llm"]
    llm_models.sort(key=lambda m: m.get("order", 0))
    if not llm_models:
        llm_models = [{"api_endpoint": LLM_BASE, "api_token": "", "model_name": LLM_MODEL}]
    lm = llm_models[0]

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{_api_base(lm['api_endpoint'])}/v1/chat/completions",
                headers=_build_headers(lm["api_endpoint"], lm.get("api_token", "")),
                json={
                    "model": lm.get("model_name", LLM_MODEL),
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 700,
                    "temperature": 0.3,
                },
            )
        resp.raise_for_status()
        result = _extract_content(resp.json())

        if not result:
            return {"ok": True, "skipped": True}

        topic_notes, summary = _parse_reflect_response(result)

        # Write topic note files (preserves existing content for unchanged sections)
        existing_by_topic = {}
        for topic in _NOTE_TOPICS:
            p = _hypatia_notes_path(username, topic)
            if os.path.exists(p):
                try:
                    existing_by_topic[topic] = open(p).read().strip()
                except Exception:
                    existing_by_topic[topic] = ""
        merged = {t: topic_notes.get(t) or existing_by_topic.get(t, "") for t in _NOTE_TOPICS}
        _save_hypatia_notes(username, merged)

        # Write conversation summary to user-scoped Qdrant memory collection
        if summary:
            try:
                from lib.pipeline import embed, qdrant_mem_upsert, qdrant_mem_ensure_collection
                from datetime import datetime, timezone
                await qdrant_mem_ensure_collection()
                vectors = await embed([summary[:2000]], settings)
                await qdrant_mem_upsert([{
                    "id": str(uuid.uuid4()),
                    "vector": vectors[0],
                    "payload": {
                        "type": "conversation_memory",
                        "username": username,
                        "date": datetime.now(timezone.utc).isoformat(),
                        "summary": summary,
                    },
                }])
            except Exception:
                pass  # Non-fatal

        return {"ok": True, "updated": True}
    except Exception as e:
        return {"ok": True, "skipped": True, "error": str(e)}


class HypatiaNotesBody(BaseModel):
    notes: str


@router.get("/me/hypatia-notes")
async def get_hypatia_notes(user=Depends(get_current_user)):
    """Returns Hypatia's notes about the current user (all topics combined)."""
    return {"notes": _load_hypatia_notes(user["sub"])}


@router.put("/me/hypatia-notes")
async def save_hypatia_notes(body: HypatiaNotesBody, user=Depends(get_current_user)):
    """User can edit Hypatia's notes — saves entire text to context topic file."""
    # Store manual edits in the 'context' topic; preserves auto-updated others
    _save_hypatia_notes(user["sub"], {"context": body.notes.strip()})
    return {"ok": True}


@router.delete("/me/hypatia-notes")
async def delete_hypatia_notes(user=Depends(get_current_user)):
    """Clears all Hypatia topic notes for the current user."""
    _save_hypatia_notes(user["sub"], {t: "" for t in _NOTE_TOPICS})
    return {"ok": True}


# ── Superadmin: manage any user's notes ──────────────────────────────────────

@router.get("/admin/users/{username}/hypatia-notes", dependencies=[Depends(require_role("superadmin"))])
async def admin_get_user_notes(username: str):
    return {"notes": _load_hypatia_notes(username)}


@router.put("/admin/users/{username}/hypatia-notes", dependencies=[Depends(require_role("superadmin"))])
async def admin_save_user_notes(username: str, body: HypatiaNotesBody):
    _save_hypatia_notes(username, {"context": body.notes.strip()})
    return {"ok": True}


@router.delete("/admin/users/{username}/hypatia-notes", dependencies=[Depends(require_role("superadmin"))])
async def admin_delete_user_notes(username: str):
    _save_hypatia_notes(username, {t: "" for t in _NOTE_TOPICS})
    return {"ok": True}


# ── Memory dump endpoints ──────────────────────────────────────────────────

@router.get("/me/memories")
async def list_my_memories(user=Depends(get_current_user)):
    """List all conversation memory entries for the current user."""
    try:
        from lib.pipeline import qdrant_mem_list
        points = await qdrant_mem_list(user["sub"])
        return {"memories": [
            {"id": p["id"], "date": p["payload"].get("date", "")[:10], "summary": p["payload"].get("summary", "")}
            for p in points
        ]}
    except Exception:
        return {"memories": []}


@router.delete("/me/memories/{point_id}")
async def delete_my_memory(point_id: str, user=Depends(get_current_user)):
    """Delete a single conversation memory. Ownership verified server-side."""
    from lib.pipeline import qdrant_mem_delete
    try:
        await qdrant_mem_delete(point_id, user["sub"])
        return {"ok": True}
    except ValueError:
        from fastapi import HTTPException
        raise HTTPException(404, "Not found or access denied")


@router.get("/admin/users/{username}/memories", dependencies=[Depends(require_role("superadmin"))])
async def admin_list_memories(username: str):
    """Superadmin: list all conversation memories for any user."""
    try:
        from lib.pipeline import qdrant_mem_list
        points = await qdrant_mem_list(username)
        return {"memories": [
            {"id": p["id"], "date": p["payload"].get("date", "")[:10], "summary": p["payload"].get("summary", "")}
            for p in points
        ]}
    except Exception:
        return {"memories": []}


@router.delete("/admin/users/{username}/memories/{point_id}", dependencies=[Depends(require_role("superadmin"))])
async def admin_delete_memory(username: str, point_id: str):
    """Superadmin: delete a specific memory entry for any user."""
    from lib.pipeline import qdrant_mem_delete
    try:
        await qdrant_mem_delete(point_id, username)
        return {"ok": True}
    except ValueError:
        from fastapi import HTTPException
        raise HTTPException(404, "Not found or access denied")
