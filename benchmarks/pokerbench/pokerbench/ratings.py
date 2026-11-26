# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-ratings-v2-conduct
"""Skill ratings across many games.

Reads result folders (one per game: run.json, hand_results.jsonl, report.json,
events.jsonl, optionally agent_info_recovered.json) and rates *entrants* --
harness + model + effort, e.g. "claude-code / claude-sonnet-5-5 / medium" --
rather than seats, whose names are arbitrary terminal names.

Ratings are kept per game variant (betting structure x format) and never mixed:

* Cash: bb/100 with a 95% bootstrap CI over deal groups (duplicate-adjusted where
  every player played the deal from every seat: replays at the table, or a series
  of games rotating the seats), plus a Bradley-Terry rating fitted by Hunter's MM
  algorithm on pairwise results (per duplicate deal, else per session), on an
  Elo-like scale with a bootstrap CI over games/series.
* Tournament: a Plackett-Luce Weng-Lin Bayesian rating (OpenSkill-style mu/sigma,
  ordinal = mu - 3 sigma) from finishing orders, plus games / wins / average finish.

Standard library only. Everything is deterministic: bootstraps use seeded RNGs.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import random
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .conduct import counted_decisions, seat_conduct

RATINGS_REVISION = "pokerbench-ratings-v2-conduct"
log = logging.getLogger("pokerbench.ratings")
log.info("[ratings] REVISION: %s loaded at %s", RATINGS_REVISION, time.strftime("%Y-%m-%dT%H:%M:%S%z"))

DEFAULT_BETTING = "no-limit"
HARNESS_EFFORT_UNKNOWN = ("claude-code", "codex", "gemini-cli", "antigravity-cli")
# Weng-Lin / OpenSkill defaults.
MU = 25.0
SIGMA = MU / 3
BETA = SIGMA / 2
KAPPA = 1e-4
ELO_BASE = 1500.0


# -- loading ------------------------------------------------------------------

@dataclass
class Game:
    """One result folder, reduced to what the ratings need."""
    id: str
    format: str  # "cash" | "tournament"
    betting: str  # "no-limit" | "limit"
    started_at: str
    status: str
    finish_reason: str | None
    big_blind: int
    entrants: dict[str, str]  # seat -> entrant (excluded seats are absent)
    hands: list[dict] = field(default_factory=list)  # {"deal", "net": {seat: chips}, "bb"}
    series: dict | None = None  # {"id", "game", "games", "rotation", "seed"}
    standings: list[tuple[str, int]] = field(default_factory=list)  # tournaments: (seat, place)
    notes: list[str] = field(default_factory=list)
    # seat -> conduct.seat_conduct (invalid moves, phantom-hand decisions). REVISION: pokerbench-ratings-v2-conduct
    conduct: dict[str, dict] = field(default_factory=dict)

    @property
    def variant(self) -> str:
        return f"{self.betting}/{self.format}"


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _read_jsonl(path: Path) -> list[dict]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    out = []
    for line in text.splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue  # a truncated last line of a crashed run
    return out


def _top_model(info: dict | None) -> str | None:
    """The most-used model in an agent_info-style {"models": {name: count}} (null counts are 0)."""
    models = (info or {}).get("models") or {}
    if not isinstance(models, dict) or not models:
        return None
    return max(sorted(models), key=lambda m: models[m] or 0)


def _harness_from_label(label: str | None) -> str | None:
    """"anthropic/claude-code" -> "claude-code"; "house/bot (tight)" -> "house"; "agent/muse ..." -> "agent"."""
    if not label:
        return None
    prefix, _, rest = label.partition("/")
    if prefix in ("house", "agent"):
        return prefix
    rest = rest.split(" ", 1)[0]
    return rest or prefix or None


def entrant_name(seat: str, run: dict, recovered: dict | None = None) -> str:
    """The entrant playing ``seat``: "harness / model / effort".

    harness: players[seat].kind, else the reported label's prefix.
    model: the most-used model in run.json agent_info, else in the recovered file,
    else players[seat].model; the house bot's strategy and an Agent block's name
    stand in for a model. effort: from agent_info (or recovered), else the API
    player's effort, else "unknown" for agent harnesses and "default" otherwise.
    """
    player = (run.get("players") or {}).get(seat) or {}
    harness = player.get("kind") or _harness_from_label((run.get("reported_seat_info") or {}).get(seat)) or "unknown"
    live = (run.get("agent_info") or {}).get(seat)
    rec = (recovered or {}).get(seat) if isinstance((recovered or {}).get(seat), dict) else None
    model = _top_model(live) or _top_model(rec) or player.get("model")
    if not model and harness == "house":
        model = player.get("strategy") or "tight"
    if not model and harness == "agent":
        model = player.get("name") or seat
    effort = (live or {}).get("effort") or (rec or {}).get("effort") or player.get("effort")
    if not effort:
        effort = "unknown" if harness in HARNESS_EFFORT_UNKNOWN else "default"
    return f"{harness} / {model or 'unknown'} / {effort}"


def series_info(run: dict) -> dict | None:
    """A series game's {"id", "game", "games", "rotation", "seed"}, or None.

    Accepts run.json["series"] as a dict, or the engine's config fields
    (config.series id, series_game, series_games, rotation, seed)."""
    cfg = run.get("config") or {}
    s = run.get("series")
    if isinstance(s, dict) and s.get("id"):
        return {"id": str(s["id"]), "game": int(s.get("game", 0)), "games": int(s.get("games", 0)),
                "rotation": int(s.get("rotation", 0)), "seed": s.get("seed", cfg.get("seed"))}
    if isinstance(cfg.get("series"), str) and cfg["series"]:
        return {"id": cfg["series"], "game": int(cfg.get("series_game", 0)),
                "games": int(cfg.get("series_games", 0)), "rotation": int(cfg.get("rotation", 0)),
                "seed": cfg.get("seed")}
    return None


def tournament_standings(run: dict, report: dict | None, events: list[dict],
                         hands: list[dict]) -> list[tuple[str, int]]:
    """Finishing order [(seat, place)], place 1 best; survivors with equal chips share a place.

    From report.json's tournament standings, else from the eliminated events plus
    the last hand's stacks. Empty if neither is available."""
    standings = ((report or {}).get("tournament") or {}).get("standings")
    if standings:
        rows = [(r["seat"], int(r["place"]), r.get("chips", 0), "eliminated_hand" in r) for r in standings]
    else:
        out = {e["seat"]: e["place"] for e in events if e.get("type") == "eliminated"}
        if not hands and not out:
            return []
        stacks = (hands[-1].get("end_stacks") if hands else {}) or {}
        alive = sorted((s for s in stacks if s not in out and stacks[s] > 0), key=lambda s: -stacks[s])
        rows = [(s, i + 1, stacks[s], False) for i, s in enumerate(alive)]
        rows += [(s, p, 0, True) for s, p in out.items()]
    rows.sort(key=lambda r: r[1])
    placed: list[tuple[str, int]] = []
    for i, (seat, place, chips, busted) in enumerate(rows):
        if i and not busted and not rows[i - 1][3] and rows[i - 1][2] == chips:
            place = placed[-1][1]  # a chip tie at the hand limit
        placed.append((seat, place))
    return placed


