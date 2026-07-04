"""
Auphonic API client — optional mastering upgrade.

Activated automatically when AUPHONIC_API_KEY is set in .env.
Free tier: 2 hours of processed audio per month.
Docs: https://auphonic.com/help/api/
"""

from __future__ import annotations
import os
import time
from pathlib import Path

import httpx

API_BASE = "https://auphonic.com/api"
POLL_INTERVAL_SEC = 10
TIMEOUT_SEC = 1800  # 30 min max wait


def auphonic_master(in_file: Path, out_file: Path) -> Path:
    """
    Upload -> process with Auphonic defaults (leveler, denoise, loudnorm -16 LUFS)
    -> poll until done -> download result.
    """
    api_key = os.environ["AUPHONIC_API_KEY"]
    headers = {"Authorization": f"bearer {api_key}"}

    # 1. Create + start production via Simple API (single multipart request)
    with open(in_file, "rb") as f:
        resp = httpx.post(
            f"{API_BASE}/simple/productions.json",
            headers=headers,
            data={
                "title": f"rocketride-podcasts {in_file.stem}",
                "loudnesstarget": os.getenv("LOUDNESS_TARGET_LUFS", "-16"),
                "denoise": "true",
                "leveler": "true",
                "normloudness": "true",
                "output_files": "mp3",
                "action": "start",
            },
            files={"input_file": f},
            timeout=300,
        )
    resp.raise_for_status()
    uuid = resp.json()["data"]["uuid"]

    # 2. Poll for completion (status 3 = done, per Auphonic docs)
    deadline = time.time() + TIMEOUT_SEC
    while time.time() < deadline:
        status = httpx.get(
            f"{API_BASE}/production/{uuid}.json", headers=headers, timeout=60
        ).json()["data"]
        if status["status"] == 3:
            break
        if status["status"] in (2, 9, 11, 13):  # error states
            raise RuntimeError(f"Auphonic failed: {status.get('status_string')}")
        time.sleep(POLL_INTERVAL_SEC)
    else:
        raise TimeoutError("Auphonic processing timed out")

    # 3. Download first output file
    output_files = status["output_files"]
    if not output_files:
        raise RuntimeError("Auphonic returned no output files")
    dl_url = output_files[0]["download_url"]

    out_file.parent.mkdir(parents=True, exist_ok=True)
    with httpx.stream("GET", dl_url, headers=headers, timeout=600) as r:
        r.raise_for_status()
        with open(out_file, "wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)

    return out_file
