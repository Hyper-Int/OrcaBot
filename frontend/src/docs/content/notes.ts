// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const notesDoc: DocEntry = {
  title: "Notes",
  slug: "notes",
  category: "blocks",
  icon: "sticky-note",
  summary: "Sticky notes with markdown support for capturing ideas, instructions, and context.",
  quickHelp: [
    "Add a note block to your dashboard.",
    "Click to edit  - type your text. Click outside to see rendered markdown.",
    "Use the settings menu to change the note color (yellow, blue, green, pink, purple).",
    "Adjust font size from the settings menu (small, medium, large, x-large).",
    "Connect notes to other blocks to pass text as input.",
  ],
  tags: ["note", "sticky note", "text", "markdown", "color"],
  body: `## What It Does

Notes are **sticky notes** on your dashboard canvas. They support markdown formatting and come in 5 colors. Use them to capture context, instructions, documentation, or anything your team needs to reference.

## Features

- **Markdown rendering**  - write in plain text, see rendered markdown (headers, bold, code blocks, lists)
- **5 colors**  - Yellow (default), Blue, Green, Pink, Purple
- **4 font sizes**  - Small, Medium, Large, X-Large
- **Connectable**  - wire notes to other blocks to pass text downstream

## Usage

- **Click** the note to enter edit mode
- **Click outside** (or press Escape) to see rendered markdown
- Open **Settings** (gear icon) to change color and font size
- **Duplicate** from the settings menu to copy a note

## Connections

Notes have input and output handles. You can:
- Wire a note's output to a terminal or prompt block to send its text
- Wire another block's output into a note to receive text (replaces content)`,
};
