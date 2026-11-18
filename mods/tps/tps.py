"""Tokens per second of the agent a process runs, from its session log. Prints one JSON line.

Usage: python3 -I tps.py claude|codex <pid>
Output: {"model", "last": {"tokens", "secs"}, "recent": {"tokens", "secs", "n"}, "end", "busy"}
Exit 1: no session found or nothing measured yet.

A response's time runs from the input it answers (the prompt or a tool's result) to its
last record, so it includes the wait for the first token. Only numbers leave this script.
"""
import glob
import json
import os
import re
import subprocess
import sys
from datetime import datetime

TAIL = 4 << 20  # bytes read from the end of a log
RECENT = 10     # responses in the recent average
ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def records(path):
    with open(path, "rb") as f:
        size = f.seek(0, 2)
        f.seek(max(0, size - TAIL))
        data = f.read()
    lines = data.split(b"\n")
    if size > TAIL:
        lines = lines[1:]  # cut mid-line
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue  # includes a last line still being written
        if isinstance(r, dict):
            yield r


def run(*args):
    try:
        return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3,
                              env={**os.environ, "LC_ALL": "C"}).stdout.decode(errors="replace")
    except (OSError, subprocess.TimeoutExpired):
        return ""


def open_files(pid):
    if os.path.isdir(f"/proc/{pid}/fd"):
        out = []
        for fd in glob.glob(f"/proc/{pid}/fd/*"):
            try:
                out.append(os.readlink(fd))
            except OSError:
                pass
        return out
    return [l[1:] for l in run("lsof", "-nP", "-Fn", "-p", pid).splitlines() if l.startswith("n/")]


def proc_cwd(pid):
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return next((l[1:] for l in run("lsof", "-a", "-d", "cwd", "-p", pid, "-Fn").splitlines() if l.startswith("n/")), "")


def proc_start(pid):
    e = run("ps", "-o", "etime=", "-p", pid).strip()
    if not e:
        return None
    d, _, e = e.rpartition("-")
    s = 0
    for p in e.split(":"):
        s = s * 60 + int(p)
    return datetime.now().timestamp() - (int(d or 0) * 86400 + s)


# ---- Claude Code: ~/.claude/sessions/<pid>.json names the session, its log is projects/*/<id>.jsonl.

def claude_log(pid):
    dirs = [os.environ["CLAUDE_CONFIG_DIR"]] if os.environ.get("CLAUDE_CONFIG_DIR") else []
    dirs += glob.glob(os.path.expanduser("~/.claude*"))
    for d in dirs:
        try:
            with open(os.path.join(d, "sessions", f"{pid}.json")) as f:
                sid = json.load(f).get("sessionId", "")
        except (OSError, ValueError):
            continue
        if ID.fullmatch(sid or ""):
            hits = glob.glob(os.path.join(d, "projects", "*", f"{sid}.jsonl"))
            if hits:
                return hits[0]
    return None


def claude_responses(path):
    responses, order, model = {}, [], None
    asked = None  # time of the last prompt or tool result in the main thread
    for r in records(path):
        if r.get("isSidechain"):
            continue
        kind, t = r.get("type"), ts(r.get("timestamp"))
        if kind == "user" and t:
            asked = t
        elif kind == "assistant" and t:
            m = r.get("message") or {}
            mid, usage = m.get("id"), m.get("usage") or {}
            if not mid or m.get("model") == "<synthetic>":
                continue
            model = m.get("model") or model
            x = responses.get(mid)
            if x is None:
                if asked is None:
                    continue
                x = responses[mid] = {"start": asked, "end": t, "tokens": 0}
                order.append(mid)
            x["end"] = max(x["end"], t)
            x["tokens"] = max(x["tokens"], usage.get("output_tokens") or 0)
    busy = asked is not None and (not order or asked > responses[order[-1]]["end"])
    return [responses[i] for i in order], model, busy


