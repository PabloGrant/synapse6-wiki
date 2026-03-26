import os
import hashlib
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import HTTPException

from routes.auth_routes import router as auth_router
from routes.nav_routes import router as nav_router
from routes.pages_routes import router as pages_router
from routes.comments_routes import router as comments_router
from routes.upload_routes import router as upload_router
from routes.hypatia_routes import router as hypatia_router
from routes.settings_routes import router as settings_router
from routes.library_routes import router as library_router
from routes.search_routes import router as search_router

app = FastAPI(title="Synapse6 Wiki", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    response = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    if exc.status_code == 401:
        # Kill the stale cookie so the browser doesn't keep sending it
        response.delete_cookie("session", httponly=True, samesite="lax")
    return response

@app.get("/signout", include_in_schema=False)
async def signout():
    """Hard signout — works even with broken JS or stale cookies. Visit directly in browser."""
    response = RedirectResponse(url="/", status_code=302)
    response.delete_cookie("session", httponly=True, samesite="lax")
    return response

app.include_router(auth_router)
app.include_router(nav_router)
app.include_router(pages_router)
app.include_router(comments_router)
app.include_router(upload_router)
app.include_router(hypatia_router)
app.include_router(settings_router)
app.include_router(library_router)
app.include_router(search_router)

STATIC_DIR = os.environ.get("STATIC_DIR", "/app/static")
DATA_VENDOR_DIR = os.path.join(os.environ.get("DATA_DIR", "/data"), "vendor")

def _compute_version(static_dir: str) -> str:
    """Hash the CSS and JS to generate a cache-busting version string."""
    try:
        h = hashlib.md5()
        for rel in ("css/app.css", "js/app.js"):
            p = os.path.join(static_dir, rel)
            if os.path.exists(p):
                h.update(open(p, "rb").read())
        return h.hexdigest()[:10]
    except Exception:
        return "dev"

if os.path.exists(DATA_VENDOR_DIR):
    app.mount("/vendor", StaticFiles(directory=DATA_VENDOR_DIR), name="vendor")

if os.path.exists(STATIC_DIR):
    _static_root = os.path.join(STATIC_DIR, "static") if os.path.exists(os.path.join(STATIC_DIR, "static")) else STATIC_DIR
    app.mount("/static", StaticFiles(directory=_static_root), name="static")
    _APP_VERSION = _compute_version(_static_root)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        index = os.path.join(STATIC_DIR, "index.html")
        html = open(index).read()
        html = html.replace('app.css"', f'app.css?v={_APP_VERSION}"')
        html = html.replace('app.js"', f'app.js?v={_APP_VERSION}"')
        return HTMLResponse(html)
