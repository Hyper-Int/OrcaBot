# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-relay-v7-scoreboard
"""The relay: a delayed public copy of the table, uploaded through the secrets broker.
Only what the table page draws leaves the VM, and nothing newer than the delay."""

import json
import os
import tempfile
from pathlib import Path
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest import mock

from pokerbench import relay

SPECTATE = {
    "revision": "e", "status": "running", "start": "manual", "paused": False, "turn_timeout": 300.0,
    "seats": ["a", "b"], "labels": {"a": "Codex (gpt-6.2-astra)"}, "joined": ["a", "b"],
    "players": {"a": {"kind": "codex", "model": "gpt-6.2-astra", "label": "x"}},
    "seat_status": {"a": {"state": "needs", "message": "Codex isn't signed in: type codex login"}},
    "hand": 4, "hands_total": 100, "big_blind": 100, "format": "cash",
    "isolation": {"enforced": True, "engine_uid": 0, "seat_uids": {"a": 3005}, "problems": []},
    "leaderboard": [], "counters": {}, "recent": [], "future_field": "private until whitelisted",
    "series": {"id": "series-1", "game": 3, "games": 10},
    "live": {"street": "flop", "board": ["Ah", "Kd", "2c"], "pot": 300, "actor": "a", "blinds": [50, 100],
             "seats": {}, "actions": [{"seat": "b", "street": "preflop", "action": "call", "amount": 100}],
             "seconds_left": 12.0},
    "last_hand": {"hand": 3, "board": [], "net": {"a": 50, "b": -50}, "hole": {"a": None, "b": None},
                  "showdown": False, "folded": ["b"], "players": ["a", "b"], "end_stacks": {}, "actions": [],
                  "secret_extra": 1},
}


class PublicViewTests(unittest.TestCase):
    def test_only_what_the_page_draws(self):
        v = relay.public_view(SPECTATE)
        self.assertNotIn("players", v)
        self.assertNotIn("future_field", v)
        self.assertNotIn("start", v)
        self.assertEqual(v["isolation"], {"enforced": True})
        self.assertEqual(v["seat_status"], {"a": {"state": "needs"}})
        self.assertNotIn("secret_extra", v["last_hand"])
        self.assertEqual(v["live"], SPECTATE["live"])
        self.assertEqual(v["series"], {"id": "series-1", "game": 3, "games": 10})
        self.assertEqual(v["labels"], {"a": "gpt-6.2-astra"})

    def test_labels_name_the_model(self):
        self.assertEqual(relay.model_label("anthropic/claude-code (claude-opus-5-5)"), "claude-opus-5-5")
        self.assertEqual(relay.model_label("google/antigravity-cli (Gemini 4 Neon (High))"), "Gemini 4 Neon (High)")
        self.assertEqual(relay.model_label("House bot"), "House bot")


class DelayBufferTests(unittest.TestCase):
    def test_nothing_newer_than_the_delay(self):
        b = relay.DelayBuffer(10)
        for t in (0, 2, 4, 12):
            b.push(t, {"t": t})
        self.assertIsNone(b.due(9))
        self.assertEqual(b.due(14), (4, {"t": 4}))  # the newest one that is 10s old
        self.assertIsNone(b.due(14))
        self.assertEqual(b.due(22), (12, {"t": 12}))


class ProgressTests(unittest.TestCase):
    def test_hands_in_finished_series_games(self):
        with tempfile.TemporaryDirectory() as d:
            def game(name, status, hands, **cfg):
                g = Path(d) / name
                g.mkdir(parents=True)
                config = {"format": "cash", "betting": "no-limit", "series": "series-1", **cfg}
                (g / "run.json").write_text(json.dumps({"status": status, "config": config}))
                (g / "hand_results.jsonl").write_text("".join(json.dumps({"hand": i}) + "\n" for i in range(hands)))
            game("g1", "finished", 100)
            game("g2", "finished", 100, series="series-2")
            game("g3", "running", 40)                       # still being played: not yet
            game("t1", "finished", 80, format="tournament")  # not a series
            game("s1", "finished", 100, series="")           # a single game
            game("lim", "finished", 100, betting="limit")    # another benchmark
            game("abandoned/g0", "finished", 100)            # set aside: in a subfolder
            cache = {}
            self.assertEqual(relay.results_progress(d, cache), {"hands": 200, "games": 2})
            run = json.loads((Path(d) / "g3/run.json").read_text())
            (Path(d) / "g3/run.json").write_text(json.dumps({**run, "status": "finished"}))
            (Path(d) / "g3/hand_results.jsonl").write_text("".join("{}\n" for _ in range(100)))
            self.assertEqual(relay.results_progress(d, cache), {"hands": 300, "games": 3})
            self.assertEqual(relay.results_progress(str(Path(d) / "missing"), {}), {"hands": 0, "games": 0})


