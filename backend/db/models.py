"""
SQLAlchemy models — replaces the flat-file tmp/jobs/{id}/*.json job state.

A Job row holds everything the old filesystem layout stored as separate
JSON files (transcript, edl, result) as JSONB columns, since they're all
1:1 with a job. Chat turns are a real table since they're naturally
append-only and multi-row per job.
"""

from __future__ import annotations
from datetime import datetime, timezone

from sqlalchemy import String, Text, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    mode: Mapped[str] = mapped_column(String(16))  # "autopilot" | "chat"
    audio_path: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    stage: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    transcript: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    edl: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    final_file: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    chat_turns: Mapped[list["ChatTurn"]] = relationship(
        back_populates="job", cascade="all, delete-orphan", order_by="ChatTurn.created_at"
    )


class ChatTurn(Base):
    __tablename__ = "chat_turns"
    __table_args__ = (Index("ix_chat_turns_job_id", "job_id"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(16))  # "user" | "assistant"
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    job: Mapped["Job"] = relationship(back_populates="chat_turns")
