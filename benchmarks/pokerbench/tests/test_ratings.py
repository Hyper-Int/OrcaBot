# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-ratings-v1
"""Ratings across games: entrant identity, bb/100 with duplicate deal groups,
Bradley-Terry, Plackett-Luce, and a run over the real example result folders."""

import io
import json
import random
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from pokerbench import ratings as R
from pokerbench.engine import MatchConfig

REAL_RESULTS = Path.home() / "pokerbench-results"
SMALL_FILES = ("run.json", "hand_results.jsonl", "report.json", "events.jsonl", "agent_info_recovered.json")


def cash_game(gid, entrants, hands, series=None, betting="no-limit", started="2026-01-01T00:00:00Z"):
    """A cash Game; hands are (deal, {seat: net chips}) with a 100 big blind."""
    return R.Game(id=gid, format="cash", betting=betting, started_at=started, status="finished",
                  finish_reason="hand_limit", big_blind=100, entrants=dict(entrants),
                  hands=[{"deal": d, "net": net, "bb": 100} for d, net in hands], series=series)


def tournament(gid, order, started):
    """A finished tournament; order = entrants best first, seat name = entrant."""
    return R.Game(id=gid, format="tournament", betting="no-limit", started_at=started, status="finished",
                  finish_reason="bust", big_blind=100, entrants={e: e for e in order},
                  standings=[(e, i + 1) for i, e in enumerate(order)])


def heads_up_hands(rng, deals, edge, luck=5000):
    """Seat a beats seat b by ``edge`` chips a hand on top of big zero-sum card luck."""
    out = []
    for d in range(deals):
        x = rng.gauss(0, luck) + edge
        out.append((d, {"a": x, "b": -x}))
    return out


class EntrantTests(unittest.TestCase):
    def test_identity_from_every_source(self):
        run = {
            "players": {
                "live": {"kind": "antigravity-cli", "model": "Gemini 4 Neon (High)"},
                "rec": {"kind": "claude-code"},
                "label": {"kind": "antigravity-cli", "model": "Gemini 4 Argon (Medium)"},
                "house": {"kind": "house", "strategy": "tight"},
                "block": {"kind": "agent", "name": "muse"},
                "api": {"kind": "api", "provider": "openai", "model": "gpt-6.2", "effort": "high"},
                "bare": {"kind": "codex"},
            },
            "reported_seat_info": {"old": "openai/codex", "oldhouse": "house/bot (tight)"},
            "agent_info": {"live": {"models": {"Gemini 4 Neon": 280, "Gemini 4 Flash": 3}, "effort": "high"}},
        }
        # Recovered counts can be null (only the name was recovered).
        recovered = {"rec": {"models": {"claude-haiku-5-5": None, "claude-sonnet-5-5": 150}, "effort": "medium"},
                     "bare": {"models": {}, "note": "never got its prompt"}}
        want = {
            "live": "antigravity-cli / Gemini 4 Neon / high",
            "rec": "claude-code / claude-sonnet-5-5 / medium",
            "label": "antigravity-cli / Gemini 4 Argon (Medium) / unknown",
            "house": "house / tight / default",
            "block": "agent / muse / default",
            "api": "api / gpt-6.2 / high",
            "bare": "codex / unknown / unknown",
            "old": "codex / unknown / unknown",
            "oldhouse": "house / tight / default",
        }
        for seat, name in want.items():
            self.assertEqual(R.entrant_name(seat, run, recovered), name, seat)

    def test_series_from_run_json_or_engine_config(self):
        self.assertEqual(R.series_info({"series": {"id": "s1", "game": 2, "games": 4, "rotation": 2, "seed": 7}}),
                         {"id": "s1", "game": 2, "games": 4, "rotation": 2, "seed": 7})
        cfg = {"series": "s2", "series_game": 1, "series_games": 3, "rotation": 1, "seed": 9}
        self.assertEqual(R.series_info({"config": cfg})["id"], "s2")
        self.assertIsNone(R.series_info({"config": {"series": ""}}))

    def test_load_game_with_overrides_and_exclusion(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp) / "g1"
            d.mkdir()
            (d / "run.json").write_text(json.dumps({
                "config": {"seats": ["x", "y", "z"], "format": "tournament", "big_blind": 100, "betting": "limit"},
                "status": "finished", "players": {"x": {"kind": "codex"}, "y": {"kind": "codex"},
                                                  "z": {"kind": "house"}}}))
            # No report.json: the order comes from the eliminated events + last stacks.
            (d / "events.jsonl").write_text("\n".join(json.dumps(e) for e in [
                {"type": "eliminated", "seat": "z", "hand": 3, "place": 3}]) + "\n")
            (d / "hand_results.jsonl").write_text(json.dumps(
                {"hand": 3, "deal": 2, "net": {}, "blinds": [50, 100], "end_stacks": {"x": 20000, "y": 10000, "z": 0}}) + "\n")
            g = R.load_game(d, {"g1/x": "codex / gpt-x / high", "g1/y": None})
            self.assertEqual(g.variant, "limit/tournament")
            self.assertEqual(g.entrants, {"x": "codex / gpt-x / high", "z": "house / tight / default"})
            self.assertEqual(g.standings, [("x", 1), ("y", 2), ("z", 3)])
            self.assertIn("y: excluded by override", g.notes)
            self.assertEqual(R.find_game_dirs([tmp]), [d])

    def test_chip_tie_at_the_hand_limit_shares_a_place(self):
        report = {"tournament": {"standings": [
            {"seat": "a", "place": 1, "chips": 500}, {"seat": "b", "place": 2, "chips": 500},
            {"seat": "c", "place": 3, "chips": 0, "eliminated_hand": 9}]}}
        self.assertEqual(R.tournament_standings({}, report, [], []), [("a", 1), ("b", 1), ("c", 3)])


