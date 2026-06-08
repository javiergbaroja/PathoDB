"""
PathoDB API — Main Application
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .config import get_settings
from .database import check_db_connection
from .routers import (
    auth, patients, scans, stains, cohorts, tmas,
    stats, slides, search, assistant, analysis, summarize, projects,
    registration, filesystem,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("pathodb_api")
settings = get_settings()

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("PathoDB API starting...")
    try:
        check_db_connection()
        log.info("Database connection verified.")
    except Exception as e:
        log.error(f"Database connection failed: {e}")
        raise
    yield
    log.info("PathoDB API shutting down.")


app = FastAPI(
    title=settings.api_title,
    version=settings.api_version,
    description="Research database for computational pathology.",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_allow_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api_router = APIRouter(prefix="/api")
api_router.include_router(auth.router)
api_router.include_router(patients.router)
api_router.include_router(scans.router)
api_router.include_router(stains.router)
api_router.include_router(cohorts.router)
api_router.include_router(stats.router)
api_router.include_router(slides.router)
api_router.include_router(search.router)
api_router.include_router(assistant.router)
api_router.include_router(analysis.router)
api_router.include_router(summarize.router)
api_router.include_router(projects.router)
api_router.include_router(tmas.router)  # <-- Include TMA router
api_router.include_router(registration.router)
api_router.include_router(filesystem.router)
app.include_router(api_router)

@api_router.get("/health")
def health():
    return {"status": "ok", "version": settings.api_version}


if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        # Serve real static files (favicons, manifests, etc.) directly
        candidate = STATIC_DIR / full_path
        if candidate.exists() and candidate.is_file():
            return FileResponse(candidate)
        # Fall back to SPA index for all client-side routes
        index = STATIC_DIR / "index.html"
        if index.exists():
            return FileResponse(index)
        return {"detail": "Frontend not built yet."}