"""
PathoDB API — Main Application
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .config import get_settings
from .database import check_db_connection
from .routers import auth, patients, scans, stains, cohorts

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
    allow_origins=["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routers
app.include_router(auth.router)
app.include_router(patients.router)
app.include_router(scans.router)
app.include_router(stains.router)
app.include_router(cohorts.router)


@app.get("/health")
def health():
    return {"status": "ok", "version": settings.api_version}


# Serve React frontend (production build)
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        index = STATIC_DIR / "index.html"
        if index.exists():
            return FileResponse(index)
        return {"detail": "Frontend not built yet. Run: cd frontend && npm run build"}