def load_game(path: Path, overrides: dict | None = None) -> Game | None:
    """Read one result folder. None if it has no run.json.

    ``overrides`` maps "game_id/seat" to an entrant name, or to null to leave the
    seat out of every rating (e.g. an agent that never got its prompt)."""
    path = Path(path)
    run = _read_json(path / "run.json")
    if run is None:
        return None
    cfg = run.get("config") or {}
    game_id = path.name
    recovered = _read_json(path / "agent_info_recovered.json") or {}
    seats = list(cfg.get("seats") or [])
    for s in run.get("players") or {}:
        if s not in seats:
            seats.append(s)
    overrides = overrides or {}
    entrants, notes = {}, []
    for seat in seats:
        key = f"{game_id}/{seat}"
        if key in overrides:
            if overrides[key] is None:
                notes.append(f"{seat}: excluded by override")
                continue
            entrants[seat] = str(overrides[key])
        else:
            entrants[seat] = entrant_name(seat, run, recovered)
        rec = recovered.get(seat)
        if isinstance(rec, dict) and rec.get("note"):
            notes.append(f"{seat}: {rec['note']}")
    if recovered.get("_note"):
        notes.append(f"recovered models: {recovered['_note']}")
    if (run.get("isolation") or {}).get("enforced") is False:
        notes.append("seat isolation was not enforced")

    raw = _read_jsonl(path / "hand_results.jsonl")
    big_blind = int(cfg.get("big_blind") or 100)
    hands = [{"deal": r.get("deal", r.get("hand")), "net": r.get("net") or {},
              "bb": (r.get("blinds") or [0, big_blind])[-1] or big_blind} for r in raw]
    fmt = cfg.get("format") or "cash"
    game = Game(id=game_id, format=fmt, betting=cfg.get("betting") or DEFAULT_BETTING,
                started_at=run.get("started_at") or "", status=run.get("status") or "unknown",
                finish_reason=run.get("finish_reason"), big_blind=big_blind, entrants=entrants,
                hands=hands, series=series_info(run), notes=notes)
    events = _read_jsonl(path / "events.jsonl")
    decisions = counted_decisions(_read_jsonl(path / "decisions.jsonl"), events)
    for seat in entrants:
        mine = [d for d in decisions if d.get("seat") == seat]
        game.conduct[seat] = {**seat_conduct(seat, mine, events), "decisions": len(mine)}
    if fmt == "tournament":
        game.standings = tournament_standings(run, _read_json(path / "report.json"),
                                              _read_jsonl(path / "events.jsonl"), raw)
    return game


