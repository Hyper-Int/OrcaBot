# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-agentlink-v4-retry
"""Agent seats in Orcabot: an Agent block (an outside agent such as Grok Bot, Muse or
Dots, linked to the dashboard owner) connected to the table's engine terminal plays
a seat.

The table asks Orcabot's sandbox which agents the engine terminal is connected to
(edges on the canvas; the sandbox asks the control plane), and seats each one. A seat
messages its agent through the sandbox's local agent API, which only serves agents
the calling terminal is connected to:

- pool mode (each terminal its own OS user): the privileged Unix socket
  ``/run/orcabot/privileged.sock``, which identifies the terminal by its UID;
- otherwise: ``http://127.0.0.1:$ORCABOT_MCP_PORT/sessions/$ORCABOT_SESSION_ID/ptys/
  $ORCABOT_PTY_ID/agents/...`` with ``X-MCP-Secret: $ORCABOT_MCP_SECRET``.

Messages are end-to-end encrypted between the dashboard and the agent; the engine
never holds keys. Agents answer from their own computers, so seats need a generous
turn timeout (seconds for Grok, a minute or two for agents that poll).
"""

from __future__ import annotations

import http.client
import json
import os
import socket
import time
import urllib.parse
from collections.abc import Iterator

from .chatseat import ChatSeat
from .llm import ProviderError

AGENTLINK_REVISION = "pokerbench-agentlink-v4-retry"
PRIVILEGED_SOCK = "/run/orcabot/privileged.sock"


class SandboxError(ProviderError):
    """The sandbox refused or failed a request (status is its HTTP status, 0 if unreachable)."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


class AgentLinkClient:
    """The sandbox's agent API for this terminal (the one this process runs in)."""

    def __init__(self, sock: str = PRIVILEGED_SOCK, env: dict | None = None):
        env = os.environ if env is None else env
        self.sock = sock if os.path.exists(sock) else None
        self.session, self.pty = env.get("ORCABOT_SESSION_ID", ""), env.get("ORCABOT_PTY_ID", "")
        self.secret = env.get("ORCABOT_MCP_SECRET", "")
        self.port = int(env.get("ORCABOT_MCP_PORT") or 8081)
        if not self.sock and not (self.session and self.pty and self.secret):
            raise SystemExit("Not in an Orcabot terminal: agent seats need Orcabot's sandbox "
                             "(no privileged socket and no ORCABOT_SESSION_ID/ORCABOT_PTY_ID/ORCABOT_MCP_SECRET).")

    def _request(self, method: str, action: str, query: dict | None = None, body: dict | None = None,
                 timeout: float = 30.0, resource: str = "agents") -> dict:
        qs = ("?" + urllib.parse.urlencode(query)) if query else ""
        suffix = f"/{action}" if action else ""
        if self.sock:
            conn = _UnixHTTPConnection(self.sock, timeout)
            path = f"/{resource}{suffix}{qs}"
            headers = {}
        else:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
            path = f"/sessions/{self.session}/ptys/{self.pty}/{resource}{suffix}{qs}"
            headers = {"X-MCP-Secret": self.secret}
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        try:
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
            raw = resp.read() or b"{}"
        except (OSError, http.client.HTTPException) as e:
            raise SandboxError(f"{resource}: {e}") from None
        finally:
            conn.close()
        try:
            payload = json.loads(raw)
        except ValueError:  # the sandbox's plain-text errors ("E79993: ...")
            payload = {"error": raw.decode("utf-8", "replace").strip()[:200]}
        if resp.status >= 300:
            raise SandboxError(f"{resource}: {payload.get('error') or resp.status}", status=resp.status)
        return payload

    def links(self) -> dict:
        """The terminals this terminal is linked to on the canvas:
        {"terminals": [{itemId, name, ptyId, uid?}], "pool": bool}. uid only in Orcabot's
        PTY pool (each terminal its own OS user)."""
        return self._request("GET", "", resource="links", timeout=15)

    def agents(self) -> list[dict]:
        """The agents this terminal is connected to: [{identity, name, itemId}]."""
        return self._request("GET", "")["agents"]

    def send(self, agent: str, text: str, retry_for: float = 0.0) -> int:
        """Send a message; for up to retry_for seconds, try again while the sandbox or the
        control plane behind it is briefly unavailable (a 20-second hiccup on 2026-11-20
        cost every Agent block three hands)."""
        give_up = time.monotonic() + retry_for
        pause = 1.0
        while True:
            try:
                return int(self._request("POST", "send", body={"agent": agent, "text": text}, timeout=60)["seq"])
            except SandboxError as e:
                if not transient(e) or time.monotonic() + pause > give_up:
                    raise
                time.sleep(pause)
                pause = min(pause * 2, 8.0)

    def messages(self, agent: str, after: int, wait: int) -> list[dict]:
        r = self._request("GET", "messages", {"agent": agent, "after": after, "wait": wait}, timeout=wait + 15)
        return r.get("messages") or []


def transient(e: SandboxError) -> bool:
    """Worth trying again: the sandbox didn't answer, or couldn't reach the control plane
    (E79965, 502) or was briefly unavailable. Refusals (4xx) aren't."""
    return e.status == 0 or e.status in (502, 503, 504)


class AgentLinkSeat(ChatSeat):
    """A seat played by the outside agent of an Agent block connected to this terminal."""

    name = "agent"

    def __init__(self, agent: str, reply_timeout: float | None = None, client: AgentLinkClient | None = None):
        super().__init__(agent, reply_timeout)
        self.client = client or AgentLinkClient()
        self.after = 0

    def _post(self, text: str) -> None:
        # Keep trying through a short outage, but leave time to answer.
        left = self._seconds_left() or self.turn_limit
        self.after = self.client.send(self.agent, text, retry_for=max(0.0, min(60.0, left - 15)))

    def _replies(self, deadline: float) -> Iterator[str]:
        while (left := deadline - time.monotonic()) > 1:
            try:
                got = self.client.messages(self.agent, self.after, int(min(left, 60)))
            except SandboxError as e:
                if not transient(e):
                    raise
                time.sleep(min(2.0, max(0.0, left - 1)))  # a hiccup: keep waiting for the answer
                continue
            for m in got:
                self.after = max(self.after, int(m.get("seq") or 0))
                if m.get("from") == "agent":
                    yield m.get("text") or ""

    def _pending(self) -> list[str]:
        out = []
        for m in self.client.messages(self.agent, self.after, 0):
            self.after = max(self.after, int(m.get("seq") or 0))
            if m.get("from") == "agent":
                out.append(m.get("text") or "")
        return out
