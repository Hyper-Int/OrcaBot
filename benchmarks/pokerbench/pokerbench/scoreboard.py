# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-scoreboard-v1
"""The public scoreboard: what the benchmark page's chart draws, from the results folder.

bb/100 per model with its 95% range, each series' own bb/100, and the Bradley-Terry
rating (the rating alone: its bootstrap range refits the model a thousand times, minutes
of CPU as the series add up, and the chart doesn't draw it), over every finished game of the no-limit cash series (the same games the
relay's progress counts; one game per top-level folder, abandoned games set aside in
subfolders). The numbers are ratings.py's own, with its defaults (1000 bootstrap
resamples, seed 0, BT prior 1), so they match ``pokerbench ratings`` over the same
games. A series still being played is in it with the games it has finished, and says
so ("games" of "of"): its deals haven't all been played from every seat yet.

Only aggregates leave the VM: models (not the agents they played through, nor seat
names), win rates and game counts. The relay uploads it (relay.py).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .ratings import bradley_terry_ratings, cash_units, cash_win_rates, load_game

SCOREBOARD_REVISION = "pokerbench-scoreboard-v1"
VARIANT = "no-limit/cash"


def series_game_dirs(results_dir: str | Path) -> list[Path]:
    """Finished no-limit cash series games: the relay's progress rule (relay.results_progress)."""
    out = []
    try:
        names = sorted(os.listdir(results_dir))
    except OSError:
        return []
    for name in names:
        d = Path(results_dir) / name
        try:
            run = json.loads((d / "run.json").read_text())
        except (OSError, ValueError):
            continue
        cfg = run.get("config") or {}
        if (run.get("status") == "finished" and cfg.get("series") and cfg.get("format") == "cash"
                and cfg.get("betting", "no-limit") == "no-limit"):
            out.append(d)
    return out


def split_entrant(entrant: str) -> tuple[str, str | None]:
    """"codex / gpt-6.2-astra / medium" -> ("gpt-6.2-astra", "medium"). The agent (harness)
    stays out: the public page is about the models."""
    parts = [p.strip() for p in entrant.split(" / ")]
    if len(parts) == 3:
        return parts[1], (None if parts[2] in ("", "unknown") else parts[2])
    return entrant, None


def scoreboard(results_dir: str | Path, n_boot: int = 1000, seed: int = 0, now: float | None = None) -> dict | None:
    """The scoreboard, or None with no finished series game yet."""
    games = [g for g in (load_game(d) for d in series_game_dirs(results_dir)) if g is not None and g.variant == VARIANT]
    if not games:
        return None
    units = cash_units(games)
    rates = cash_win_rates(units, n_boot, seed, VARIANT)
    bt = {r["entrant"]: r for r in bradley_terry_ratings(units, 1.0, 0, seed, VARIANT)}

    # Series in the order they were played, each with its own bb/100 per entrant.
    started = {g.id: g.started_at or g.id for g in games}
    by_unit = {g.id: g for g in games}
    units = sorted(units, key=lambda u: min(started[gid] for gid in u.sessions))
    series, per_series = [], []
    for u in units:
        info = next((by_unit[gid].series for gid in u.sessions if by_unit[gid].series), None) or {}
        series.append({"games": len(u.sessions), "of": info.get("games") or len(u.sessions)})
        net: dict[str, float] = {}
        hands: dict[str, int] = {}
        for group in u.groups.values():
            for seat, (n, h) in group.items():
                e = u.entrants[seat]
                net[e] = net.get(e, 0.0) + n
                hands[e] = hands.get(e, 0) + h
        per_series.append({e: round(100 * net[e] / hands[e], 2) for e in net if hands[e]})

    models = []
    for r in rates:
        model, effort = split_entrant(r["entrant"])
        b = bt.get(r["entrant"]) or {}
        models.append({
            "model": model, "effort": effort,
            "bb_per_100": r["bb_per_100"], "ci95": r["ci95"], "method": r["method"],
            "hands": r["hands"], "games": r["games"],
            "series": [s.get(r["entrant"]) for s in per_series],
            "bt": b.get("rating"),
        })
    t = datetime.now(timezone.utc) if now is None else datetime.fromtimestamp(now, timezone.utc)
    return {
        "revision": SCOREBOARD_REVISION, "variant": VARIANT, "as_of": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "games": len(games), "hands": max((m["hands"] for m in models), default=0),
        "series": series, "models": models,
    }
