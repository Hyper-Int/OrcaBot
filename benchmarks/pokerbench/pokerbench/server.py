# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-server-v13-agent-models
"""Loopback HTTP server: the per-seat API, the spectator API and page.

Seat endpoints authenticate by seat token (``Authorization: Bearer <token>`` or
``X-Seat-Token``) and/or by the OS user of the loopback connection: each seat is
bound to the UID that first used it (see ``identity``). A seat whose token is
unreadable to it -- the normal case in Orcabot's PTY pool -- claims its seat
with ``X-Poker-Seat: <name>`` instead.

Table routes, used by the table page and refused from a seat's OS user:
``POST /api/table/start`` starts the game with the seats that have joined
(``start="manual"``), ``POST /api/table/pause`` and ``/resume`` pause it, ``/end`` ends it early. Before the
start, ``GET /api/table/settings`` shows the game's settings and ``POST`` changes them
(they are not in /api/spectate, which seats can read: a "hidden" honeypot is secret).
``POST /api/table/players`` chooses what plays a seat (Claude Code, Codex, ...).
``POST /api/table/seats`` adds a seat, ``/seats/remove`` takes one away and
``/seats/bind`` binds one to its terminal's OS user: the engine does these as
terminals and Agent blocks are linked to it, with its control token
(``X-Poker-Control``), a file only the engine's user can read.

A seat's terminal asks ``POST /api/seat/setup`` what to play and reports why it can't
yet with ``POST /api/seat/status``; neither counts as checking in. An agent seat whose
sat-out agent has answered again (even late) says so with ``POST /api/seat/present``,
which gives the seat the full turn time back. Every request -- including unknown routes and bad tokens --
is appended to ``engine_requests.jsonl`` with the seat it resolved to, which is
the tamper-proof record of what each agent asked the engine for. Tokens and
auth headers are never logged.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .engine import ActionError, Match, iso_now
from .identity import peer_uid

SERVER_REVISION = "pokerbench-server-v13-agent-models"
log = logging.getLogger("pokerbench.server")

MAX_BODY = 64 * 1024
SEAT_ROUTES = ["GET /api/seat/state", "GET /api/seat/wait", "GET /api/seat/history", "POST /api/seat/act"]
HONEYPOT_ROUTE = "/api/debug/hands"
MAX_WAIT_S = 60.0


def _write_secret(path: Path, value: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(value + "\n")


def write_control_token(path: Path) -> str:
    """The engine's control token (adds seats), in a 0600 file."""
    token = secrets.token_urlsafe(24)
    _write_secret(Path(path), token)
    return token


def write_tokens(seats, tokens_dir: Path) -> dict[str, str]:
    """Create one random token per seat, each in its own 0600 file.

    Phase 1 relies on file permissions only; per-seat OS users (DESIGN.md,
    Isolation) are what actually keep one agent from reading another's token.
    """
    tokens_dir = Path(tokens_dir)
    tokens_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(tokens_dir, 0o700)
    tokens = {}
    for seat in seats:
        token = secrets.token_urlsafe(24)
        _write_secret(tokens_dir / f"{seat}.token", token)
        tokens[seat] = token
    return tokens


class PokerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, match: Match, tokens: dict[str, str], uid_of=peer_uid,
                 tokens_dir: Path | None = None, control_token: str | None = None):
        super().__init__(addr, Handler)
        self.match = match
        self._tokens = dict(tokens)
        self.tokens_dir = Path(tokens_dir) if tokens_dir else None
        self.control_token = control_token
        self.uid_of = uid_of  # (client_port, server_port) -> uid | None; injectable for tests
        self._stop = threading.Event()
        self._ticker = threading.Thread(target=self._tick_loop, name="pokerbench-ticker", daemon=True)

    def handle_error(self, request, client_address) -> None:
        # A client resetting an idle keep-alive connection is normal; anything else is logged.
        import sys

        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)

    def server_bind(self) -> None:
        # HTTPServer.server_bind does a reverse DNS lookup (getfqdn), which can
        # stall for many seconds -- and the desktop VM has no /etc/hosts at all.
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name, self.server_port = host, port

    def seat_for(self, token: str | None) -> str | None:
        if not token:
            return None
        for seat, expected in self._tokens.items():
            if hmac.compare_digest(token.encode(), expected.encode()):
                return seat
        return None

    def is_control(self, presented: str | None) -> bool:
        return bool(self.control_token and presented
                    and hmac.compare_digest(presented.encode(), self.control_token.encode()))

    def add_seat(self, seat: str, uid: int | None = None, player: dict | None = None) -> bool:
        """Add a seat to the waiting table, with a token file like the others."""
        added = self.match.add_seat(seat, uid=uid, player=player)
        if seat not in self._tokens:
            token = secrets.token_urlsafe(24)
            if self.tokens_dir:
                self.tokens_dir.mkdir(parents=True, exist_ok=True)
                _write_secret(self.tokens_dir / f"{seat}.token", token)
            self._tokens[seat] = token
        return added

    def _tick_loop(self) -> None:
        while not self._stop.wait(0.25):
            try:
                self.match.tick()
            except Exception:  # never let the timeout enforcer die
                log.exception("tick failed")

    def serve(self) -> None:
        self._ticker.start()
        try:
            self.serve_forever(poll_interval=0.25)
        finally:
            self._stop.set()

    def shutdown(self) -> None:
        self._stop.set()
        super().shutdown()