class CashTests(unittest.TestCase):
    def test_stronger_entrant_ranks_first_and_rates_are_zero_sum(self):
        rng = random.Random(1)
        games = [cash_game(f"g{i}", {"a": "strong", "b": "weak"}, heads_up_hands(rng, 300, 60, luck=500))
                 for i in range(4)]
        rows = R.cash_win_rates(R.cash_units(games), n_boot=200)
        self.assertEqual([r["entrant"] for r in rows], ["strong", "weak"])
        self.assertAlmostEqual(rows[0]["bb_per_100"], -rows[1]["bb_per_100"], places=6)
        self.assertEqual(rows[0]["hands"], 1200)
        lo, hi = rows[0]["ci95"]
        self.assertLess(lo, rows[0]["bb_per_100"])
        self.assertGreater(hi, rows[0]["bb_per_100"])
        self.assertEqual(rows[0]["method"], "hands")

    def test_symmetric_data_gives_equal_ratings(self):
        # Each deal is won by a, then lost by a, by the same amount: no edge either way.
        hands = [(d, {"a": 300 * (-1) ** d, "b": -300 * (-1) ** d}) for d in range(200)]
        games = [cash_game("g1", {"a": "p", "b": "q"}, hands), cash_game("g2", {"a": "q", "b": "p"}, hands)]
        units = R.cash_units(games)
        for r in R.cash_win_rates(units, n_boot=50):
            self.assertEqual(r["bb_per_100"], 0)
        bt = R.bradley_terry_ratings(units, n_boot=50)
        self.assertEqual([r["rating"] for r in bt], [1500.0, 1500.0])

    def test_duplicate_series_cancels_card_luck(self):
        # Two-game heads-up series: game 1 replays every deck with the seats swapped.
        # A's true edge is 40 chips a hand (40 bb/100); the luck is +-5000 a hand.
        rng = random.Random(7)
        luck = [rng.gauss(0, 5000) for _ in range(200)]
        g0 = [(d, {"a": luck[d] + 40, "b": -luck[d] - 40}) for d in range(200)]
        g1 = [(d, {"a": -luck[d] + 40, "b": luck[d] - 40}) for d in range(200)]
        ent = {"a": "A", "b": "B"}
        series = [cash_game("s-0", ent, g0, series={"id": "s", "game": 0, "games": 2, "rotation": 0, "seed": 0}),
                  cash_game("s-1", ent, g1, series={"id": "s", "game": 1, "games": 2, "rotation": 1, "seed": 0})]
        units = R.cash_units(series)
        self.assertEqual(len(units), 1)
        self.assertTrue(all(R.group_complete(g) for g in units[0].groups.values()))
        dup = {r["entrant"]: r for r in R.cash_win_rates(units, n_boot=300)}["A"]
        self.assertEqual(dup["method"], "duplicate")
        self.assertAlmostEqual(dup["bb_per_100"], 40.0, places=6)
        self.assertEqual(dup["dup_bb_per_100"], dup["bb_per_100"])
        self.assertLess(dup["ci95"][1] - dup["ci95"][0], 1e-6)
        # The same hands as two unrelated games: luck is not cancelled per deal.
        apart = [cash_game("x-0", ent, g0), cash_game("x-1", ent, g1)]
        raw = {r["entrant"]: r for r in R.cash_win_rates(R.cash_units(apart), n_boot=300)}["A"]
        self.assertEqual(raw["method"], "hands")
        self.assertGreater(raw["ci95"][1] - raw["ci95"][0], 500)
        # The series plus a plain game: still one estimate over all hands, CI over deal groups.
        mixed = {r["entrant"]: r for r in R.cash_win_rates(R.cash_units(series + [apart[0]]), n_boot=50)}["A"]
        self.assertEqual((mixed["method"], mixed["hands"], mixed["dup_hands"]), ("mixed", 600, 400))
        # And the duplicate BT compares per deal: A wins every one.
        cmp = R.unit_comparisons(units[0])
        self.assertEqual(cmp, {("A", "B"): [200.0, 0.0]})

    def test_replays_at_the_table_are_duplicate_groups(self):
        # A 3-handed game with each deal played 3 times (rotations): complete groups.
        hands = []
        for d in range(10):
            for rot in range(3):
                hands.append((d, {"a": 10 + rot, "b": -rot, "c": -10}))
        units = R.cash_units([cash_game("g", {"a": "A", "b": "B", "c": "C"}, hands)])
        self.assertTrue(all(R.group_complete(g) for g in units[0].groups.values()))
        self.assertEqual({r["entrant"]: r["method"] for r in R.cash_win_rates(units, n_boot=20)},
                         {"A": "duplicate", "B": "duplicate", "C": "duplicate"})


