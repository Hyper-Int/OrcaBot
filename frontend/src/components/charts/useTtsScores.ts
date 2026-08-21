// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-scores-hook-v1
// Live human ratings, shared by the results table and the preference chart.
//
// Both mount on the same page and both want the same endpoint. They fetch
// independently rather than through a context: /tts/scores is public and sends
// Cache-Control max-age=60, so the second request is served from the browser
// cache, and keeping them independent means neither has to exist for the other
// to work.

import * as React from "react";
import { fetchTtsScores } from "@/lib/api/cloudflare/tts";

export interface TtsScoreState {
  /** config id -> 0-100 rating, or null when too few ballots to show one. */
  ratings: Map<string, number | null>;
  /** Ballots an engine needs before it gets a rating; null until loaded. */
  minBallots: number | null;
  reload: () => void;
}

export function useTtsScores(): TtsScoreState {
  const [ratings, setRatings] = React.useState<Map<string, number | null>>(new Map());
  const [minBallots, setMinBallots] = React.useState<number | null>(null);

  // Failure is deliberately silent. These numbers are an extra column and an
  // extra chart; neither is worth an error state on a page whose other
  // seventeen columns are static and already correct.
  const reload = React.useCallback(() => {
    fetchTtsScores()
      .then((s) => {
        setRatings(new Map(s.scores.map((x) => [x.config, x.rating])));
        setMinBallots(s.minBallots);
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => { reload(); }, [reload]);

  return { ratings, minBallots, reload };
}