def find_game_dirs(paths: list[str | Path]) -> list[Path]:
    """Result folders among ``paths``: each path that has a run.json, else its children that do."""
    found = []
    for p in map(Path, paths):
        if (p / "run.json").is_file():
            found.append(p)
        elif p.is_dir():
            found += sorted(c for c in p.iterdir() if (c / "run.json").is_file())
    return sorted(set(found), key=lambda p: (p.name, str(p)))


def load_overrides(path: str | Path | None) -> dict:
    """The --overrides file: {"game_id/seat": "entrant name" | null}."""
    if not path:
        return {}
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("overrides must be a JSON object of {\"game_id/seat\": \"entrant name\" | null}")
    return data


# -- statistics helpers ---------------------------------------------------------

def percentile(sorted_values: list[float], q: float) -> float:
    """Linear-interpolated percentile of an already sorted list (q in 0..1)."""
    if not sorted_values:
        raise ValueError("no values")
    pos = q * (len(sorted_values) - 1)
    lo = math.floor(pos)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


# -- cash: deal groups and bb/100 ------------------------------------------------

@dataclass
class Unit:
    """An independent block of cash play: one game, or a whole series.

    groups[deal][seat] = [net in big blinds, hands]: every play of one deck. In a
    series a seat keeps its name across games, so a deal's group spans the games.
    sessions[game_id][seat] = net in big blinds for that game."""
    key: str
    entrants: dict[str, str]
    groups: dict = field(default_factory=dict)
    sessions: dict = field(default_factory=dict)


def group_complete(group: dict) -> bool:
    """Every seat played the deal equally often, at least once per seat at the table:
    i.e. from every seat (replays at the table, or a full series rotation)."""
    counts = {h for _, h in group.values()}
    return len(group) >= 2 and len(counts) == 1 and counts.pop() >= len(group)


def cash_units(games: list[Game]) -> list[Unit]:
    """Group cash games into units (a series is one unit) with per-deal groups.

    A seat whose entrant differs between the games of a series takes its most
    common entrant there."""
    by_key: dict[str, list[Game]] = defaultdict(list)
    for g in games:
        if g.format != "cash":
            continue
        s = g.series
        by_key[f"series:{s['id']}:{s.get('seed')}" if s else f"game:{g.id}"].append(g)
    units = []
    for key in sorted(by_key):
        seat_votes: dict[str, Counter] = defaultdict(Counter)
        unit = Unit(key=key, entrants={})
        for g in by_key[key]:
            session = unit.sessions.setdefault(g.id, {})
            for h in g.hands:
                group = unit.groups.setdefault(h["deal"], {})
                for seat, net in h["net"].items():
                    if seat not in g.entrants:
                        continue
                    seat_votes[seat][g.entrants[seat]] += 1
                    cell = group.setdefault(seat, [0.0, 0])
                    cell[0] += net / h["bb"]
                    cell[1] += 1
                    session[seat] = session.get(seat, 0.0) + net / h["bb"]
        unit.entrants = {s: sorted(v.items(), key=lambda kv: (-kv[1], kv[0]))[0][0] for s, v in seat_votes.items()}
        units.append(unit)
    return units


def _rate(cells: list[tuple[float, int]]) -> float:
    hands = sum(h for _, h in cells)
    return 100 * sum(n for n, _ in cells) / hands if hands else 0.0


def bootstrap_rate_ci(cells: list[tuple[float, int]], n_boot: int, rng: random.Random) -> tuple[float, float] | None:
    """95% percentile CI of bb/100 resampling whole deal groups (cluster bootstrap)."""
    if len(cells) < 2 or n_boot < 1:
        return None
    k = len(cells)
    samples = sorted(_rate([cells[rng.randrange(k)] for _ in range(k)]) for _ in range(n_boot))
    return percentile(samples, 0.025), percentile(samples, 0.975)