class Fake(BaseHTTPRequestHandler):
    st: dict = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/api/spectate" and Fake.st["engine_up"]:
            body = json.dumps({**SPECTATE, "hand": Fake.st["hand"],
                               "series": {"id": "series-1", "game": Fake.st.get("game", 0), "games": 10}}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(503)
            self.end_headers()

    def do_PUT(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        Fake.st.setdefault("agents", []).append(self.headers.get("User-Agent"))
        status = Fake.st.get("put_status", 204)
        Fake.st["puts"].append((self.path, json.loads(body), status))
        self.send_response(status)
        self.end_headers()


class RunTests(unittest.TestCase):
    def setUp(self):
        Fake.st = {"engine_up": True, "hand": 1, "puts": []}
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def test_uploads_through_the_broker_and_behind_the_delay(self):
        now = [1_800_000_000.0]
        events = {3: lambda: Fake.st.update(hand=2), 5: lambda: Fake.st.update(engine_up=False),
                  7: lambda: Fake.st.update(engine_up=True, hand=3, put_status=500)}
        tick = [0]

        def sleep(_):
            now[0] += 2
            tick[0] += 1
            events.get(tick[0], lambda: None)()

        logs = []
        relay.run(self.url, "https://relay.example/tables/pb", f"{self.url}/broker/s1/custom/POKERBENCH_RELAY_KEY",
                  delay=4, interval=2, clock=lambda: now[0], sleep=sleep, rounds=12, log=logs.append)
        puts = Fake.st["puts"]
        self.assertTrue(puts)
        path, body, _ = puts[0]
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
        self.assertTrue(path.startswith("/broker/s1/custom/POKERBENCH_RELAY_KEY?"))
        self.assertEqual(q["target"], ["https://relay.example/tables/pb"])
        self.assertEqual(body["relay"]["delay_s"], 4)
        self.assertNotIn("players", body)
        # Its own User-Agent (Cloudflare refuses Python's default with error 1010).
        self.assertEqual(set(Fake.st["agents"]), {f"pokerbench-relay/{relay.RELAY_REVISION}"})
        # Round 1 read at t0 goes out at round 3 (t0+4), never sooner: the first upload is
        # the snapshot from 4s before it. Unchanged snapshots aren't sent again.
        self.assertEqual(body["relay"]["as_of"], "2027-01-15T08:00:00Z")
        self.assertEqual([b["hand"] for _, b, st in puts if st == 204], [1, 2])
        # Hand 3's uploads were refused (500): logged and tried again each round, no crash.
        refused = [b["hand"] for _, b, st in puts if st != 204]
        self.assertGreater(len(refused), 1)
        self.assertEqual(set(refused), {3})
        self.assertTrue(any("upload refused: 500" in l for l in logs))

    def test_a_new_game_never_shows_the_last_ones_cards(self):
        # A series deals the same cards every game: once game 1 starts, nothing held from
        # game 0 may go out; the page says the next game is starting until game 1's own
        # snapshots are old enough.
        now = [1_800_000_000.0]
        tick = [0]

        def sleep(_):
            now[0] += 2
            tick[0] += 1
            if tick[0] == 6:
                Fake.st.update(game=1, hand=1)

        logs = []
        relay.run(self.url, "https://relay.example/tables/pb", f"{self.url}/broker/s1/custom/K",
                  delay=10, interval=2, clock=lambda: now[0], sleep=sleep, rounds=14, log=logs.append)
        bodies = [b for _, b, _ in Fake.st["puts"]]
        games = [b.get("series", {}).get("game") for b in bodies]
        first_new = games.index(1)
        self.assertEqual(set(games[first_new:]), {1}, games)
        starting = bodies[first_new]
        self.assertEqual(starting["status"], "waiting_for_players")
        for k in ("live", "last_hand"):
            self.assertNotIn(k, starting)
        self.assertEqual(starting["leaderboard"], [])
        self.assertTrue(any("last game's snapshots dropped" in l for l in logs))
        self.assertIn("live", bodies[-1])  # then game 1 itself, delayed as usual

    def test_scoreboard_goes_to_ratings_behind_the_delay_when_a_game_finishes(self):
        # REVISION: pokerbench-relay-v7-scoreboard
        now = [1_800_000_000.0]
        tick = [0]
        with tempfile.TemporaryDirectory() as d:
            def finish(name):
                g = Path(d) / name
                g.mkdir()
                (g / "run.json").write_text(json.dumps({"status": "finished", "config": {
                    "format": "cash", "betting": "no-limit", "series": "series-1"}}))
                (g / "hand_results.jsonl").write_text("{}\n" * 100)

            finish("g1")
            worked = []

            def board(results_dir):
                worked.append(now[0])
                games = len(list(Path(results_dir).iterdir()))
                return {"games": games, "models": [{"model": "m", "bb_per_100": float(games)}]}

            def sleep(_):
                now[0] += 2
                tick[0] += 1
                if tick[0] == 8:
                    finish("g2")

            logs = []
            relay.run(self.url, "https://relay.example/tables/pb", f"{self.url}/broker/s1/custom/K",
                      delay=6, interval=2, clock=lambda: now[0], sleep=sleep, rounds=20, log=logs.append,
                      results_dir=d, board=board, background=False)
        ratings = [(p, b) for p, b, _ in Fake.st["puts"]
                   if urllib.parse.parse_qs(urllib.parse.urlsplit(p).query)["target"][0].endswith("/ratings")]
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(ratings[0][0]).query)["target"],
                         ["https://relay.example/tables/pb/ratings"])
        # Worked out once per finished game count, not every round; each sent once.
        self.assertEqual(len(worked), 2)
        self.assertEqual([b["games"] for _, b in ratings], [1, 2])
        self.assertTrue(any("scoreboard sent (1 games)" in l for l in logs))
        # Sent ``delay`` after it was worked out (the first round, t0): at t0+6, round 4.
        first = next(i for i, l in enumerate(logs) if "scoreboard sent" in l)
        self.assertIn("2027-01-15T08:00:06Z", logs[first])

    def test_a_refused_scoreboard_is_tried_again_a_minute_later(self):
        now = [1_800_000_000.0]
        Fake.st["put_status"] = 404
        with tempfile.TemporaryDirectory() as d:
            g = Path(d) / "g1"
            g.mkdir()
            (g / "run.json").write_text(json.dumps({"status": "finished", "config": {
                "format": "cash", "betting": "no-limit", "series": "series-1"}}))
            (g / "hand_results.jsonl").write_text("{}\n")

            def sleep(_):
                now[0] += 2

            relay.run(self.url, "https://relay.example/tables/pb", f"{self.url}/broker/s1/custom/K",
                      delay=0, interval=2, clock=lambda: now[0], sleep=sleep, rounds=40, log=lambda *_: None,
                      results_dir=d, board=lambda _: {"models": []}, background=False)
        tries = [p for p, _, _ in Fake.st["puts"] if "ratings" in urllib.parse.unquote(p)]
        self.assertEqual(len(tries), 2)  # rounds 1 and 31 (60s later), not all 40

    def test_main_needs_the_broker_and_https(self):
        args = SimpleNamespace(engine=self.url, target="https://x/tables/pb", delay=1, interval=1)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(relay.main(args), 1)
        with mock.patch.dict(os.environ, {"POKERBENCH_RELAY_KEY_BROKER": "http://127.0.0.1:1/b"}):
            self.assertEqual(relay.main(SimpleNamespace(**{**vars(args), "target": "http://x/tables/pb"})), 1)


if __name__ == "__main__":
    unittest.main()
