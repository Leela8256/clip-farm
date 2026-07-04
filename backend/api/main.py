"""FastAPI application entry point."""

import os
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import jobs, audio, chat, internal_tools, ws
from db.session import init_db

app = FastAPI(title="rocketride-podcasts", version="0.1.0")


@app.on_event("startup")
def _startup():
    init_db()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:3000")],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(audio.router, prefix="/api", tags=["audio"])
app.include_router(jobs.router, prefix="/api", tags=["jobs"])
app.include_router(chat.router, prefix="/api", tags=["chat"])
app.include_router(internal_tools.router, prefix="/api", tags=["internal"])
app.include_router(ws.router, tags=["websocket"])


@app.get("/api/health")
def health():
    return {"status": "ok"}