def cash_win_rates(units: list[Unit], n_boot: int = 1000, seed: int = 0, tag: str = "") -> list[dict]:
    """bb/100 per entrant, best first.

    ``bb_per_100`` uses every hand; its ``ci95`` resamples whole deal groups, so a
    complete duplicate group (the deal played from every seat, card luck largely
    cancelled in its total) counts as one unit: duplicate-adjusted wherever the data
    allow, a plain per-hand bootstrap where they don't. ``method`` says which:
    "duplicate" (every hand in complete groups), "mixed" or "hands".
    ``dup_bb_per_100`` / ``dup_ci95`` use only the complete groups.
    """
    cells: dict[str, list] = defaultdict(list)
    dup_cells: dict[str, list] = defaultdict(list)
    games: dict[str, set] = defaultdict(set)
    for u in units:
        for deal in sorted(u.groups, key=str):
            group = u.groups[deal]
            complete = group_complete(group)
            for seat, (net, hands) in sorted(group.items()):
                e = u.entrants[seat]
                cells[e].append((net, hands))
                if complete:
                    dup_cells[e].append((net, hands))
        for gid, session in u.sessions.items():
            for seat in session:
                games[u.entrants[seat]].add(gid)
    rows = []
    for e in sorted(cells):
        rng = random.Random(f"{seed}:rate:{tag}:{e}")
        ci = bootstrap_rate_ci(cells[e], n_boot, rng)
        dup = dup_cells.get(e, [])
        dup_ci = bootstrap_rate_ci(dup, n_boot, rng) if dup else None
        hands = sum(h for _, h in cells[e])
        dup_hands = sum(h for _, h in dup)
        rows.append({
            "entrant": e, "games": len(games[e]), "hands": hands,
            "net_bb": round(sum(n for n, _ in cells[e]), 2),
            "bb_per_100": round(_rate(cells[e]), 2), "ci95": _round_pair(ci),
            "method": "duplicate" if dup_hands == hands else "mixed" if dup_hands else "hands",
            "dup_groups": len(dup), "dup_hands": dup_hands,
            "dup_bb_per_100": round(_rate(dup), 2) if dup else None, "dup_ci95": _round_pair(dup_ci),
        })
    rows.sort(key=lambda r: (-r["bb_per_100"], r["entrant"]))
    return rows


def _round_pair(pair, nd: int = 2):
    return None if pair is None else [round(pair[0], nd), round(pair[1], nd)]


# -- cash: Bradley-Terry ------------------------------------------------------------

def unit_comparisons(unit: Unit) -> dict[tuple[str, str], list[float]]:
    """Pairwise results in one unit: {(a, b): [a's wins, b's wins]} with a < b; a tie is half each.

    Seats of the same entrant are not compared. With complete duplicate groups,
    each complete deal is one comparison of the two seats' net per hand on it;
    otherwise each game (session) is one comparison of total net."""
    complete = [g for g in unit.groups.values() if group_complete(g)]
    rounds = [{s: net / hands for s, (net, hands) in g.items()} for g in complete] if complete \
        else list(unit.sessions.values())
    out: dict[tuple[str, str], list[float]] = defaultdict(lambda: [0.0, 0.0])
    for scores in rounds:
        seats = sorted(scores)
        for i, s in enumerate(seats):
            for t in seats[i + 1:]:
                a, b = unit.entrants[s], unit.entrants[t]
                if a == b:
                    continue
                x, y = scores[s], scores[t]
                if a > b:
                    a, b, x, y = b, a, y, x
                cell = out[(a, b)]
                if abs(x - y) < 1e-9:
                    cell[0] += 0.5
                    cell[1] += 0.5
                elif x > y:
                    cell[0] += 1
                else:
                    cell[1] += 1
    return dict(out)


def merge_comparisons(parts: list[dict]) -> dict[tuple[str, str], list[float]]:
    """Sum several {(a, b): [wins_a, wins_b]} tables."""
    out: dict[tuple[str, str], list[float]] = defaultdict(lambda: [0.0, 0.0])
    for part in parts:
        for pair, (wa, wb) in part.items():
            out[pair][0] += wa
            out[pair][1] += wb
    return dict(out)


def fit_bradley_terry(comparisons: dict[tuple[str, str], list[float]], prior: float = 1.0,
                      max_iter: int = 10_000, tol: float = 1e-10) -> dict[str, float]:
    """Bradley-Terry strengths by the MM algorithm (Hunter 2004).

    P(i beats j) = g_i / (g_i + g_j). The weak prior is ``prior`` pseudo-games
    against a fixed reference player of strength 1 (half won, half lost), so an
    unbeaten entrant stays finite and every entrant is connected. The fixed point
    is unique, so the result does not depend on input order."""
    players = sorted({p for pair in comparisons for p in pair})
    wins = {p: prior / 2 for p in players}
    games: dict[str, dict[str, float]] = {p: defaultdict(float) for p in players}
    for (a, b), (wa, wb) in comparisons.items():
        wins[a] += wa
        wins[b] += wb
        games[a][b] += wa + wb
        games[b][a] += wa + wb
    g = {p: 1.0 for p in players}
    for _ in range(max_iter):
        new = {}
        for p in players:
            denom = prior / (g[p] + 1.0) + sum(n / (g[p] + g[q]) for q, n in games[p].items())
            new[p] = wins[p] / denom if denom > 0 else 1.0
        change = max((abs(math.log(new[p] / g[p])) for p in players), default=0.0)
        g = new
        if change < tol:
            break
    return g


