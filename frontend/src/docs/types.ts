// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Structured documentation entry used across:
 * - In-component help dialogs (quickHelp + summary)
 * - Chat panel grounding (full body)
 * - Future /docs route (full body rendered)
 */
export interface DocEntry {
  /** Display title */
  title: string;
  /** URL-safe slug for linking */
  slug: string;
  /** Category for sidebar grouping, matching dashboard toolbar sections */
  category: "getting-started" | "google" | "messaging" | "workspace" | "agents" | "blocks";
  /** Icon identifier (matches block type or lucide icon name) */
  icon: string;
  /** One-line summary shown in help popovers */
  summary: string;
  /** Numbered quick-start steps shown in the help dialog */
  quickHelp: string[];
  /** Search tags for chat grounding retrieval */
  tags: string[];
  /** Full markdown body for detailed docs */
  body: string;
}
