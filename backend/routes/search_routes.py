from fastapi import APIRouter, Depends, Query
from auth import require_role
from lib.pipeline import embed, load_settings, qdrant_search

router = APIRouter(prefix="/api/search")


@router.get("")
async def search(
    q: str = Query(..., min_length=2, max_length=500),
    limit: int = Query(default=10, ge=1, le=30),
    user=Depends(require_role("user")),
):
    """Semantic search across wiki pages via Qdrant. Returns deduped results by slug."""
    settings = load_settings()
    try:
        vectors = await embed([q[:2000]], settings)
    except Exception:
        return {"results": []}

    raw = await qdrant_search(
        vectors[0],
        limit=limit * 3,
        must=[{"key": "type", "match": {"value": "wiki_page"}}],
        score_threshold=0.15,
    )

    # Deduplicate — keep the best-scoring chunk per slug
    seen: dict = {}
    for r in raw:
        p = r["payload"]
        slug = p.get("slug", "")
        if not slug:
            continue
        score = r["score"]
        if slug not in seen or score > seen[slug]["score"]:
            content = p.get("content", "")
            heading = p.get("heading", "")
            seen[slug] = {
                "slug": slug,
                "title": p.get("page_title", slug),
                "heading": heading,
                "snippet": content[:220].replace("\n", " ").strip(),
                "score": round(score, 3),
            }

    results = sorted(seen.values(), key=lambda x: -x["score"])[:limit]
    return {"results": results}
