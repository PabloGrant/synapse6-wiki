import os
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import HTTPException

from routes.auth_routes import router as auth_router
from routes.nav_routes import router as nav_router
from routes.pages_routes import router as pages_router
from routes.comments_routes import router as comments_router
from routes.upload_routes import router as upload_router
from routes.hypatia_routes import router as hypatia_router
from routes.settings_routes import router as settings_router

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

app.include_router(auth_router)
app.include_router(nav_router)
app.include_router(pages_router)
app.include_router(comments_router)
app.include_router(upload_router)
app.include_router(hypatia_router)
app.include_router(settings_router)

STATIC_DIR = os.environ.get("STATIC_DIR", "/app/static")

if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=os.path.join(STATIC_DIR, "static") if os.path.exists(os.path.join(STATIC_DIR, "static")) else STATIC_DIR), name="static")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        index = os.path.join(STATIC_DIR, "index.html")
        return FileResponse(index)
