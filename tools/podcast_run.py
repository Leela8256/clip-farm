"""
Command-line driver for the podcast pipelines — does exactly what the browser
UI does (upload + project.json, then chat questions against the pipes), which
makes it the quickest way to test the nodes without the frontend.

  python tools/podcast_run.py analyze <video> <episode_id> [goal] [clip_count]
  python tools/podcast_run.py index   <episode_id>                 build the semantic transcript index
  python tools/podcast_run.py visual  <episode_id>                 visual scan: people on screen + shot changes
  python tools/podcast_run.py search  <episode_id> "<query>" [k]   query the index (stock nodes only)
  python tools/podcast_run.py parse   <episode_id> "<prompt>"      Prompt Director step 1: sentence -> spec
  python tools/podcast_run.py direct  <episode_id> <request_id> [full]   step 2: find + validate clips
  python tools/podcast_run.py revise  <episode_id> <clip_id> "<instruction>"  conversational revision
  python tools/podcast_run.py preview <episode_id> <clip_id> [start_ms end_ms] [key:value ...]   e.g. layout:solo subject:p2 duration:30 mode:strict
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
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / 'tools'))

from local_nodes.podcast_common.spec import describe_spec, duration_window, normalize_spec  # noqa: E402
from local_nodes.podcast_common.clips import fmt_timestamp, sentence_lines  # noqa: E402
import prompts  # noqa: E402

PIPES = {
    "analyze": str(REPO / ".rocketride" / "episode-analysis.pipe"),
    "preview": str(REPO / ".rocketride" / "clip-preview.pipe"),
    "export": str(REPO / ".rocketride" / "clip-export.pipe"),
    "chat": str(REPO / ".rocketride" / "director-chat.pipe"),
    "direct": str(REPO / ".rocketride" / "prompt-director.pipe"),
    "direct-full": str(REPO / ".rocketride" / "prompt-director-full.pipe"),
    "index": str(REPO / ".rocketride" / "transcript-index.pipe"),
    "search": str(REPO / ".rocketride" / "transcript-search.pipe"),
    "visual": str(REPO / ".rocketride" / "visual-scan.pipe"),
    "studio-prepare": str(REPO / ".rocketride" / "podcast-studio-prepare.pipe"),
    "studio-preview": str(REPO / ".rocketride" / "podcast-studio-preview.pipe"),
    "studio-export": str(REPO / ".rocketride" / "podcast-studio-export.pipe"),
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


async def read_json_or(client, path, default=None):
    try:
        return await client.fs_read_json(path)
    except Exception:
        return default


async def run_question(client, pipe, question, label=""):
    started = await client.use(filepath=pipe, use_existing=True)

    async def sse(kind, data):
        print(f"  [{time.strftime('%H:%M:%S')}] {kind}: {json.dumps(data, default=str)[:220]}", flush=True)

    t0 = time.time()
    result = await client.chat(token=started["token"], question=question, on_sse=sse)
    print(f"{label or os.path.basename(pipe)} returned in {time.time() - t0:.0f}s")
    return result


async def run_chat(client, pipe, context_lines, question_text):
    q = Question()
    q.addContext("\n".join(context_lines))
    q.addQuestion(question_text or "go")
    return await run_question(client, pipe, q)


def all_payloads(result):
    """Every parsed answer payload from the answers lane, in order."""
    items = (result or {}).get("answers") if isinstance(result, dict) else None
    out = []
    for item in items or []:
        value = item.get("answer", item) if isinstance(item, dict) and "answer" in item else item
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                pass
        out.append(value)
    return out


async def refine_analysis_client(client, root, episode, result, goal, count):
    """The pipes no longer carry podcast_refine — the caller refines, like the browser."""
    from local_nodes.podcast_common.refine import refine_analysis
    transcript = await read_json_or(client, f"{root}/analysis/transcript.json", {}) or {}
    project = await read_json_or(client, f"{root}/project.json", {}) or {}
    sentences = transcript.get("sentences") or []
    duration_ms = int((project.get("media") or {}).get("duration_ms") or transcript.get("duration_ms") or 0)
    settings = project.get("settings") or {}
    payloads = all_payloads(result)
    doc, chapters_doc, summary = refine_analysis(
        payloads, sentences=sentences, duration_ms=duration_ms, episode_id=episode,
        goal=goal, want=int(settings.get("clip_count") or count),
        min_ms=int(settings.get("min_seconds") or 20) * 1000,
        max_ms=int(settings.get("max_seconds") or 90) * 1000)
    await client.fs_write_json(f"{root}/analysis/llm-answers.json",
                               {"schema_version": 1, "generated": time.time(), "answers": payloads})
    await client.fs_write_json(f"{root}/analysis/candidates.json", doc)
    await client.fs_write_json(f"{root}/analysis/chapters.json", chapters_doc)
    project["analysis"] = {"status": "analyzed", "candidates": len(summary["candidates"]),
                           "proposed": summary["proposed"], "chapters": len(summary["chapters"]),
                           "sentences": len(sentences), "parts": summary["parts"], "analyzed_at": time.time()}
    await client.fs_write_json(f"{root}/project.json", project)
    return {"project": root, "episode_id": episode, "goal": goal, **summary}


async def refine_direct_client(client, root, request_id, result):
    from local_nodes.podcast_common.refine import refine_direct
    transcript = await read_json_or(client, f"{root}/analysis/transcript.json", {}) or {}
    project = await read_json_or(client, f"{root}/project.json", {}) or {}
    request = await read_json_or(client, f"{root}/analysis/requests/{request_id}.json", {}) or {}
    sentences = transcript.get("sentences") or []
    duration_ms = int((project.get("media") or {}).get("duration_ms") or transcript.get("duration_ms") or 0)
    update, summary = refine_direct(all_payloads(result), request=request, request_id=request_id,
                                    sentences=sentences, duration_ms=duration_ms)
    request.update(update)
    request["seconds"] = 0
    await client.fs_write_json(f"{root}/analysis/requests/{request_id}.json", request)
    requests = project.setdefault("requests", {})
    requests[request_id] = {"prompt": request.get("prompt"), "summary": update["summary"],
                            "delivered": len(update["candidates"]),
                            "requested": update["compliance"]["requested"], "answered_at": update["answered_at"]}
    await client.fs_write_json(f"{root}/project.json", project)
    return {"project": root, "request_id": request_id, **summary}


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


def first_json_answer(result):
    """The first JSON answer in a response (parse / revise pipes have one LLM answer)."""
    items = result.get("answers") if isinstance(result, dict) else None
    for item in items or []:
        value = item.get("answer", item) if isinstance(item, dict) and "answer" in item else item
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                continue
        if isinstance(value, dict):
            return value
    return None


def print_candidates(cands):
    for c in cands:
        comp = c.get("compliance") or {}
        flags = " ".join(f"{k}={comp.get(k)}" for k in ("speaker_match", "required_topic_found", "profanity_found", "complete_ending") if k in comp)
        print(f"  {c.get('id')} {fmt_timestamp(c.get('start_ms', 0))}-{fmt_timestamp(c.get('end_ms', 0))} "
              f"({(c.get('end_ms', 0) - c.get('start_ms', 0)) / 1000:.1f}s) score={c.get('score', 0):4.1f} {c.get('scores')} "
              f"speaker={c.get('speaker')!r} {c.get('title')!r}")
        print(f"       hook: {c.get('hook')!r}\n       why:  {(c.get('reason') or '')[:160]!r}")
        if flags:
            print(f"       {flags}")
        for w in comp.get("warnings") or []:
            print(f"       ! {w}")


async def next_request_id(client, root):
    listing = await read_json_or(client, None) if False else None  # placeholder for symmetry with the UI
    del listing
    try:
        entries = (await client.fs_list_dir(f"{root}/analysis/requests")).get("entries") or []
    except Exception:
        entries = []
    numbers = []
    for e in entries:
        name = str(e.get("name") or "")
        if name.startswith("r") and name.endswith(".json") and name[1:-5].isdigit():
            numbers.append(int(name[1:-5]))
    return f"r{(max(numbers) + 1) if numbers else 1:02d}"


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
            ctx_lines = [f"project: {root}", f"source: {source}",
                         f"status_to: {root}/status.json", f"write_to: {root}/analysis/media.json"]
            result = await run_chat(client, PIPES["analyze"], ctx_lines, goal)
            # no pipe carries podcast_refine any more - the caller always refines
            answer = await refine_analysis_client(client, root, episode, result, goal, count)
            if isinstance(answer, dict) and "candidates" in answer:
                print(f"proposed={answer.get('proposed')} parts={answer.get('parts')} kept={len(answer['candidates'])} "
                      f"chapters={len(answer.get('chapters') or [])} in {answer.get('seconds')}s")
                print_candidates(answer["candidates"])
                for ch in answer.get("chapters") or []:
                    print(f"  chapter {ch.get('id')} {ch.get('start_ms', 0)/1000:7.1f}s {ch.get('title')!r}")
            else:
                print(json.dumps(answer, default=str, indent=1)[:3000])

        elif cmd == "index":
            episode = sys.argv[2]
            root = f"projects/{episode}"
            proj = await read_json_or(client, f"{root}/project.json", {}) or {}
            result = await run_chat(client, PIPES["index"], [f"project: {root}", f"source: {proj.get('source')}",
                                                             f"status_to: {root}/status.json"], "index")
            print(json.dumps(result, default=str)[:600])
            index = await read_json_or(client, f"{root}/analysis/index.json", {})
            print(f"index.json: {index.get('passages')} passages of {index.get('window_ms', 0) // 1000}s")

        elif cmd == "visual":
            episode = sys.argv[2]
            root = f"projects/{episode}"
            proj = await read_json_or(client, f"{root}/project.json", {}) or {}
            answer = manifest_of(await run_chat(client, PIPES["visual"], [
                f"project: {root}", f"source: {proj.get('source')}",
                f"status_to: {root}/status.json",
                f"write_to: {root}/analysis/visual", f"thumbnails_to: {root}/analysis/visual",
                "echo.project: " + root, "echo.episode_id: " + episode], "scan"))
            if isinstance(answer, dict) and "people" in answer:
                print(f"people={len(answer['people'])} scenes={answer.get('scenes')} frames={answer.get('frames')} in {answer.get('seconds')}s")
                for p in answer["people"]:
                    print(f"  {p['id']} coverage={p['coverage']:.2f} center={p['center']} face_h={p['face_h']} appearances={p['appearances']} thumb={p.get('thumbnail')}")
            else:
                print(json.dumps(answer, default=str, indent=1)[:2000])

        elif cmd == "search":
            episode, query = sys.argv[2], sys.argv[3]
            k = int(sys.argv[4]) if len(sys.argv) > 4 else 5
            q = Question()
            q.filter.objectIds = [episode]
            q.filter.limit = k
            q.addQuestion(query)
            result = await run_question(client, PIPES["search"], q)
            docs = result.get("documents") if isinstance(result, dict) else None
            for d in docs or []:
                md = d.get("metadata") or {}
                print(f"  score={d.get('score', 0):.3f} passage {md.get('chunkId')} [{fmt_timestamp(md.get('start_ms', 0))} - "
                      f"{fmt_timestamp(md.get('end_ms', 0))}] {(d.get('page_content') or '')[:140]!r}")
            if not docs:
                print("no documents:", json.dumps(result, default=str)[:400])

        elif cmd == "parse":
            episode, prompt = sys.argv[2], sys.argv[3]
            root = f"projects/{episode}"
            result = await run_question(client, PIPES["chat"], prompts.parse_question(prompt), "parse")
            raw = first_json_answer(result) or {}
            spec = normalize_spec(raw)
            request_id = await next_request_id(client, root)
            request = {"schema_version": 1, "request_id": request_id, "prompt": prompt, "raw": raw, "spec": spec,
                       "search_query": str(raw.get("search_query") or " ".join(spec["subjects"]) or prompt)[:200],
                       "created": time.time(), "status": "parsed"}
            await client.fs_write_json(f"{root}/analysis/requests/{request_id}.json", request)
            print(f"request {request_id}: {describe_spec(spec)}")
            print(json.dumps(spec, indent=1))
            for w in spec["warnings"]:
                print("  !", w)

        elif cmd == "direct":
            episode, request_id = sys.argv[2], sys.argv[3]
            full = len(sys.argv) > 4 and sys.argv[4] == "full"
            root = f"projects/{episode}"
            request = await read_json_or(client, f"{root}/analysis/requests/{request_id}.json")
            if not request:
                print("no such request; run parse first")
                return
            project = await read_json_or(client, f"{root}/project.json", {})
            spec = normalize_spec(request.get("spec"))
            window = duration_window(spec)
            indexed = (project.get("index") or {}).get("status") == "indexed"
            transcript_lines = None
            if full or not indexed:
                transcript = await read_json_or(client, f"{root}/analysis/transcript.json", {})
                transcript_lines = sentence_lines(transcript.get("sentences") or [])
                print(f"using the full transcript ({len(transcript_lines)} chars){'' if full else ' — no index'}")
            q = prompts.direct_question(request["prompt"], spec, window, root, request_id, episode,
                                        request.get("search_query") or "", transcript_lines)
            result = await run_question(client, PIPES["direct-full" if transcript_lines else "direct"], q, "direct")
            # no pipe carries podcast_refine any more - the caller always refines
            answer = await refine_direct_client(client, root, request_id, result)
            if isinstance(answer, dict) and "candidates" in answer:
                comp = answer.get("compliance") or {}
                print(f"{answer.get('summary')}\nproposed={answer.get('proposed')} delivered={comp.get('delivered')} "
                      f"rejected={comp.get('rejected')} {comp.get('rejection_reasons')} in {answer.get('seconds')}s")
                print_candidates(answer["candidates"])
                for r in answer.get("rejected") or []:
                    print(f"  x {r.get('title')!r} {fmt_timestamp(r.get('start_ms') or 0)}-{fmt_timestamp(r.get('end_ms') or 0)}: {r.get('rejected_for')}")
                for w in comp.get("warnings") or []:
                    print("  !", w)
            else:
                print(json.dumps(answer, default=str, indent=1)[:3000])

        elif cmd == "revise":
            episode, clip_id, instruction = sys.argv[2], sys.argv[3], sys.argv[4]
            root = f"projects/{episode}"
            plan = await read_json_or(client, f"{root}/analysis/clips/{clip_id}/plan.json") or await read_json_or(client, f"{root}/analysis/clips/{clip_id}.json")
            if not plan:
                print("prepare the clip first (preview) so a plan exists")
                return
            transcript = await read_json_or(client, f"{root}/analysis/transcript.json", {})
            cands = (await read_json_or(client, f"{root}/analysis/candidates.json", {}) or {}).get("candidates") or []
            for name in ((await read_json_or(client, f"{root}/project.json", {}) or {}).get("requests") or {}):
                req = await read_json_or(client, f"{root}/analysis/requests/{name}.json", {}) or {}
                cands += req.get("candidates") or []
            q = prompts.revise_question(instruction, root, clip_id, plan, transcript.get("sentences") or [], cands)
            revision = first_json_answer(await run_question(client, PIPES["chat"], q, "revise")) or {}
            print(json.dumps(revision, indent=1))
            edits = await read_json_or(client, f"{root}/edits/clip-edits.json", {}) or {"schema_version": 2, "clips": {}}
            clips = edits.setdefault("clips", {})
            edit = clips.setdefault(clip_id, {})
            version = prompts.apply_revision(revision, edit, plan)
            if version:
                version["created"] = time.time()
                edit.setdefault("versions", []).append(version)
                edit["active_version"] = version["n"]
                edits["schema_version"] = 2
                await client.fs_write_json(f"{root}/edits/clip-edits.json", edits)
                print(f"saved version {version['n']} for {clip_id}: {version.get('note')}")
            else:
                print(f"action {revision.get('action')!r} needs the client (new request / compilation) or changed nothing")

        elif cmd in ("preview", "export"):
            episode, clip = sys.argv[2], sys.argv[3]
            lines = [f"project: projects/{episode}", f"clip: {clip}"]
            if len(sys.argv) > 5:
                lines += [f"start: {sys.argv[4]}", f"end: {sys.argv[5]}"]
            extra = [a for a in sys.argv[4:] if ":" in a]
            lines += extra
            answer = manifest_of(await run_chat(client, PIPES[cmd], lines, f"{cmd} {clip}"))
            print(json.dumps(answer, default=str, indent=1)[:2500])

        elif cmd == "studio":
            # studio <episode> init|preview|export [range:a-b] [quality:rough|full] [key:value ...]
            episode, action = sys.argv[2], sys.argv[3]
            lines = [f"project: projects/{episode}", f"studio: {action if action != 'preview' else 'preview'}"]
            if action == "init":
                lines[1] = "studio: init"
            lines += [a for a in sys.argv[4:] if ":" in a]
            pipe = {"init": "studio-prepare", "preview": "studio-preview", "export": "studio-export"}[action]
            answer = manifest_of(await run_chat(client, PIPES[pipe], lines, f"studio {action}"))
            print(json.dumps(answer, default=str, indent=1)[:3000])

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
