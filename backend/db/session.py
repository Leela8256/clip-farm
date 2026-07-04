"""
Database engine and session helper.

Sync engine/session on purpose: FastAPI routes here are sync `def` (not
async def) and Celery tasks are inherently sync, matching the rest of this
codebase's style rather than mixing in an async driver for no benefit.
"""

from __future__ import annotations
import os
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

from db.models import Base

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql+psycopg://rocketride:rocketride@localhost:5432/rocketride_podcasts"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db() -> None:
    """Create tables if they don't exist. Called once at process startup."""
    Base.metadata.create_all(engine)


@contextmanager
def get_session():
    session: Session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
