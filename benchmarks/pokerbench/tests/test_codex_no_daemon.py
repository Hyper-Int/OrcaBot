# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-seat-v7-codex-no-daemon
"""Codex must run with --no-daemon. Otherwise every Codex on the VM runs its shell commands
in one shared background server with the environment of the terminal that started it, so
`poker` found no seat after a restart (2026-11-22: Codex never played) or, with several
Codex terminals, the first one's seat for all of them. The template starts Codex with
--no-daemon; the seat helper refuses to seat a Codex started without it."""

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEAT = ROOT / "bin" / "seat"


def own_server(tree: dict[int, tuple[int, list[str]]], start: int) -> bool:
    """Run the helper's codex_own_server against a fake /proc: {pid: (ppid, argv)}."""
    with tempfile.TemporaryDirectory() as proc:
        for pid, (ppid, argv) in tree.items():
            d = Path(proc) / str(pid)
            d.mkdir()
            (d / "cmdline").write_bytes(b"\0".join(a.encode() for a in argv) + b"\0")
            (d / "stat").write_text(f"{pid} (x) S {ppid} {pid} {pid} 0 -1")
        fn = re.search(r"^codex_own_server\(\) \{.*?^\}", SEAT.read_text(), re.S | re.M).group(0)
        r = subprocess.run(["bash", "-c", fn + "\ncodex_own_server"],
                           env={"POKER_TEST_PROC": proc, "POKER_TEST_PPID": str(start), "PATH": "/usr/bin:/bin"})
        return r.returncode == 0


NATIVE = "/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"


class CodexNoDaemonTests(unittest.TestCase):
    def test_helper_under_codex(self):
        # The template: the boot shell execs codex, so the helper's parent is codex itself.
        self.assertFalse(own_server({12338: (621, [NATIVE, "--dangerously-bypass-approvals-and-sandbox"])}, 12338))
        self.assertTrue(own_server({12338: (621, [NATIVE, "--no-daemon", "-m", "gpt-6.2-sol",
                                                  "--dangerously-bypass-approvals-and-sandbox"])}, 12338))

    def test_codex_started_from_a_shell(self):
        tree = {500: (621, ["bash", "-l"]), 501: (500, ["codex", "--model", "x"])}
        self.assertFalse(own_server(tree, 501))
        tree[501] = (500, ["codex", "--model", "x", "--no-daemon"])
        self.assertTrue(own_server(tree, 501))

    def test_no_codex_found_does_not_block(self):
        self.assertTrue(own_server({700: (1, ["bash", "-l"])}, 700))
        self.assertTrue(own_server({}, 4242))  # no /proc entry (not Linux)

    def test_template_starts_codex_without_the_daemon(self):
        items = json.loads((ROOT / "template.json").read_text())
        boots = [json.loads(i["content"]).get("bootCommand", "") for i in items["items"]
                 if isinstance(i.get("content"), str) and i["content"].startswith("{")]
        codex = [b for b in boots if "exec codex" in b]
        self.assertEqual(len(codex), 1)
        self.assertIn("exec codex --no-daemon", codex[0])


if __name__ == "__main__":
    unittest.main()
