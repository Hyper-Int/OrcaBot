// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Public endpoints — the TTS benchmark is a marketing page and anyone reading it
// can rank clips. No auth, and the control plane treats every ballot as
// untrusted: it picks the comparison set itself and only accepts a ranking that
// is a permutation of what it issued.

import { API } from "@/config/env";
import { apiGet, apiPost } from "../client";

export interface TtsBallot {
  ballotId: string;
  /** Configuration ids to rank, already shuffled. Never includes which is the anchor. */
  items: string[];
}

export interface TtsScore {
  config: string;
  /** 0-100, or null when too few ballots to show a number. */
  rating: number | null;
  ballots: number;
  wins: number;
  comparisons: number;
}

export interface TtsScores {
  run: string;
  countedBallots: number;
  minBallots: number;
  scores: TtsScore[];
}

export function fetchTtsBallot(): Promise<TtsBallot> {
  return apiGet<TtsBallot>(`${API.cloudflare.base}/tts/ballot`);
}

/** `ranking` is best first, and must be a permutation of the issued items. */
export function submitTtsBallot(
  ballotId: string,
  ranking: string[]
): Promise<{ ok: true; counted: boolean }> {
  return apiPost(`${API.cloudflare.base}/tts/ballot`, { ballotId, ranking });
}

export function fetchTtsScores(): Promise<TtsScores> {
  return apiGet<TtsScores>(`${API.cloudflare.base}/tts/scores`);
}