# ---- Codex: the rollout log the process holds open (or its thread lock), else the newest
# rollout started in the process's folder since the process started.

def is_subagent(path):
    try:
        with open(path) as f:
            r = json.loads(f.readline())
        src = (r.get("payload") or {}).get("source")
        return isinstance(src, dict) and "subagent" in src
    except (OSError, ValueError):
        return False


def codex_log(pid):
    home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    for owner in [pid, *run("pgrep", "-P", pid).split()]:
        paths = open_files(owner)
        logs = [p for p in paths if re.search(r"/sessions/.*/rollout-[^/]*\.jsonl$", p) and not is_subagent(p)]
        if len(logs) == 1:
            return logs[0]
        for p in paths:
            m = re.search(r"^(.*)/thread-writer-locks/(" + ID.pattern + r")", p)
            if m:
                hits = [h for h in glob.glob(f"{m[1]}/sessions/*/*/*/rollout-*-{m[2]}.jsonl") if not is_subagent(h)]
                if len(hits) == 1:
                    return hits[0]
    cwd, started = proc_cwd(pid), proc_start(pid)
    if not cwd or started is None:
        return None
    for p in sorted(glob.glob(f"{home}/sessions/*/*/*/rollout-*.jsonl"), key=os.path.getmtime, reverse=True)[:20]:
        if os.path.getmtime(p) < started:
            break
        try:
            with open(p) as f:
                meta = json.loads(f.readline()).get("payload") or {}
        except (OSError, ValueError):
            continue
        if meta.get("cwd") == cwd and not is_subagent(p):
            return p
    return None


INPUTS = {"function_call_output", "custom_tool_call_output", "local_shell_call_output"}


def codex_responses(path):
    out, model = [], None
    asked = None
    last_total = None
    seen_records = False
    for r in records(path):
        kind, p, t = r.get("type"), r.get("payload") or {}, ts(r.get("timestamp"))
        if not t:
            continue
        if kind == "turn_context":
            model = p.get("model") or model
        elif kind == "response_item" and (p.get("type") in INPUTS or (p.get("type") == "message" and p.get("role") == "user")):
            asked = t
        elif kind == "event_msg" and p.get("type") in ("user_message", "task_started", "turn_started"):
            asked = t
        elif kind == "token_usage_record":
            # One per model response in current Codex.
            seen_records = True
            n = (p.get("usage") or {}).get("output_tokens") or 0
            if asked is not None:
                out.append({"start": asked, "end": t, "tokens": n})
            asked = None
        elif kind == "event_msg" and p.get("type") == "token_count" and not seen_records:
            # Older Codex: token_count repeats; a new total means a new response.
            info = p.get("info") or {}
            total = (info.get("total_token_usage") or {}).get("total_tokens")
            if total is None or total == last_total:
                continue
            last_total = total
            n = (info.get("last_token_usage") or {}).get("output_tokens") or 0
            if asked is not None:
                out.append({"start": asked, "end": t, "tokens": n})
            asked = None
    return out, model, asked is not None


def main():
    app, pid = sys.argv[1:3]
    if not pid.isdigit():
        return 1
    path = claude_log(pid) if app == "claude" else codex_log(pid) if app == "codex" else None
    if not path:
        return 1
    responses, model, busy = (claude_responses if app == "claude" else codex_responses)(path)
    done = [x for x in responses if x["tokens"] > 0 and x["end"] - x["start"] > 0.05]
    if not done:
        return 1
    last, recent = done[-1], done[-RECENT:]
    print(json.dumps({
        "model": model,
        "last": {"tokens": last["tokens"], "secs": round(last["end"] - last["start"], 3)},
        "recent": {"tokens": sum(x["tokens"] for x in recent),
                   "secs": round(sum(x["end"] - x["start"] for x in recent), 3), "n": len(recent)},
        "end": last["end"],
        "busy": busy,
    }))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError):
        sys.exit(1)
