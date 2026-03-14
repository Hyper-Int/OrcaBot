// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const decisionsDoc: DocEntry = {
  title: "Decision Blocks",
  slug: "decisions",
  category: "blocks",
  icon: "git-branch",
  summary: "Conditional routing  - evaluate input and send data down YES or NO paths.",
  quickHelp: [
    "Add a decision block (diamond shape) to your dashboard.",
    "Select an operator: Contains, Equals, Greater Than, or Less Than.",
    "Enter the comparison value (e.g., 'error' or '42').",
    "Wire input to the left or top handles, and outputs to YES/NO handles.",
    "Data flows to the YES or NO path based on the evaluation result.",
  ],
  tags: ["decision", "conditional", "branch", "if", "routing", "logic"],
  body: `## What It Does

Decision blocks are **conditional routers** shaped like a diamond. They evaluate incoming text against an operator and route data down YES or NO paths.

## Operators

- **Contains**  - case-insensitive substring match (e.g., does the input contain "error"?)
- **Equals**  - exact string match (trimmed)
- **Greater Than**  - numeric comparison
- **Less Than**  - numeric comparison

## Wiring

- **Inputs:** Left and top handles receive data
- **Outputs:** Three output handles:
  - Bottom-left = always YES path
  - Top-right = always NO path
  - Bottom-right = dynamic (YES if bottom-left is unwired, otherwise NO)

## Usage

Connect the decision block between a data source (prompt, note, etc.) and downstream blocks. When data arrives, the block evaluates it and routes to the matching output path.

The last evaluation result is shown on the block with a green "YES" or red "NO" indicator.`,
};
