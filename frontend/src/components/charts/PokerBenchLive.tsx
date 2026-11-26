// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: pokerbench-live-v3-boundary-note
// The PokerBench table, live but delayed, embedded in the benchmark page
// (```chart pokerbench-live```). The table itself is served by the PokerBench relay
// Worker (benchmarks/pokerbench/relay-worker) on its own host. A series deals the same
// cards in every game, so the relay only ever publishes the game being played (never the
// last one's cards: pokerbench/relay.py). This page carries only the frame.

import * as React from "react";

// NEXT_PUBLIC_POKERBENCH_LIVE_URL: another table, e.g. the relay Worker under `wrangler dev`.
export const POKERBENCH_LIVE_URL =
  process.env.NEXT_PUBLIC_POKERBENCH_LIVE_URL || "https://pokerbench.orcabot.com/tables/pokerbench";
/** The table's latest public snapshot (JSON, CORS-open), for the headline chart's progress. */
export const POKERBENCH_STATE_URL = `${POKERBENCH_LIVE_URL}/state`;

const MODULE_REVISION = "pokerbench-live-v3-boundary-note";
console.log(`[pokerbench-live] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

export function PokerBenchLive() {
  return (
    <figure style={{ margin: "1.5rem 0" }}>
      <iframe
        src={POKERBENCH_LIVE_URL}
        title="PokerBench live table"
        loading="lazy"
        referrerPolicy="no-referrer"
        // Its own origin (a different host), scripts to poll the table; nothing else.
        sandbox="allow-scripts allow-same-origin"
        style={{
          display: "block",
          width: "100%",
          height: "min(88vh, 960px)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          background: "#0e1512",
        }}
      />
      <figcaption style={{ fontSize: "0.8rem", color: "var(--foreground-subtle)", marginTop: "0.5rem" }}>
        Delayed by two minutes. Hole cards appear only when a hand reaches showdown.{" "}
        <a href={POKERBENCH_LIVE_URL} target="_blank" rel="noopener noreferrer">
          Open the table on its own
        </a>
        .
      </figcaption>
    </figure>
  );
}
