"""
PathoDB API — Database
SQLAlchemy engine, session factory, and dependency.
"""
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from .config import get_settings

settings = get_settings()

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,       # Detect stale connections before using them
    pool_size=5,              # Small pool — we have a few users
    max_overflow=10,
    pool_recycle=1800,        # Recycle connections every 30 min
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency — yields a DB session and closes it after the request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_db_connection():
    """Called at startup to verify the database is reachable."""
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
