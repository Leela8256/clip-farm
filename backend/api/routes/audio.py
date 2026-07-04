"""Upload and download endpoints."""

from __future__ import annotations
import os
import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, UploadFile, HTTPException
from fastapi.responses import FileResponse

from workers.tasks import load_state

router = APIRouter()

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "tmp/uploads"))
ALLOWED_EXT = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"}
MAX_SIZE_MB = 500


@router.post("/upload")
async def upload(file: UploadFile):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported format {ext}. Allowed: {sorted(ALLOWED_EXT)}")

    job_id = uuid.uuid4().hex[:12]
    dest_dir = UPLOAD_DIR / job_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"original{ext}"

    size = 0
    async with aiofiles.open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_SIZE_MB * 1024 * 1024:
                raise HTTPException(413, f"File exceeds {MAX_SIZE_MB}MB limit")
            await f.write(chunk)

    return {"job_id": job_id, "audio_path": str(dest), "size_bytes": size}


@router.get("/download/{job_id}")
def download(job_id: str):
    result = load_state(job_id, "result")
    if not result or not Path(result["final_file"]).exists():
        raise HTTPException(404, "Final file not ready for this job")
    return FileResponse(
        result["final_file"],
        media_type="audio/mpeg",
        filename=f"{job_id}_final.mp3",
    )


@router.get("/preview/{job_id}")
def preview_original(job_id: str):
    """Stream the original upload for the waveform player."""
    job_dir = UPLOAD_DIR / job_id
    if not job_dir.exists():
        raise HTTPException(404, "Job not found")
    files = list(job_dir.glob("original.*"))
    if not files:
        raise HTTPException(404, "Original file not found")
    return FileResponse(files[0])
