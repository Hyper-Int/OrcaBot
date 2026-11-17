# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-identity-v1-peer-uid
"""Which OS user is on the other end of a loopback connection.

The engine binds each seat to the Linux UID that first used it. That makes a
stolen token useless from another user, lets seats in Orcabot's PTY pool (one
UID per terminal) join without any shared secret, and tells us whether seat
isolation is actually enforced for a run.

Every loopback TCP socket is listed in /proc/net/tcp{,6} with its owner UID, and
those files are world-readable, so no privilege is needed. The client's socket
is the row whose local port is the client port and whose remote port is ours.
"""

from __future__ import annotations

IDENTITY_REVISION = "pokerbench-identity-v1-peer-uid"
PROC_NET_TCP = ("/proc/net/tcp", "/proc/net/tcp6")


def _port(addr: str) -> int:
    return int(addr.rsplit(":", 1)[1], 16)


def parse_peer_uid(table: str, client_port: int, server_port: int) -> int | None:
    """Find the UID owning the socket client_port -> server_port in a /proc/net/tcp dump."""
    for line in table.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 8:
            continue
        try:
            if _port(parts[1]) == client_port and _port(parts[2]) == server_port:
                return int(parts[7])
        except ValueError:
            continue
    return None


def peer_uid(client_port: int, server_port: int, files=PROC_NET_TCP) -> int | None:
    """UID of the loopback client, or None where /proc is unavailable (e.g. macOS)."""
    for path in files:
        try:
            with open(path, encoding="ascii") as f:
                uid = parse_peer_uid(f.read(), client_port, server_port)
        except OSError:
            continue
        if uid is not None:
            return uid
    return None
