# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-host-v1-linked-seats
"""The engine terminal's host (``pokerbench host``): keeps the table in step with the
canvas while the engine runs.

- In the lobby, every terminal and Agent block linked to the engine terminal is a seat:
  linking one seats it, unlinking it (or renaming the terminal) takes the seat away.
  A seat terminal's seat is named after the terminal; in Orcabot's PTY pool it is bound
  to the terminal's own OS user, so no other terminal can play it.
- Publishes ``seats.json`` (which seat each terminal plays) and ``engine.env`` for the
  seat terminals, which run bin/seat.
- Agent blocks are played from here, by chat (``pokerbench agent-seat``).
- At the start: renders the agents' prompt for the players and the condition chosen on
  the table page, then tells the seats (POKER_STARTED=1).
- During the game: a seat terminal that restarts gets a new PTY user; it is rebound so
  it can play on.

SEATS (optional) adds seats that aren't linked, for terminals Orcabot can't report
links for (an older sandbox) or runs outside Orcabot.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .players import seat_name

HOST_REVISION = "pokerbench-host-v1-linked-seats"


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".new")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


class Engine:
    """The engine's HTTP API, as the engine's own user (control token)."""

    def __init__(self, url: str, control_token: str):
        self.url, self.control = url.rstrip("/"), control_token

    def call(self, method: str, path: str, body: dict | None = None, timeout: float = 10.0) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method,
                                     headers={"X-Poker-Control": self.control, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            try:
                return {"error": True, **json.load(e)}
            except ValueError:
                return {"error": True, "message": str(e)}

    def spectate(self) -> dict | None:
        try:
            return self.call("GET", "/api/spectate", timeout=5)
        except (OSError, ValueError):
            return None


def linked_seats(links: list[dict], agents: list[dict], static: tuple[str, ...] = ()) -> dict[str, dict]:
    """Seat name -> what it is, for everything linked to the engine. Deterministic, so the
    same canvas always gives the same names: terminals in name order, then Agent blocks."""
    seats: dict[str, dict] = {s: {"kind": "static"} for s in static}
    taken = set(seats)
    for t in sorted(links, key=lambda t: ((t.get("name") or "").lower(), t.get("itemId") or "")):
        seat = seat_name(t.get("name") or "", taken)
        taken.add(seat)
        seats[seat] = {"kind": "terminal", "item": t.get("itemId"), "pty": t.get("ptyId") or "",
                       "uid": t.get("uid"), "name": t.get("name") or ""}
    for a in sorted(agents, key=lambda a: ((a.get("name") or "").lower(), a.get("identity") or "")):
        seat = seat_name(a.get("name") or "agent", taken)
        taken.add(seat)
        seats[seat] = {"kind": "agent", "identity": a["identity"], "name": a.get("name") or ""}
    return seats


class Host:
    def __init__(self, engine: Engine, pub: Path, tokens_dir: Path, run_dir: Path, game: str, pb: str,
                 static_seats: tuple[str, ...] = (), sandbox=None, say=print, engine_alive=lambda: True):
        self.engine, self.pub, self.tokens_dir, self.run_dir = engine, Path(pub), Path(tokens_dir), Path(run_dir)
        self.game, self.pb, self.static = game, pb, tuple(static_seats)
        self.sandbox = sandbox  # agentlink.AgentLinkClient, or None outside Orcabot
        self.say, self.engine_alive = say, engine_alive
        self.seats: dict[str, dict] = {s: {"kind": "static"} for s in self.static}  # last known
        self.links_ok = None  # None: not asked yet; False: this sandbox can't say
        self.bound: dict[str, int] = {}
        self.agent_procs: dict[str, subprocess.Popen] = {}
        self.started = False
        self.shown: dict[str, str] = {}
        self.env_seats: list[str] | None = None

    # -- what is linked ------------------------------------------------------------------
    def poll_links(self) -> None:
        """Refresh self.seats. A failed lookup keeps the last answer: a blip at the control
        plane must not unseat everyone."""
        if self.sandbox is None:
            return
        try:
            links = self.sandbox.links().get("terminals") or []
            if self.links_ok is not True:
                self.say("   Seating every terminal and Agent block linked to this engine terminal.")
            self.links_ok = True
        except Exception as e:  # noqa: BLE001 -- SandboxError, or an old sandbox without /links
            if getattr(e, "status", 0) in (404, 405) and self.links_ok is None:
                self.links_ok = False
                self.say("   This Orcabot can't tell the engine which terminals are linked to it (its sandbox"
                         " predates linked seats).\n   Set SEATS= in this terminal's settings to name the seat"
                         " terminals, or create the dashboard again later.")
            if self.links_ok is not False:
                return
            links = []
        try:
            agents = self.sandbox.agents()
        except Exception:  # noqa: BLE001
            agents = [{"identity": s["identity"], "name": s["name"]} for s in self.seats.values()
                      if s["kind"] == "agent"]
        self.seats = linked_seats(links, agents, self.static)

    # -- the lobby -------------------------------------------------------------------------
    def sync_lobby(self, st: dict) -> None:
        current = set(st.get("seats") or [])
        for seat, info in self.seats.items():
            if seat in current:
                continue
            player = {"kind": "agent", "name": info["name"]} if info["kind"] == "agent" else None
            out = self.engine.call("POST", "/api/table/seats", {"seat": seat, "uid": info.get("uid"), "player": player})
            if out.get("error"):
                self.say(f"   couldn't seat {seat}: {out.get('message')}")
                continue
            if info.get("uid") is not None:
                self.bound[seat] = info["uid"]
            what = f'terminal "{info["name"]}"' if info["kind"] == "terminal" else \
                f'Agent block {info["name"]}' if info["kind"] == "agent" else "from SEATS"
            self.say(f"   + {seat} ({what})")
        for seat in sorted(current - set(self.seats)):
            out = self.engine.call("POST", "/api/table/seats/remove", {"seat": seat})
            if not out.get("error"):
                self.say(f"   - {seat} (unlinked)")
                self.bound.pop(seat, None)
                self.stop_agent(seat)
        self.rebind()

    def rebind(self) -> None:
        """Seat terminals' OS users (a restarted terminal runs as a new pool user)."""
        for seat, info in self.seats.items():
            uid = info.get("uid")
            if info["kind"] == "terminal" and uid is not None and self.bound.get(seat) != uid:
                out = self.engine.call("POST", "/api/table/seats/bind", {"seat": seat, "uid": uid})
                if not out.get("error"):
                    self.bound[seat] = uid

    def publish(self, st: dict) -> None:
        """seats.json: which seat each linked terminal plays (read by bin/seat)."""
        by_pty = {i["pty"]: s for s, i in self.seats.items() if i["kind"] == "terminal" and i.get("pty")}
        by_item = {i["item"]: s for s, i in self.seats.items() if i["kind"] == "terminal" and i.get("item")}
        doc = {"game": self.game, "by_pty": by_pty, "by_item": by_item, "static": list(self.static)}
        text = json.dumps(doc, indent=1, sort_keys=True) + "\n"
        path = self.pub / "seats.json"
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            _write_atomic(path, text)
        seats = list(st.get("seats") or [])
        if seats != self.env_seats:
            self.write_env(seats, started=self.started)

    def write_env(self, seats: list[str], started: bool) -> None:
        env = (f"POKER_URL={self.engine.url}\nPOKER_TOKENS_DIR={self.tokens_dir}\nPOKER_GAME={self.game}\n"
               f'POKER_SEATS="{" ".join(seats)}"\nPOKER_STARTED={1 if started else 0}\nPOKER_PB={self.pb}\n')
        _write_atomic(self.pub / "engine.env", env)
        self.env_seats = seats

    def report(self, st: dict) -> None:
        """One line per seat when it changes: ready, or what it's waiting for."""
        status = st.get("seat_status") or {}
        for seat in st.get("seats") or []:
            label = (st.get("labels") or {}).get(seat, "")
            if seat in (st.get("joined") or []):
                line = f"ready{f' ({label})' if label else ''}"
            elif seat in status:
                line = status[seat].get("message") or status[seat].get("state", "")
            else:
                line = "not here yet"
            if self.shown.get(seat) != line:
                self.say(f"   {seat}: {line}")
                self.shown[seat] = line

    # -- Agent blocks ----------------------------------------------------------------------
    def ensure_agents(self, st: dict) -> None:
        seated = set(st.get("seats") or [])
        for seat, info in self.seats.items():
            if info["kind"] != "agent" or seat not in seated or seat in self.agent_procs:
                continue
            token = self.tokens_dir / f"{seat}.token"
            if not token.exists():
                continue
            cmd = [self.pb, "agent-seat", "--agent", info["identity"], "--seat", seat, "--token-file", str(token),
                   "--url", self.engine.url, "--log", str(self.run_dir / f"{seat}.calls.jsonl")]
            try:
                proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, text=True, bufsize=1)
            except OSError as e:
                if self.shown.get(f"agent:{seat}") != str(e):
                    self.say(f"   couldn't start agent seat {seat}: {e}")
                    self.shown[f"agent:{seat}"] = str(e)
                continue
            threading.Thread(target=self._relay, args=(seat, proc), daemon=True).start()
            self.agent_procs[seat] = proc
            self.say(f"   agent seat {seat}: {info['identity']}")

    def _relay(self, seat: str, proc: subprocess.Popen) -> None:
        for line in proc.stdout:
            self.say(f"[{seat}] {line.rstrip()}")

    def stop_agent(self, seat: str) -> None:
        proc = self.agent_procs.pop(seat, None)
        if proc and proc.poll() is None:
            proc.terminate()

    # -- the start ---------------------------------------------------------------------------
    def on_start(self, st: dict) -> None:
        from .main import prompt_text

        seats = list(st.get("seats") or [])
        settings = self.engine.call("GET", "/api/table/settings")
        condition, fmt = settings.get("condition", "neutral"), settings.get("format", st.get("format", "cash"))
        _write_atomic(self.pub / "prompt.txt", prompt_text(condition, max(2, len(seats)), fmt))
        self.started = True
        self.write_env(seats, started=True)
        for seat in list(self.agent_procs):
            if seat not in seats:
                self.stop_agent(seat)
        self.say(f"== Started: {' '.join(seats)}")
        if not settings.get("error"):
            extra = f", blinds up every {settings['level_hands']}" if fmt == "tournament" else ""
            self.say(f"   {fmt}, {settings['hands']} hands{extra}, condition {condition}, honeypots "
                     f"{settings['honeypots']}, {settings['turn_timeout']:g}s per decision, seed {settings['seed']}")

    # -- the loop -----------------------------------------------------------------------------
    def step(self) -> bool:
        """One pass. False once the engine is gone."""
        st = self.engine.spectate()
        if st is None:
            return self.engine_alive()
        self.poll_links()
        if st.get("status") == "waiting_for_players":
            self.sync_lobby(st)
            st = self.engine.spectate() or st
            self.publish(st)
            self.report(st)
        else:
            if not self.started:
                self.on_start(st)
            self.publish(st)
            self.rebind()
        self.ensure_agents(st)
        return True

    def run(self, interval: float = 2.0) -> None:
        try:
            while self.step():
                time.sleep(interval)
        finally:
            for seat in list(self.agent_procs):
                self.stop_agent(seat)


def cmd_host(args) -> int:
    from .agentlink import AgentLinkClient

    control = Path(args.control_token_file).read_text().strip()
    try:
        sandbox = AgentLinkClient()
    except SystemExit:
        sandbox = None  # not in Orcabot: SEATS only
    pid = args.engine_pid

    def alive() -> bool:
        if not pid:
            return False
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    static = tuple(s for s in (args.seats or "").replace(",", " ").split() if s)
    host = Host(Engine(args.url, control), Path(args.pub), Path(args.tokens_dir), Path(args.run_dir), args.game,
                args.pb or sys.executable.replace("python", "pokerbench"), static, sandbox,
                say=lambda line: print(line, flush=True), engine_alive=alive)
    print(f"[host] REVISION: {HOST_REVISION} loaded at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}", flush=True)
    host.run(args.interval)
    return 0
