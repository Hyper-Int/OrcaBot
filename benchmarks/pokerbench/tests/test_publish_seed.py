# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-main-v16-publish-at-finish
"""Results reach the dashboard as soon as a game is over (game 4's never did: the engine
published only once every seat had seen the end, and its terminal restarted first), and
each game gets a new seed unless one is set (every game had used seed 0)."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from pokerbench.main import _publish

ROOT = Path(__file__).resolve().parents[1]


class PublishTests(unittest.TestCase):
    def test_publish_copies_the_run_readably(self):
        with tempfile.TemporaryDirectory() as d:
            run, out = Path(d) / "run", Path(d) / "out" / "g1"
            (run / "hands").mkdir(parents=True)
            (run / "report.md").write_text("# report")
            (run / "hands" / "hand-00001.phh").write_text("x")
            (run / "report.md").chmod(0o600)
            _publish(run, out)
            self.assertEqual((out / "report.md").read_text(), "# report")
            self.assertTrue((out / "hands" / "hand-00001.phh").exists())
            self.assertTrue(os.stat(out / "report.md").st_mode & 0o004)


class SeedTests(unittest.TestCase):
    def seed(self, value):
        # The seed lines of bin/table-engine, run on their own.
        src = (ROOT / "bin" / "table-engine").read_text()
        start = src.index('case "${SEED:-random}" in')
        block = src[start:src.index("esac", start) + 4]
        r = subprocess.run(["bash", "-c", 'die() { echo "DIE $*"; exit 1; }\n' + block + '\necho "SEED=$SEED"'],
                           env={"PATH": os.environ["PATH"], **({"SEED": value} if value is not None else {})},
                           capture_output=True, text=True)
        return r.stdout.strip()

    def test_random_unless_set(self):
        a, b = self.seed("random"), self.seed(None)
        self.assertRegex(a, r"^SEED=\d+$")
        self.assertRegex(b, r"^SEED=\d+$")
        self.assertNotEqual(a, self.seed("random"))  # a fresh one each time (2^31 values)
        self.assertEqual(self.seed("0"), "SEED=0")
        self.assertEqual(self.seed("12345"), "SEED=12345")
        self.assertIn("DIE", self.seed("abc"))


if __name__ == "__main__":
    unittest.main()