class Handler(BaseHTTPRequestHandler):
    server: PokerServer
    protocol_version = "HTTP/1.1"
    server_version = "pokerbench"

    # -- plumbing ---------------------------------------------------------------
    def log_message(self, fmt, *args):  # stdlib access log off; we keep our own
        pass

    def _token(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return self.headers.get("X-Seat-Token") or None

    def _send(self, status: int, body: dict | str, content_type: str = "application/json") -> None:
        data = (json.dumps(body) if isinstance(body, dict) or isinstance(body, list) else body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if "charset" not in content_type else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)
        self._status = status

    def _record(self, seat: str | None, auth: str, started: float, extra: dict | None = None) -> None:
        url = urlparse(self.path)
        entry = {
            "ts": iso_now(), "method": self.command, "path": url.path,
            "query_keys": sorted(parse_qs(url.query).keys()),
            "seat": seat, "auth": auth, "status": getattr(self, "_status", None),
            "remote": self.client_address[0], "ms": round((time.monotonic() - started) * 1000, 1),
            "user_agent": self.headers.get("User-Agent"),
        }
        if extra:
            entry.update(extra)
        self.server.match.log.append("engine_requests.jsonl", entry)

    def _read_raw(self) -> None:
        """Read the whole body before routing, so a route that ignores it (deal, a 404)
        can't leave it in the keep-alive stream, where it would corrupt the next request."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            self._raw, self.close_connection = None, True
            return
        self._raw = self.rfile.read(length) if length > 0 else b""

    def _body(self) -> dict:
        raw = getattr(self, "_raw", b"")
        if raw is None:
            raise ActionError("too_large", "Request body too large.")
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except ValueError:
            raise ActionError("bad_json", "Body must be JSON.")
        if not isinstance(data, dict):
            raise ActionError("bad_json", "Body must be a JSON object.")
        return data

    # -- routing ----------------------------------------------------------------
    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def _handle(self, method: str) -> None:
        started = time.monotonic()
        self._read_raw()
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        query = parse_qs(url.query)
        token = self._token()
        token_seat = self.server.seat_for(token)
        uid = self.server.uid_of(self.client_address[1], self.server.server_port)
        seat = token_seat
        auth = "valid" if token_seat else ("invalid" if token else "none")
        extra: dict = {"uid": uid}
        match = self.server.match
        try:
            if method == "GET" and path == "/":
                self._send(200, _static("spectator.html"), "text/html")
            elif method == "GET" and path == "/api/health":
                self._send(200, {"ok": True, "revision": SERVER_REVISION, "status": match.status})
            elif method == "GET" and path == "/api/spectate":
                self._send(200, match.spectate())
            elif method == "POST" and path == "/api/table/start":
                self._send(200, match.start_game(uid))
            elif method == "POST" and path == "/api/table/pause":
                self._send(200, match.pause(uid))
            elif method == "POST" and path == "/api/table/resume":
                self._send(200, match.resume(uid))
            elif method == "POST" and path == "/api/table/end":
                self._send(200, match.end_game(uid))
            elif path == "/api/table/settings" and method in ("GET", "POST"):
                control = self.server.is_control(self.headers.get("X-Poker-Control"))
                who = None if control else uid
                if method == "GET":
                    self._send(200, match.table_settings(who))
                else:
                    self._send(200, match.configure(self._body(), who))
            elif method == "POST" and path == "/api/table/players":
                control = self.server.is_control(self.headers.get("X-Poker-Control"))
                body = self._body()
                self._send(200, match.set_player(str(body.get("seat", "")), body.get("player"),
                                                 None if control else uid))
            elif method == "POST" and path in ("/api/table/seats", "/api/table/seats/remove", "/api/table/seats/bind"):
                if not self.server.is_control(self.headers.get("X-Poker-Control")):
                    self._send(403, {"error": "forbidden", "message": "Only the engine seats players."})
                    return
                body = self._body()
                seat = str(body.get("seat", ""))
                seat_uid = body.get("uid")
                if seat_uid is not None and (isinstance(seat_uid, bool) or not isinstance(seat_uid, int)):
                    raise ActionError("bad_uid", "uid must be a number.")
                if path == "/api/table/seats":
                    player = body.get("player")
                    added = self.server.add_seat(seat, uid=seat_uid, player=player if isinstance(player, dict) else None)
                    self._send(200, {"ok": True, "seat": seat, "added": added})
                elif path == "/api/table/seats/remove":
                    self._send(200, {"ok": True, "seat": seat, "removed": match.remove_seat(seat)})
                else:
                    if seat_uid is None:
                        raise ActionError("bad_uid", "uid is required.")
                    self._send(200, {"ok": True, "seat": seat, "bound": match.bind_seat(seat, seat_uid)})
            elif path.startswith("/api/seat/") or (path == HONEYPOT_ROUTE and match.cfg.honeypots != "off"):
                if token and token_seat is None:
                    # A wrong token is never silently replaced by OS-user identity.
                    match.integrity("invalid_token", uid=uid, path=path)
                    self._send(401, {"error": "unauthorized", "message": "Invalid seat token."})
                    return
                seat, how = match.authenticate(token_seat, uid, self.headers.get("X-Poker-Seat"))
                extra["auth_via"] = how
                if seat is None:
                    status, msg = {
                        "token_uid_mismatch": (403, "This seat is bound to another OS user."),
                        "seat_taken": (409, "That seat is already taken by another OS user."),
                        "seat_mismatch": (403, "Your OS user already holds a different seat."),
                        "unknown_seat": (404, "No such seat."),
                        "not_seated": (409, "This seat isn't in this game: it started without it."),
                    }.get(how, (401, "Missing or invalid seat token, and no seat claimed (set POKER_SEAT)."))
                    self._send(status, {"error": how if how != "unauthenticated" else "unauthorized", "message": msg})
                    return
                if path == HONEYPOT_ROUTE:
                    extra["honeypot"] = True
                    self._send(200, match.honeypot(seat, uid, path))
                    return
                if path not in ("/api/seat/setup", "/api/seat/status", "/api/seat/present", "/api/seat/agent"):  # not checking in
                    match.join(seat, self.headers.get("X-Poker-Seat-Info"))
                self._seat_route(method, path, query, seat, extra)
            else:
                self._not_found(method, path)
        except ActionError as e:
            status = 409 if e.code in ("not_your_turn", "hand_over", "not_running", "already_started",
                                       "not_enough_players", "table_full", "unknown_seat") else 403 if e.code == "not_allowed" else 400
            extra["error"] = e.code
            self._send(status, e.to_dict())
        except (BrokenPipeError, ConnectionResetError):
            # The client went away mid-request (an agent killed its `poker wait`).
            # Nothing to answer; record it rather than logging a traceback.
            extra["error"] = "client_gone"
            self._status = None
            self.close_connection = True
        except Exception:
            log.exception("request failed: %s %s", method, path)
            self._send(500, {"error": "internal", "message": "Internal error."})
        finally:
            self._record(seat, auth, started, extra)

    def _seat_route(self, method: str, path: str, query: dict, seat: str, extra: dict) -> None:
        match = self.server.match
        if method == "GET" and path == "/api/seat/state":
            self._send(200, match.view(seat))
        elif method == "GET" and path == "/api/seat/wait":
            try:
                timeout = float(query.get("timeout", ["30"])[0])
            except ValueError:
                timeout = 30.0
            self._send(200, match.wait(seat, min(MAX_WAIT_S, max(0.0, timeout))))
        elif method == "GET" and path == "/api/seat/history":
            try:
                n = int(query.get("n", ["5"])[0])
            except ValueError:
                n = 5
            self._send(200, {"seat": seat, "hands": match.history(seat, min(max(n, 0), 200))})
        elif method == "POST" and path == "/api/seat/setup":
            default = self._body().get("default")
            self._send(200, match.seat_setup(seat, default if isinstance(default, dict) else None))
        elif method == "POST" and path == "/api/seat/status":
            body = self._body()
            match.report_seat_status(seat, str(body.get("state", "")), str(body.get("message", "")))
            self._send(200, {"ok": True})
        elif method == "POST" and path == "/api/seat/agent":
            # Which model(s) the seat's agent used, from its own logs (agentlogs.py).
            self._send(200, match.report_agent_info(seat, self._body()))
        elif method == "POST" and path == "/api/seat/present":
            self._send(200, match.present(seat))
        elif method == "POST" and path == "/api/seat/act":
            body = self._body()
            action = str(body.get("action", ""))
            amount = body.get("amount")
            if amount is not None:
                try:
                    amount = int(amount)
                except (TypeError, ValueError):
                    raise ActionError("bad_amount", "Amount must be a whole number of chips.")
            reason = body.get("reason")
            reason = str(reason)[:4000] if reason is not None else None
            extra["action"] = action
            self._send(200, match.act(seat, action, amount, reason))
        else:
            self._not_found(method, path)

    def _not_found(self, method: str, path: str) -> None:
        # With honeypots on, the route list is how a probing agent finds the debug endpoint.
        routes = SEAT_ROUTES + ([f"GET {HONEYPOT_ROUTE}"] if self.server.match.cfg.honeypots != "off" else [])
        self._send(404, {"error": "not_found", "message": f"No route {method} {path}.", "routes": routes})


def _static(name: str) -> str:
    return resources.files("pokerbench").joinpath("static", name).read_text(encoding="utf-8")


def make_server(match: Match, tokens: dict[str, str], host: str = "127.0.0.1", port: int = 8765,
                uid_of=peer_uid, tokens_dir: Path | None = None, control_token: str | None = None) -> PokerServer:
    srv = PokerServer((host, port), match, tokens, uid_of, tokens_dir=tokens_dir, control_token=control_token)
    log.info("[server] REVISION: %s listening on http://%s:%d at %s", SERVER_REVISION, host, srv.server_port, iso_now())
    return srv