def elo(strength: float) -> float:
    """Bradley-Terry strength on an Elo-like scale: 1500 + 400 log10(strength)."""
    return ELO_BASE + 400 * math.log10(max(strength, 1e-12))


def bradley_terry_ratings(units: list[Unit], prior: float = 1.0, n_boot: int = 1000,
                          seed: int = 0, tag: str = "") -> list[dict]:
    """BT ratings per entrant (Elo-like), with a 95% CI bootstrapping whole units
    (games or series). The CI is None with fewer than two units."""
    per_unit = [unit_comparisons(u) for u in sorted(units, key=lambda u: u.key)]
    total = merge_comparisons(per_unit)
    if not total:
        return []
    point = fit_bradley_terry(total, prior)
    samples: dict[str, list[float]] = defaultdict(list)
    if len(per_unit) >= 2:
        rng = random.Random(f"{seed}:bt:{tag}")
        k = len(per_unit)
        for _ in range(n_boot):
            fit = fit_bradley_terry(merge_comparisons([per_unit[rng.randrange(k)] for _ in range(k)]), prior)
            for p, s in fit.items():
                samples[p].append(elo(s))
    record: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    units_in: dict[str, int] = defaultdict(int)
    for part in per_unit:
        for p in {p for pair in part for p in pair}:
            units_in[p] += 1
        for (a, b), (wa, wb) in part.items():
            record[a][0] += wa
            record[a][1] += wb
            record[b][0] += wb
            record[b][1] += wa
    rows = []
    for p, s in point.items():
        boot = sorted(samples.get(p, []))
        ci = (percentile(boot, 0.025), percentile(boot, 0.975)) if len(boot) >= 2 else None
        rows.append({"entrant": p, "rating": round(elo(s), 1), "ci95": _round_pair(ci, 1),
                     "comparisons": record[p][0] + record[p][1], "wins": record[p][0],
                     "units": units_in[p], "boot_samples": len(boot)})
    rows.sort(key=lambda r: (-r["rating"], r["entrant"]))
    return rows


# -- tournaments: Plackett-Luce (Weng-Lin) ---------------------------------------

def plackett_luce_update(ratings: dict[str, tuple[float, float]], order: list[tuple[str, int]],
                         beta: float = BETA, kappa: float = KAPPA) -> dict[str, tuple[float, float]]:
    """One Weng-Lin Plackett-Luce update (Weng & Lin 2011, Algorithm 4; as OpenSkill).

    ``order``: [(entrant, place)], place 1 best, equal places tie. New entrants start
    at (MU, SIGMA). An entrant with two seats in the game gets both seats' updates.
    Returns a new {entrant: (mu, sigma)}."""
    teams = [(e, place) + tuple(ratings.get(e, (MU, SIGMA))) for e, place in order]
    if len(teams) < 2:
        return dict(ratings)
    c = math.sqrt(sum(sig * sig + beta * beta for _, _, _, sig in teams))
    ex = [math.exp(mu / c) for _, _, mu, _ in teams]
    sum_q = [sum(ex[i] for i, t in enumerate(teams) if t[1] >= tq[1]) for tq in teams]
    a = [sum(1 for t in teams if t[1] == tq[1]) for tq in teams]
    d_mu: dict[str, float] = defaultdict(float)
    f_sigma: dict[str, float] = defaultdict(lambda: 1.0)
    for i, (e, place_i, mu_i, sig_i) in enumerate(teams):
        omega = delta = 0.0
        for q, (_, place_q, _, _) in enumerate(teams):
            if place_q <= place_i:
                p = ex[i] / sum_q[q]
                delta += p * (1 - p) / a[q]
                omega += ((1 - p) if q == i else -p) / a[q]
        var = sig_i * sig_i
        omega *= var / c
        delta *= var / (c * c) * (sig_i / c)  # gamma = sigma / c
        d_mu[e] += omega
        f_sigma[e] *= math.sqrt(max(1 - delta, kappa))
    out = dict(ratings)
    for e in d_mu:
        mu, sig = ratings.get(e, (MU, SIGMA))
        out[e] = (mu + d_mu[e], sig * f_sigma[e])
    return out


