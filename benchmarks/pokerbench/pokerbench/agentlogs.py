# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-agentlogs-v1
"""Which model an agent terminal's agent actually used, from the agent's own logs.

The seat's label says only "anthropic/claude-code": the agent picks its model itself
(Gemini CLI's "Auto" picked gemini-3.8-flash for every request of the 2026-11-22 game),
and nothing recorded it. A seat's helper runs this during the game and reports the
result to the engine (POST /api/seat/agent), which puts it in run.json and the report.

Read from what each agent writes for every request or turn, from the game's start on:
- Claude Code: ~/.claude/projects/*/*.jsonl, "api-request" lines: params.model and
  params.output_config.effort; "version" on every line.
- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, "turn_context" lines: model and
  collaboration_mode.settings.reasoning_effort (null: Codex's default); session_meta's
  cli_version.
- Gemini CLI: ~/.gemini/tmp/*/chats/session-*.jsonl, "gemini" lines: model. Its version
  from the installed package.

Self-reported by the seat, like its label: a seat could misreport. Standard library only:
the engine publishes it for seats as seat_agentlogs.py.

    python3 seat_agentlogs.py --agent claude-code --since 2026-11-22T23:53:00Z [--home DIR]
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys
from collections import Counter
from datetime import datetime, timezone

AGENTLOGS_REVISION = "pokerbench-agentlogs-v1"

MAX_FILES = 40
MAX_LINES = 200_000


def _ts(value) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _recent(pattern: str, since: float) -> list[str]:
    files = [f for f in glob.glob(pattern) if os.path.isfile(f) and os.path.getmtime(f) >= since]
    return sorted(files, key=os.path.getmtime)[-MAX_FILES:]


def _lines(path: str):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= MAX_LINES:
                    return
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if isinstance(obj, dict):
                    yield obj
    except OSError:
        return


def _effort(counts: Counter) -> str | None:
    """One effort if it never changed, else "a 3, b 1"."""
    if not counts:
        return None
    if len(counts) == 1:
        return next(iter(counts))
    return ", ".join(f"{k} {n}" for k, n in counts.most_common())


def claude_code(home: str, since: float) -> dict:
    models, efforts, version = Counter(), Counter(), None
    for path in _recent(os.path.join(home, ".claude", "projects", "*", "*.jsonl"), since):
        for o in _lines(path):
            ts = _ts(o.get("timestamp"))
            if ts is None or ts < since:
                continue
            if o.get("type") == "api-request":
                params = o.get("params") if isinstance(o.get("params"), dict) else {}
                if params.get("model"):
                    models[str(params["model"])] += 1
                    eff = (params.get("output_config") or {}).get("effort") if isinstance(params.get("output_config"), dict) else None
                    efforts[str(eff) if eff else "default"] += 1
            if o.get("version"):
                version = str(o["version"])
    return {"models": dict(models), "unit": "requests", "effort": _effort(efforts), "version": version}


def codex(home: str, since: float) -> dict:
    models, efforts, version = Counter(), Counter(), None
    for path in _recent(os.path.join(home, ".codex", "sessions", "*", "*", "*", "rollout-*.jsonl"), since):
        for o in _lines(path):
            payload = o.get("payload") if isinstance(o.get("payload"), dict) else {}
            if o.get("type") == "session_meta" and payload.get("cli_version"):
                version = str(payload["cli_version"])
            ts = _ts(o.get("timestamp"))
            if o.get("type") != "turn_context" or ts is None or ts < since or not payload.get("model"):
                continue
            models[str(payload["model"])] += 1
            mode = payload.get("collaboration_mode") if isinstance(payload.get("collaboration_mode"), dict) else {}
            settings = mode.get("settings") if isinstance(mode.get("settings"), dict) else {}
            eff = payload.get("effort") or settings.get("reasoning_effort")
            efforts[str(eff) if eff else "default"] += 1
    return {"models": dict(models), "unit": "turns", "effort": _effort(efforts), "version": version}


def _package_version(command: str) -> str | None:
    """The version in the package.json above an installed node CLI."""
    exe = shutil.which(command)
    if not exe:
        return None
    d = os.path.dirname(os.path.realpath(exe))
    for _ in range(6):
        pkg = os.path.join(d, "package.json")
        if os.path.isfile(pkg):
            try:
                with open(pkg, encoding="utf-8") as f:
                    v = json.load(f).get("version")
                return str(v) if v else None
            except (OSError, ValueError):
                return None
        d = os.path.dirname(d)
    return None


def gemini_cli(home: str, since: float) -> dict:
    models = Counter()
    for path in _recent(os.path.join(home, ".gemini", "tmp", "*", "chats", "session-*.json*"), since):
        for o in _lines(path):
            ts = _ts(o.get("timestamp"))
            if o.get("type") == "gemini" and o.get("model") and ts is not None and ts >= since:
                models[str(o["model"])] += 1
    return {"models": dict(models), "unit": "responses", "effort": None, "version": _package_version("gemini")}


READERS = {"claude-code": claude_code, "codex": codex, "gemini-cli": gemini_cli}


def read(agent: str, home: str, since: float) -> dict:
    info = READERS[agent](home, since)
    return {k: v for k, v in info.items() if v not in (None, {}, "")}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="the models an agent used, from its own logs (JSON)")
    p.add_argument("--agent", required=True, choices=sorted(READERS))
    p.add_argument("--since", required=True, help="ISO time (or epoch seconds): count only what came after")
    p.add_argument("--home", default=os.path.expanduser("~"))
    args = p.parse_args(argv)
    try:
        since = float(args.since)
    except ValueError:
        since = _ts(args.since) or datetime.now(timezone.utc).timestamp()
    print(json.dumps(read(args.agent, args.home, since), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
