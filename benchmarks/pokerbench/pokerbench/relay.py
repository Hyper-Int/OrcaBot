# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-relay-v6-user-agent
"""A delayed public copy of the table, for watching a game from outside Orcabot.

Every ``interval`` seconds the relay reads the engine's spectator view (/api/spectate:
public already, live hole cards never in it), keeps only what the table page draws, and
holds it for ``delay`` seconds before uploading it to the relay Worker (relay-worker/),
which serves it read-only. The delay means nothing on the public page is newer than
``delay`` seconds.

The upload key never reaches this process: it is an Orcabot secret, and the upload goes
through the sandbox's secrets broker ($POKERBENCH_RELAY_KEY_BROKER?target=https://...),
which adds it for the approved upload host only. Seats can't read the public page from
the VM if its host is denied on the dashboard ("Deny Always"); see README "Live page".

A series deals the same cards in every game (seats rotated), so a board from game 1 is
the board of that deal in games 2-10. The seats can reach the public page (they run as
their own users, outside the sandbox's egress control), so the page must never show a
board from another game of the series while one is being played: when a new game
starts, the snapshots still held from the last one are dropped, and until the new
game's are ``delay`` seconds old the page shows "next game starting", with no cards.
Within a game it shows only what every seat at the table has already seen.

    pokerbench relay --target https://relay.example.workers.dev/tables/pokerbench --delay 120
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timezone

RELAY_REVISION = "pokerbench-relay-v6-user-agent"

# What the table page draws; anything else in /api/spectate stays on the VM (seat kinds
# and models beyond the label, seat status messages, uids). A whitelist: a field added to
# the engine later is private until it is added here.
TOP = ("revision", "status", "paused", "turn_timeout", "seats", "labels", "joined", "hand", "hands_total",
       "big_blind", "format", "finish_reason", "hands_played", "resumes", "sitting_out", "sit_out_timeout",
       "resuming", "tournament", "leaderboard", "counters", "recent", "live", "series")
LAST_HAND = ("hand", "deal", "board", "net", "end_stacks", "showdown", "folded", "players", "hole", "actions")
MAX_BODY = 200_000  # the Worker refuses more


def model_label(label: str) -> str:
    """The model alone: "anthropic/claude-code (claude-opus-5-5)" -> "claude-opus-5-5",
    "google/antigravity-cli (Gemini 4 Neon (High))" -> "Gemini 4 Neon (High)". The public
    page is about the models; the agent each one plays through is in the write-up."""
    head, sep, rest = label.partition(" (")
    return rest[:-1] if sep and rest.endswith(")") else label


def public_view(spectate: dict) -> dict:
    out = {k: spectate[k] for k in TOP if k in spectate}
    if isinstance(out.get("labels"), dict):
        out["labels"] = {s: model_label(str(v)) for s, v in out["labels"].items()}
    # Lobby states without their messages ("Codex isn't signed in: type ...").
    out["seat_status"] = {s: {"state": v.get("state")} for s, v in (spectate.get("seat_status") or {}).items()
                          if isinstance(v, dict)}
    iso = spectate.get("isolation")
    if isinstance(iso, dict):
        out["isolation"] = {"enforced": bool(iso.get("enforced"))}
    last = spectate.get("last_hand")
    if isinstance(last, dict):
        out["last_hand"] = {k: last[k] for k in LAST_HAND if k in last}
    return out


def game_key(view: dict):
    """Which game a snapshot is from: (series, game) in a series, else None."""
    sr = view.get("series")
    return (sr.get("id"), sr.get("game")) if isinstance(sr, dict) else None


def starting_view(view: dict) -> dict:
    """A new game is starting: who is playing and the progress, but no cards or results."""
    out = {k: view[k] for k in ("revision", "seats", "labels", "hands_total", "big_blind", "format", "series",
                                "progress") if k in view}
    return {**out, "status": "waiting_for_players", "joined": list(view.get("seats") or []),
            "hands_played": 0, "leaderboard": [], "recent": [], "counters": {}}


class DelayBuffer:
    """Snapshots in, each one out once it is ``delay`` seconds old (the newest such)."""

    def __init__(self, delay: float):
        self.delay = delay
        self.items: deque[tuple[float, dict]] = deque()

    def push(self, t: float, item: dict) -> None:
        self.items.append((t, item))

    def due(self, now: float) -> tuple[float, dict] | None:
        ready = None
        while self.items and self.items[0][0] <= now - self.delay:
            ready = self.items.popleft()
        return ready


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def results_progress(results_dir: str, cache: dict) -> dict:
    """Hands per model played in finished games of no-limit cash series, from the results
    folder (one game per top-level folder; abandoned games live in a subfolder and don't
    count). A finished game never changes, so each is read once (``cache``)."""
    hands = games = 0
    try:
        names = sorted(os.listdir(results_dir))
    except OSError:
        return {"hands": 0, "games": 0}
    for name in names:
        if name not in cache:
            d = os.path.join(results_dir, name)
            try:
                with open(os.path.join(d, "run.json")) as f:
                    run = json.load(f)
            except (OSError, ValueError):
                continue
            cfg = run.get("config") or {}
            if run.get("status") != "finished":
                continue  # still being played (or broken): looked at again next time
            n = 0
            if cfg.get("series") and cfg.get("format") == "cash" and cfg.get("betting", "no-limit") == "no-limit":
                try:
                    with open(os.path.join(d, "hand_results.jsonl")) as f:
                        n = sum(1 for line in f if line.strip())
                except OSError:
                    n = 0
            cache[name] = n
        if cache[name]:
            hands += cache[name]
            games += 1
    return {"hands": hands, "games": games}


def upload_url(broker: str, target: str) -> str:
    return f"{broker}?{urllib.parse.urlencode({'target': target})}"


def run(engine: str, target: str, broker: str, delay: float, interval: float = 2.0,
        clock=time.time, sleep=time.sleep, rounds: int | None = None, log=print,
        results_dir: str = "/workspace/pokerbench-results") -> None:
    """Poll, delay, upload until stopped (``rounds``: for tests). Never raises on a
    failed read or upload: the engine and the game don't depend on it."""
    buf, sent, n, seen, game = DelayBuffer(delay), None, 0, {}, None
    url = upload_url(broker, target)
    log(f"[relay] REVISION: {RELAY_REVISION} loaded at {_iso(clock())}: {engine} -> {target}, {delay:g}s behind")
    while rounds is None or n < rounds:
        n += 1
        now = clock()
        try:
            with urllib.request.urlopen(f"{engine}/api/spectate", timeout=5) as r:
                # Progress across finished series games (the benchmark's hand count), as
                # of this snapshot. REVISION: pokerbench-relay-v4-progress
                view = {**public_view(json.load(r)), "progress": results_progress(results_dir, seen)}
            key = game_key(view)
            if game is not None and key != game:
                # A new game: drop the last game's snapshots (its cards come round again in
                # this one) and say so now. REVISION: pokerbench-relay-v5-game-boundary
                buf.items.clear()
                buf.push(now - delay, starting_view(view))
                log(f"[relay] {_iso(now)} game {key} started: last game's snapshots dropped")
            game = key
            buf.push(now, view)
        except (OSError, ValueError):
            pass  # between games of a series the engine is down for a few seconds
        ready = buf.due(now)
        if ready is not None:
            t, view = ready
            if view != sent:
                body = json.dumps({**view, "relay": {"as_of": _iso(t), "delay_s": delay}}).encode()
                if len(body) > MAX_BODY:
                    log(f"[relay] snapshot of {len(body)} bytes is over {MAX_BODY}: not sent")
                else:
                    # Its own User-Agent: Cloudflare refuses Python's default one (error 1010)
                    # before the Worker sees it. REVISION: pokerbench-relay-v6-user-agent
                    req = urllib.request.Request(url, data=body, method="PUT", headers={
                        "Content-Type": "application/json", "User-Agent": f"pokerbench-relay/{RELAY_REVISION}"})
                    try:
                        with urllib.request.urlopen(req, timeout=10) as r:
                            r.read()
                        sent = view
                    except urllib.error.HTTPError as e:
                        log(f"[relay] upload refused: {e.code} {e.read()[:200]!r}")
                    except OSError as e:
                        log(f"[relay] upload failed: {e}")
        sleep(interval)


def main(args) -> int:
    broker = os.environ.get("POKERBENCH_RELAY_KEY_BROKER", "")
    if not broker:
        print("[relay] POKERBENCH_RELAY_KEY_BROKER isn't set: add POKERBENCH_RELAY_KEY as a secret in Orcabot "
              "(the upload key; the broker adds it) and restart this terminal. Not relaying.", file=sys.stderr)
        return 1
    if not args.target.startswith("https://"):
        print("[relay] --target must be an https:// URL", file=sys.stderr)
        return 1
    run(args.engine, args.target, broker, args.delay, args.interval, results_dir=args.results)
    return 0