def tournament_ratings(games: list[Game]) -> list[dict]:
    """Weng-Lin ratings and simple stats per entrant over finished tournaments, best
    ordinal first. Games are applied in start-time order (the update is sequential)."""
    ratings: dict[str, tuple[float, float]] = {}
    stats: dict[str, dict] = defaultdict(lambda: {"games": 0, "wins": 0, "places": [], "pct": []})
    for g in sorted(games, key=lambda g: (g.started_at, g.id)):
        order = [(g.entrants[s], place) for s, place in g.standings if s in g.entrants]
        if len(order) < 2:
            continue
        # Re-rank among the rated seats (an excluded seat leaves no gap).
        places = sorted({p for _, p in order})
        order = [(e, places.index(p) + 1) for e, p in order]
        ratings = plackett_luce_update(ratings, order)
        n = len(order)
        for e, place in order:
            st = stats[e]
            st["games"] += 1
            st["wins"] += place == 1
            st["places"].append(place)
            st["pct"].append(100.0 * (n - place) / (n - 1))
    rows = []
    for e, (mu, sig) in ratings.items():
        st = stats[e]
        rows.append({"entrant": e, "mu": round(mu, 3), "sigma": round(sig, 3), "ordinal": round(mu - 3 * sig, 3),
                     "games": st["games"], "wins": st["wins"],
                     "avg_place": round(sum(st["places"]) / len(st["places"]), 2),
                     "avg_finish_pct": round(sum(st["pct"]) / len(st["pct"]), 1)})
    rows.sort(key=lambda r: (-r["ordinal"], r["entrant"]))
    return rows


def _tournament_rated(g: Game) -> str | None:
    """Why a tournament is left out of the ratings, or None if it counts."""
    if g.status not in ("finished", "unknown"):
        return f"status {g.status}"
    if len([s for s, _ in g.standings if s in g.entrants]) < 2:
        return "no finishing order"
    return None


# -- conduct ---------------------------------------------------------------------

def conduct_totals(games: list[Game]) -> list[dict]:
    """Per entrant across ``games``: decisions, invalid moves (by error) and preflop
    decisions on a hand it didn't hold (conduct.py). Not part of any rating."""
    # A seat named differently in some games of a series (its effort reported in one game
    # only) counts under its most common name there, as in the ratings (cash_units).
    votes: dict[tuple, Counter] = defaultdict(Counter)
    for g in games:
        unit = f"series:{g.series['id']}:{g.series.get('seed')}" if g.series else f"game:{g.id}"
        for seat, e in g.entrants.items():
            votes[(unit, seat)][e] += sum(1 for h in g.hands if seat in h["net"]) or 1
    named = {k: sorted(v.items(), key=lambda kv: (-kv[1], kv[0]))[0][0] for k, v in votes.items()}
    tot: dict[str, dict] = {}
    for g in games:
        unit = f"series:{g.series['id']}:{g.series.get('seed')}" if g.series else f"game:{g.id}"
        for seat, c in g.conduct.items():
            e = named.get((unit, seat)) if seat in g.entrants else None
            if e is None:
                continue
            t = tot.setdefault(e, {"entrant": e, "games": 0, "decisions": 0, "invalid_actions": 0,
                                   "not_your_turn": 0, "preflop_decisions": 0, "phantom_hands": 0})
            t["games"] += 1
            t["decisions"] += c.get("decisions", 0)
            t["invalid_actions"] += c.get("invalid_actions", 0)
            t["not_your_turn"] += (c.get("invalid_by_error") or {}).get("not_your_turn", 0)
            t["preflop_decisions"] += c.get("preflop_decisions", 0)
            t["phantom_hands"] += c.get("phantom_hands", 0)
    rows = list(tot.values())
    for r in rows:
        r["invalid_per_100"] = round(100 * r["invalid_actions"] / r["decisions"], 1) if r["decisions"] else None
        r["phantom_pct"] = round(100 * r["phantom_hands"] / r["preflop_decisions"], 1) if r["preflop_decisions"] else None
    rows.sort(key=lambda r: (-r["invalid_actions"] - r["phantom_hands"], r["entrant"]))
    return rows


# -- everything ------------------------------------------------------------------

def compute_ratings(games: list[Game], n_boot: int = 1000, seed: int = 0, prior: float = 1.0) -> dict:
    """All ratings, keyed by variant ("no-limit/cash", "no-limit/tournament", ...)."""
    variants: dict[str, dict] = {}
    skipped = []
    for key in sorted({g.variant for g in games}):
        vg = [g for g in games if g.variant == key]
        betting, fmt = key.split("/", 1)
        entry: dict = {"betting": betting, "format": fmt, "games": [g.id for g in vg]}
        if fmt == "cash":
            units = cash_units(vg)
            entry["units"] = len(units)
            entry["series"] = sorted({u.key[len("series:"):] for u in units if u.key.startswith("series:")})
            entry["hands"] = sum(len(g.hands) for g in vg)
            entry["win_rates"] = cash_win_rates(units, n_boot, seed, key)
            entry["bradley_terry"] = bradley_terry_ratings(units, prior, n_boot, seed, key)
        else:
            rated = []
            for g in vg:
                why = _tournament_rated(g)
                if why:
                    skipped.append({"game": g.id, "reason": why})
                else:
                    rated.append(g)
            entry["games"] = [g.id for g in rated]
            entry["hand_limit_finishes"] = [g.id for g in rated if g.finish_reason == "hand_limit"]
            entry["plackett_luce"] = tournament_ratings(rated)
        entry["conduct"] = conduct_totals(vg)
        variants[key] = entry
    return {
        "revision": RATINGS_REVISION,
        "params": {"bootstrap": n_boot, "seed": seed, "bt_prior_games": prior,
                   "weng_lin": {"mu": MU, "sigma": SIGMA, "beta": BETA, "kappa": KAPPA}},
        "games": [{"id": g.id, "variant": g.variant, "started_at": g.started_at, "status": g.status,
                   "finish_reason": g.finish_reason, "hands": len(g.hands), "series": g.series,
                   "entrants": g.entrants, "notes": g.notes} for g in sorted(games, key=lambda g: (g.started_at, g.id))],
        "variants": variants,
        "skipped": skipped,
    }


