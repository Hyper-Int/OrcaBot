// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: markdown-chart-v1
// Lets benchmark markdown place an interactive chart inline with a fenced block:
//
//     ```chart
//     cost-accuracy
//     ```
//
// A code fence is used rather than an <img> or raw HTML because react-markdown
// strips raw HTML (no rehype-raw) and URL-sanitizes image srcs, so a custom
// scheme would not survive. The fence carries no HTML and cannot inject.

import * as React from "react";
import { CostAccuracyChart } from "./CostAccuracyChart";
import { CheckpointErosionChart } from "./CheckpointErosionChart";
import { TtsResultsTable } from "./TtsResultsTable";
import { TtsPreferenceChart } from "./TtsPreferenceChart";
import { TtsErrorCostChart } from "./TtsErrorCostChart";
import { TtsVendorList } from "./TtsVendorList";

const CHARTS: Record<string, React.ComponentType> = {
  "cost-accuracy": CostAccuracyChart,
  "checkpoint-erosion": CheckpointErosionChart,
  "tts-results": TtsResultsTable,
  "tts-error-cost": TtsErrorCostChart,
  "tts-vendors": TtsVendorList,
  // Renders nothing until enough engines have a human rating.
  "tts-preference": TtsPreferenceChart,
};

export function MarkdownChart({ id }: { id: string }) {
  const Chart = CHARTS[id];
  if (!Chart) {
    // Unknown id: say so loudly in dev, render nothing in prod, never crash the page.
    if (process.env.NODE_ENV !== "production") {
      return (
        <div style={{ padding: "1rem", border: "1px dashed #d95926", color: "#d95926", fontSize: "0.85rem" }}>
          Unknown chart id: <code>{id}</code>
        </div>
      );
    }
    return null;
  }
  return <Chart />;
}

// NOTE: the "is this a chart fence?" predicate deliberately lives in the SERVER
// page, not here. Everything exported from a "use client" module becomes a client
// reference, so a plain helper exported alongside the component cannot be called
// during server render; it fails with "Attempted to call isChartFence() from the
// server but isChartFence is on the client".
