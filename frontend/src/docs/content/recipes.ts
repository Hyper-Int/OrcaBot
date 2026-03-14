// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const recipesDoc: DocEntry = {
  title: "Recipes (Workflows)",
  slug: "recipes",
  category: "blocks",
  icon: "play-circle",
  summary: "Multi-step workflows with status tracking  - define and run sequences of actions.",
  quickHelp: [
    "Add a recipe block to your dashboard.",
    "Edit the title to name your workflow.",
    "Steps are defined in the block content (initialize, test, deploy, etc.).",
    "Click 'Run Recipe' to start execution.",
    "Each step shows its status: pending, running, completed, or failed.",
  ],
  tags: ["recipe", "workflow", "steps", "automation", "pipeline"],
  body: `## What It Does

Recipe blocks define **multi-step workflows** that can be executed as a sequence. Each step has a status indicator showing whether it's pending, running, completed, or failed. A progress badge tracks overall completion.

## Features

- **Step list**  - visualize each step with status icons
- **Run button**  - start the recipe execution
- **Progress tracking**  - badge shows completion (e.g., "2/3 steps completed")
- **Status icons**  - pending (circle), running (spinner), completed (checkmark), failed (alert)

## Default Steps

New recipes start with three example steps:
1. Initialize environment
2. Run tests
3. Deploy changes

Customize these by editing the block content.

## Note

Recipe execution is orchestrated by the backend. The block provides the visual interface for defining, monitoring, and controlling workflows.`,
};
