"""
Command-line driver for the podcast pipelines — does exactly what the browser
UI does (upload + project.json, then chat questions against the pipes), which
makes it the quickest way to test the nodes without the frontend.

  python tools/podcast_run.py analyze <video> <episode_id> [goal] [clip_count]
  python tools/podcast_run.py preview <episode_id> <clip_id> [start_ms end_ms]
  python tools/podcast_run.py export  <episode_id> <clip_id>
  python tools/podcast_run.py status  <episode_id>
  python tools/podcast_run.py get     <store path> <local path>
  python tools/podcast_run.py ls      <store dir>

Needs the `rocketride` SDK (pip install rocketride) and a running engine
(ROCKETRIDE_URI / ROCKETRIDE_APIKEY, defaults http://127.0.0.1:5567 / MYAPIKEY).
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from rocketride import RocketRideClient, Question

REPO = Path(__file__).resolve().parents[1]
PIPES = {
    "analyze": str(REPO / ".rocketride" / "episode-analysis.pipe"),
    "preview": str(REPO / ".rocketride" / "clip-preview.pipe"),
    "export": str(REPO / ".rocketride" / "clip-export.pipe"),
}
URI = os.environ.get("ROCKETRIDE_URI", "http://127.0.0.1:5567")
KEY = os.environ.get("ROCKETRIDE_APIKEY", "MYAPIKEY")


async def put_file(client, rel, local):
    handle = (await client.fs_open(rel, "w"))["handle"]
    with open(local, "rb") as f:
        while True:
            chunk = f.read(4 * 1024 * 1024)
            if not chunk:
                break
            await client.fs_write(handle, chunk)
    await client.fs_close(handle, "w")


async def get_file(client, rel, local):
    opened = await client.fs_open(rel, "r")
    handle, offset = opened["handle"], 0
    with open(local, "wb") as out:
        while True:
            chunk = await client.fs_read(handle, offset, 4 * 1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            offset += len(chunk)
    await client.fs_close(handle, "r")
    return offset


async def present(client, path):
    try:
        info = await client.fs_stat(path)
    except Exception:
        return False
    return isinstance(info, dict) and info.get("exists") is True


async def run_chat(client, pipe, context_lines, question_text):
    started = await client.use(filepath=pipe, use_existing=True)
    q = Question()
    q.addContext("\n".join(context_lines))
    q.addQuestion(question_text or "go")

    async def sse(kind, data):
        print(f"  [{time.strftime('%H:%M:%S')}] {kind}: {json.dumps(data, default=str)[:220]}", flush=True)

    t0 = time.time()
    result = await client.chat(token=started["token"], question=q, on_sse=sse)
    print(f"returned in {time.time() - t0:.0f}s")
    return result


def manifest_of(result):
    """The node manifest: the answers lane carries every answer written along the
    path (the LLM's raw answers too), so take the last payload naming the project."""
    if not isinstance(result, dict):
        return result
    items = result.get("answers")
    if not isinstance(items, list) or not items:
        return result
    parsed = []
    for item in items:
        value = item.get("answer", item) if isinstance(item, dict) and "answer" in item else item
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                pass
        parsed.append(value)
    for value in reversed(parsed):
        if isinstance(value, dict) and value.get("project"):
            return value
    return parsed[-1]


async def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    client = RocketRideClient(uri=URI, auth=KEY)
    await client.connect()
    try:
        if cmd == "analyze":
            video, episode = sys.argv[2], sys.argv[3]
            goal = sys.argv[4] if len(sys.argv) > 4 else "educational"
            count = int(sys.argv[5]) if len(sys.argv) > 5 else 10
            root = f"projects/{episode}"
            source = f"{root}/source/{os.path.basename(video)}"
            if await present(client, source):
                print("source already in store:", source)
            else:
                t0 = time.time()
                await put_file(client, source, video)
                print(f"uploaded {source} in {time.time() - t0:.1f}s")
            await client.fs_write_json(f"{root}/project.json", {
                "episode_id": episode, "source": source, "created": time.time(),
                "title": os.path.splitext(os.path.basename(video))[0],
                "settings": {"goal": goal, "clip_count": count, "min_seconds": 20, "max_seconds": 90},
                "analysis": {"status": "analyzing", "started_at": time.time()},
            })
            answer = manifest_of(await run_chat(client, PIPES["analyze"], [f"project: {root}"], goal))
            if isinstance(answer, dict) and "candidates" in answer:
                print(f"proposed={answer.get('proposed')} parts={answer.get('parts')} kept={len(answer['candidates'])} "
                      f"chapters={len(answer.get('chapters') or [])} in {answer.get('seconds')}s")
                for c in answer["candidates"]:
                    print(f"  {c.get('id')} {c.get('start_ms', 0)/1000:7.1f}-{c.get('end_ms', 0)/1000:7.1f}s "
                          f"score={c.get('score', 0):4.1f} {c.get('scores')}  {c.get('title')!r}")
                    print(f"       hook: {c.get('hook')!r}\n       why:  {(c.get('reason') or '')[:160]!r}")
                for ch in answer.get("chapters") or []:
                    print(f"  chapter {ch.get('id')} {ch.get('start_ms', 0)/1000:7.1f}s {ch.get('title')!r}")
            else:
                print(json.dumps(answer, default=str, indent=1)[:3000])
        elif cmd in ("preview", "export"):
            episode, clip = sys.argv[2], sys.argv[3]
            lines = [f"project: projects/{episode}", f"clip: {clip}"]
            if len(sys.argv) > 5:
                lines += [f"start: {sys.argv[4]}", f"end: {sys.argv[5]}"]
            answer = manifest_of(await run_chat(client, PIPES[cmd], lines, f"{cmd} {clip}"))
            print(json.dumps(answer, default=str, indent=1)[:2500])
        elif cmd == "status":
            episode = sys.argv[2]
            for name in ("project.json", "status.json", "analysis/candidates.json"):
                path = f"projects/{episode}/{name}"
                try:
                    text = json.dumps(await client.fs_read_json(path), default=str, indent=1)
                    print(f"--- {path}\n{text[:1800]}{'...' if len(text) > 1800 else ''}")
                except Exception as exc:
                    print(f"--- {path}: {exc}")
        elif cmd == "get":
            n = await get_file(client, sys.argv[2], sys.argv[3])
            print(f"downloaded {n} bytes -> {sys.argv[3]}")
        elif cmd == "ls":
            print(json.dumps(await client.fs_list_dir(sys.argv[2]), default=str, indent=1)[:3000])
        else:
            print(__doc__)
    finally:
        await client.disconnect()


asyncio.run(main())