class BradleyTerryTests(unittest.TestCase):
    def test_two_players_match_the_closed_form(self):
        g = R.fit_bradley_terry({("a", "b"): [30.0, 10.0]}, prior=0)
        self.assertAlmostEqual(g["a"] / g["b"], 3.0, places=6)

    def test_recovers_the_true_ordering(self):
        truth = {"p1": 4.0, "p2": 2.0, "p3": 1.0, "p4": 0.5}
        rng = random.Random(3)
        cmp = {}
        names = sorted(truth)
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                pa = truth[a] / (truth[a] + truth[b])
                wa = sum(rng.random() < pa for _ in range(400))
                cmp[(a, b)] = [float(wa), float(400 - wa)]
        fit = R.fit_bradley_terry(cmp)
        self.assertEqual(sorted(fit, key=fit.get, reverse=True), ["p1", "p2", "p3", "p4"])
        self.assertAlmostEqual(fit["p1"] / fit["p4"], 8.0, delta=2.0)

    def test_unbeaten_entrant_stays_finite(self):
        fit = R.fit_bradley_terry({("a", "b"): [12.0, 0.0]})
        self.assertTrue(1 < fit["a"] < 100)
        self.assertGreater(R.elo(fit["a"]), 1500)

    def test_order_independent(self):
        rng = random.Random(5)
        games = [cash_game(f"g{i}", {"a": "A", "b": "B", "c": "C"},
                           [(d, {"a": rng.gauss(30, 300), "b": rng.gauss(0, 300), "c": rng.gauss(-30, 300)})
                            for d in range(50)]) for i in range(6)]
        units = R.cash_units(games)
        first = R.bradley_terry_ratings(units, n_boot=100, seed=1)
        shuffled = units[:]
        random.Random(9).shuffle(shuffled)
        self.assertEqual(R.bradley_terry_ratings(shuffled, n_boot=100, seed=1), first)
        self.assertEqual(first[0]["entrant"], "A")
        self.assertTrue(all(r["ci95"] is not None for r in first))

    def test_single_unit_has_no_ci(self):
        rows = R.bradley_terry_ratings(R.cash_units([cash_game("g", {"a": "A", "b": "B"}, [(0, {"a": 5, "b": -5})])]))
        self.assertIsNone(rows[0]["ci95"])


class PlackettLuceTests(unittest.TestCase):
    def test_consistent_winner_ranks_first(self):
        rng = random.Random(2)
        games = []
        for i in range(12):
            rest = ["b", "c", "d"]
            rng.shuffle(rest)
            games.append(tournament(f"t{i:02d}", ["a"] + rest, f"2026-01-{i + 1:02d}"))
        rows = R.tournament_ratings(games)
        self.assertEqual(rows[0]["entrant"], "a")
        self.assertEqual((rows[0]["games"], rows[0]["wins"], rows[0]["avg_finish_pct"]), (12, 12, 100.0))
        for r in rows:
            self.assertLess(r["sigma"], R.SIGMA)
            self.assertAlmostEqual(r["ordinal"], r["mu"] - 3 * r["sigma"], places=2)

    def test_single_game_update_is_zero_sum_and_ties_are_equal(self):
        new = R.plackett_luce_update({}, [("a", 1), ("b", 2), ("c", 3)])
        self.assertAlmostEqual(sum(mu for mu, _ in new.values()), 3 * R.MU, places=6)
        self.assertGreater(new["a"][0], new["b"][0])
        self.assertGreater(new["b"][0], new["c"][0])
        tied = R.plackett_luce_update({}, [("a", 1), ("b", 1)])
        self.assertAlmostEqual(tied["a"][0], tied["b"][0], places=9)

    def test_matches_openskill_reference(self):
        # openskill.py PlackettLuce, rate([[a], [b]]) from defaults: winner mu 27.63523138,
        # sigma 8.065506316; loser 22.36476861, 8.065506316.
        new = R.plackett_luce_update({}, [("a", 1), ("b", 2)])
        self.assertAlmostEqual(new["a"][0], 27.63523138, places=5)
        self.assertAlmostEqual(new["a"][1], 8.065506316, places=5)
        self.assertAlmostEqual(new["b"][0], 22.36476861, places=5)


