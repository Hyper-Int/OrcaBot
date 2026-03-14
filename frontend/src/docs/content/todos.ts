// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const todosDoc: DocEntry = {
  title: "Todo Lists",
  slug: "todos",
  category: "blocks",
  icon: "check-square",
  summary: "Task lists with checkboxes to track work and completion progress.",
  quickHelp: [
    "Add a todo block to your dashboard.",
    "Click 'Add item' to create a new task. Press Enter to confirm.",
    "Click the checkbox to mark items complete (strikethrough).",
    "Hover over items and click X to delete them.",
    "The completion count badge shows progress (e.g., 3/5).",
  ],
  tags: ["todo", "task", "checklist", "checkbox", "progress"],
  body: `## What It Does

Todo blocks are **task lists** with checkboxes. Track work items, checklists, and progress right on your dashboard canvas.

## Features

- **Add items**  - click the + button, type your task, press Enter
- **Check off**  - click the checkbox to mark complete (shows strikethrough)
- **Delete**  - hover over an item and click the X button
- **Progress badge**  - shows completion count (e.g., "3/5 items completed")
- **Custom title**  - click the title to rename the list
- **Adjustable font size**  - Small, Medium, Large, X-Large

## Connections

Wire other blocks into a todo list to programmatically add items. Connected blocks send text that becomes new todo items.`,
};
