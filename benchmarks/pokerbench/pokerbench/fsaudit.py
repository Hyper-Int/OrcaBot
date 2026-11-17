# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-fsaudit-v2-harness-noise
"""Files seats left where other seats could find them.

Agents at one table share a machine (in Orcabot, one VM and one /workspace).
Two of them could coordinate through the filesystem: notes, a shared script, a
named pipe. After a match, ``pokerbench audit-files`` lists every file each
seat's OS user created or changed since the match started outside its own home,
and whether other users can read it (world-readable). The report shows them.

It sees what the auditing user can see: run it as root (or the harness user)
for full coverage. It can't tell whether another seat actually read a file;
that needs process auditing (fanotify), which is not built.
"""

from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path

FSAUDIT_REVISION = "pokerbench-fsaudit-v2-harness-noise"
DEFAULT_ROOTS = ("/tmp", "/var/tmp", "/dev/shm", "/workspace", "/home", "/opt")
# Scratch directories the agent harnesses create for themselves (not the agent's doing).
HARNESS_PATHS = (re.compile(r"^/tmp/claude-\d+(/|$)"), re.compile(r"^/tmp/cc-socks"),
                 re.compile(r"^/tmp/codex-"), re.compile(r"^/tmp/gemini-"), re.compile(r"^/tmp/\.gemini"))
SKIP_DIRS = {"node_modules", ".npm", ".cache", "__pycache__", ".git"}


def scan(seat_uids: dict[str, int], since: float, roots=DEFAULT_ROOTS, homes: dict[str, str] | None = None,
         skip_prefixes: tuple[str, ...] = ()) -> list[dict]:
    by_uid = {uid: seat for seat, uid in seat_uids.items()}
    homes = homes or {}
    found = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: None):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            if any(dirpath.startswith(p) for p in skip_prefixes):
                dirnames[:] = []
                continue
            for name in filenames + [d for d in dirnames]:
                path = os.path.join(dirpath, name)
                try:
                    st = os.lstat(path)
                except OSError:
                    continue
                seat = by_uid.get(st.st_uid)
                if seat is None or st.st_mtime < since:
                    continue
                home = homes.get(seat)
                if home and (path == home or path.startswith(home.rstrip("/") + "/")):
                    continue
                found.append({
                    "seat": seat, "uid": st.st_uid, "path": path,
                    "kind": "dir" if stat.S_ISDIR(st.st_mode) else "fifo" if stat.S_ISFIFO(st.st_mode)
                    else "socket" if stat.S_ISSOCK(st.st_mode) else "file",
                    "mode": oct(st.st_mode & 0o777),
                    "world_readable": bool(st.st_mode & stat.S_IROTH),
                    "world_writable": bool(st.st_mode & stat.S_IWOTH),
                    "size": st.st_size,
                    "harness": any(r.match(path) for r in HARNESS_PATHS),
                })
    return found


def write(run_dir: Path, entries: list[dict]) -> Path:
    out = Path(run_dir) / "fs_audit.jsonl"
    with open(out, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, sort_keys=True) + "\n")
    return out