class ReportTests(unittest.TestCase):
    def test_variants_are_never_mixed_and_output_is_deterministic(self):
        rng = random.Random(4)
        games = [cash_game("nl", {"a": "A", "b": "B"}, heads_up_hands(rng, 50, 20)),
                 cash_game("lim", {"a": "A", "b": "C"}, heads_up_hands(rng, 50, 20), betting="limit"),
                 tournament("t1", ["A", "D"], "2026-02-01")]
        res = R.compute_ratings(games, n_boot=50)
        self.assertEqual(sorted(res["variants"]), ["limit/cash", "no-limit/cash", "no-limit/tournament"])
        self.assertEqual({r["entrant"] for r in res["variants"]["no-limit/cash"]["win_rates"]}, {"A", "B"})
        self.assertEqual({r["entrant"] for r in res["variants"]["limit/cash"]["win_rates"]}, {"A", "C"})
        self.assertEqual({r["entrant"] for r in res["variants"]["no-limit/tournament"]["plackett_luce"]}, {"A", "D"})
        again = R.compute_ratings(list(reversed(games)), n_boot=50)
        self.assertEqual(json.dumps(res, sort_keys=True), json.dumps(again, sort_keys=True))
        md = R.render_markdown(res)
        for heading in ("## limit/cash", "## no-limit/cash", "## no-limit/tournament", "## Caveats"):
            self.assertIn(heading, md)

    @unittest.skipUnless(REAL_RESULTS.is_dir() and any(REAL_RESULTS.glob("*/run.json")), "no real results here")
    def test_real_result_folders(self):
        with tempfile.TemporaryDirectory() as tmp:
            for src in sorted(REAL_RESULTS.glob("*/run.json")):
                dst = Path(tmp) / src.parent.name
                dst.mkdir()
                for name in SMALL_FILES:
                    if (src.parent / name).exists():
                        shutil.copy(src.parent / name, dst / name)
            md_path, json_path = Path(tmp) / "ratings.md", Path(tmp) / "ratings.json"
            with redirect_stdout(io.StringIO()):
                rc = R.main([tmp, "--out", str(md_path), "--json", str(json_path), "--bootstrap", "50"])
            self.assertEqual(rc, 0)
            res = json.loads(json_path.read_text())
            self.assertTrue(res["variants"])
            for v in res["variants"].values():
                rows = v.get("plackett_luce") or v.get("win_rates")
                self.assertTrue(rows)
            self.assertIn("# PokerBench ratings", md_path.read_text())


@unittest.skipUnless("series" in MatchConfig.__dataclass_fields__, "engine has no series games")
class EngineSeriesTests(unittest.TestCase):
    def test_a_played_series_lines_up_every_deal(self):
        from test_engine import play_out
        from pokerbench.engine import Match

        with tempfile.TemporaryDirectory() as tmp:
            for k in range(2):
                cfg = MatchConfig(seats=("alice", "bob"), require_join=False, duplicate=False, deals=20, seed=11,
                                  series="s", series_game=k, series_games=2, rotation=k)
                play_out(Match(cfg, Path(tmp) / f"game{k}"), ("tight", "random"))
            names = {f"game{k}/{s}": f"{s}-bot" for k in range(2) for s in ("alice", "bob")}
            games = [R.load_game(d, names) for d in R.find_game_dirs([tmp])]
            units = R.cash_units(games)
            self.assertEqual(len(units), 1)
            self.assertEqual(len(units[0].groups), 20)
            self.assertTrue(all(R.group_complete(g) for g in units[0].groups.values()))
            rows = R.cash_win_rates(units, n_boot=50)
            self.assertEqual({r["method"] for r in rows}, {"duplicate"})
            self.assertAlmostEqual(sum(r["net_bb"] for r in rows), 0, places=6)


if __name__ == "__main__":
    unittest.main()
