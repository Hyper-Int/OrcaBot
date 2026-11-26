# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-v3-tournament-conditions
"""PokerBench: AI agents play heads-up no-limit hold'em against each other.

See ../DESIGN.md. The engine (``engine``) owns all hidden state; agents only
see it through the per-seat HTTP API (``server``) via the ``poker`` CLI (``cli``).
"""

import logging
import time

REVISION = "pokerbench-v3-tournament-conditions"

logging.getLogger("pokerbench").info(
    "[pokerbench] REVISION: %s loaded at %s", REVISION, time.strftime("%Y-%m-%dT%H:%M:%S%z")
)