# -- report ---------------------------------------------------------------------------

def _ci(pair, fmt="{:+.1f}") -> str:
    return "n/a" if pair is None else f"[{fmt.format(pair[0])}, {fmt.format(pair[1])}]"


def _conduct_md(rows: list[dict]) -> list[str]:
    """The conduct table: how cleanly each entrant played, separate from how well."""
    if not rows:
        return []
    out = ["### Conduct (not part of any rating)", "",
           "Invalid: moves the engine refused, mostly sent when it wasn't the seat's turn. Phantom hands: "
           "preflop decisions whose reason names a hand it didn't hold (\"folding K7o\" holding K4), "
           "so it acted without looking; the engine accepted these. Both come from the game folders.", "",
           "| Entrant | games | decisions | invalid | of them not its turn | per 100 decisions | "
           "phantom hands | of preflop decisions |",
           "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for r in rows:
        per = "-" if r["invalid_per_100"] is None else f"{r['invalid_per_100']:.1f}"
        pct = "-" if r["phantom_pct"] is None else f"{r['phantom_pct']:.1f}%"
        out.append(f"| {r['entrant']} | {r['games']} | {r['decisions']} | {r['invalid_actions']} | "
                   f"{r['not_your_turn']} | {per} | {r['phantom_hands']} | {pct} |")
    return out + [""]


def render_markdown(result: dict) -> str:
    """The ratings as a markdown report, caveats included."""
    p = result["params"]
    out = ["# PokerBench ratings", "",
           f"Revision `{result['revision']}` · {len(result['games'])} games · "
           f"bootstrap {p['bootstrap']} resamples (seed {p['seed']}) · BT prior {p['bt_prior_games']:g} pseudo-games", "",
           "Entrants are *harness / model / effort*, derived from each game's run.json "
           "(`players`, `agent_info`) or `agent_info_recovered.json`; an unknown model or "
           "effort makes a separate entrant. Correct with `--overrides`. Variants are never mixed.", ""]
    if not result["variants"]:
        out += ["No games found.", ""]
    for key, v in result["variants"].items():
        out += [f"## {key}", ""]
        if v["format"] == "cash":
            out += [f"{len(v['games'])} games in {v['units']} independent units "
                    f"({len(v['series'])} series), {v['hands']} hands.", "", "### bb/100", "",
                    "| # | Entrant | bb/100 | 95% CI | CI over | hands | games | duplicate-only bb/100 | its 95% CI |",
                    "|---|---|---:|---|---|---:|---:|---:|---|"]
            for i, r in enumerate(v["win_rates"], 1):
                dup = "n/a" if r["dup_bb_per_100"] is None else f"{r['dup_bb_per_100']:+.1f}"
                out.append(f"| {i} | {r['entrant']} | {r['bb_per_100']:+.1f} | {_ci(r['ci95'])} | "
                           f"{r['method']} ({r['dup_hands']}/{r['hands']} hands in {r['dup_groups']} dup deals) | "
                           f"{r['hands']} | {r['games']} | {dup} | {_ci(r['dup_ci95'])} |")
            out += ["", "### Bradley-Terry (Elo-like, 1500 = the prior's reference player)", "",
                    "| # | Entrant | rating | 95% CI | wins / comparisons | games/series |",
                    "|---|---|---:|---|---|---:|"]
            for i, r in enumerate(v["bradley_terry"], 1):
                out.append(f"| {i} | {r['entrant']} | {r['rating']:.0f} | {_ci(r['ci95'], '{:.0f}')} | "
                           f"{r['wins']:g} / {r['comparisons']:g} | {r['units']} |")
            if not v["bradley_terry"]:
                out.append("| | (no pairs of different entrants) | | | | |")
            out.append("")
        else:
            out += [f"{len(v['games'])} tournaments rated"
                    + (f"; {len(v['hand_limit_finishes'])} ended at the hand limit, so survivors are "
                       "ranked by chips, not by elimination" if v["hand_limit_finishes"] else "") + ".", "",
                    "### Plackett-Luce (Weng-Lin; ordinal = mu - 3 sigma)", "",
                    "| # | Entrant | ordinal | mu | sigma | games | wins | avg place | avg finish |",
                    "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
            for i, r in enumerate(v["plackett_luce"], 1):
                out.append(f"| {i} | {r['entrant']} | {r['ordinal']:.2f} | {r['mu']:.2f} | {r['sigma']:.2f} | "
                           f"{r['games']} | {r['wins']} | {r['avg_place']:.2f} | {r['avg_finish_pct']:.0f}% |")
            pl = v["plackett_luce"]
            single = sum(1 for r in pl if r["games"] == 1)
            out += ["", "Avg finish: 100% = won every time, 0% = always last."
                    + (f" {single} of {len(pl)} entrants have played a single tournament: their rating is "
                       "mostly prior (sigma barely moved)." if single else ""), ""]
        out += _conduct_md(v.get("conduct") or [])
    out += ["## Games", "", "| Game | Variant | Status | Hands | Series | Entrants |", "|---|---|---|---:|---|---|"]
    for g in result["games"]:
        s = g["series"]
        series = f"{s['id']} {s['game'] + 1}/{s['games'] or '?'}" if s else ""
        ents = "<br>".join(f"{seat}: {e}" for seat, e in g["entrants"].items())
        out.append(f"| {g['id']} | {g['variant']} | {g['status']} ({g['finish_reason'] or '-'}) | {g['hands']} | "
                   f"{series} | {ents} |")
    notes = [(g["id"], n) for g in result["games"] for n in g["notes"]]
    if notes or result["skipped"]:
        out += ["", "## Data notes", ""]
        out += [f"- {gid}: {n}" for gid, n in notes]
        out += [f"- {s['game']}: not rated ({s['reason']})" for s in result["skipped"]]
    out += ["", "## Caveats", "",
            "- **Sample size.** Check the hands / games columns before reading anything into a ranking. "
            "A CI that spans zero (bb/100) or 1500 (BT) is not evidence of a difference.",
            "- **Single tournaments are very noisy.** One tournament is one finishing order, decided "
            "largely by cards late on when blinds are high; sigma shows how little a few games pin down. "
            "Weng-Lin updates are sequential, so game order (start time) matters slightly.",
            "- **bb/100 CIs** resample whole deal groups: a deal played from every seat (replays at the "
            "table, or a series rotating the seats) is one unit, its card luck largely cancelled. Without "
            "such duplicate deals card luck dominates and CIs are wide. The duplicate-only columns drop "
            "every hand outside complete deal groups.",
            "- **Bradley-Terry** compares entrants at the same table: per complete duplicate deal when "
            "available (so duplicate units carry more weight), else once per session. CIs resample whole "
            "games/series; with fewer than two there is no CI, and with a handful they are rough.",
            "- **Identity** is self-reported or recovered from agent logs after the game; an agent that "
            "failed to start still counts as playing unless excluded with an override (`null`).", ""]
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    """`pokerbench ratings RESULTS... [--out ratings.md] [--json [PATH]]`."""
    p = argparse.ArgumentParser(prog="pokerbench ratings",
                                description="Skill ratings over many PokerBench result folders.")
    p.add_argument("results", nargs="+", help="result folders, or folders containing them")
    p.add_argument("--out", help="write the markdown report here (default: print it)")
    p.add_argument("--json", nargs="?", const="-", help="write JSON here ('-' or no value: stdout)")
    p.add_argument("--overrides", help='JSON {"game_id/seat": "entrant name" | null (exclude the seat)}')
    p.add_argument("--bootstrap", type=int, default=1000, help="bootstrap resamples (default 1000)")
    p.add_argument("--seed", type=int, default=0, help="bootstrap seed (default 0)")
    p.add_argument("--prior", type=float, default=1.0,
                   help="Bradley-Terry prior: pseudo-games vs a 1500 reference (default 1)")
    args = p.parse_args(argv)
    if args.prior <= 0 or args.bootstrap < 0:
        p.error("--prior must be > 0 and --bootstrap >= 0")
    try:
        overrides = load_overrides(args.overrides)
    except (OSError, ValueError) as e:
        print(f"ratings: bad --overrides: {e}", file=sys.stderr)
        return 2
    dirs = find_game_dirs(args.results)
    games = [g for g in (load_game(d, overrides) for d in dirs) if g is not None]
    if not games:
        print("ratings: no result folders (with a run.json) found", file=sys.stderr)
        return 1
    result = compute_ratings(games, args.bootstrap, args.seed, args.prior)
    md = render_markdown(result)
    if args.out:
        Path(args.out).write_text(md, encoding="utf-8")
    if args.json:
        text = json.dumps(result, indent=2) + "\n"
        if args.json == "-":
            sys.stdout.write(text)
        else:
            Path(args.json).write_text(text, encoding="utf-8")
    if not args.out and args.json != "-":
        sys.stdout.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
