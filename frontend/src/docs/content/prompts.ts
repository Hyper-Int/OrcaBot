// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const promptsDoc: DocEntry = {
  title: "Prompt Blocks",
  slug: "prompts",
  category: "blocks",
  icon: "message-square",
  summary: "Text input blocks that send prompts to connected terminals and blocks.",
  quickHelp: [
    "Add a prompt block to your dashboard.",
    "Type your prompt text  - supports markdown.",
    "Use [input] as a placeholder to substitute data from connected upstream blocks.",
    "Click 'Go' (or Cmd/Ctrl+Enter) to send the prompt to connected blocks.",
    "Check 'New session' to clear the agent's context before sending.",
  ],
  tags: ["prompt", "input", "send", "template", "placeholder", "asr", "voice"],
  body: `## What It Does

Prompt blocks are **text inputs** that send messages to connected downstream blocks (typically terminals). They support markdown, voice input (ASR), and template placeholders for data piping.

## Features

- **Text input**  - click to edit, click outside to see rendered markdown
- **Go button**  - sends the prompt to all connected downstream blocks
- **Keyboard shortcut**  - Cmd/Ctrl+Enter to send
- **[input] placeholder**  - replaced with text from upstream connected blocks
- **New session checkbox**  - clears the agent's context before sending (like \`/clear\` for Claude)
- **Voice input**  - microphone button for speech-to-text (if ASR is configured)

## Data Piping

Use \`[input]\` in your prompt text as a placeholder. When data arrives from an upstream block, the placeholder is replaced and the prompt fires automatically.

**Example:** \`Analyze this code: [input]\`  - when a note block sends code to this prompt, it becomes \`Analyze this code: function hello()...\` and fires to the connected terminal.

## Voice Input (ASR)

Click the **microphone button** to dictate your prompt. The button turns red while listening. Interim results appear as an overlay. Supports Web Speech API and configured ASR providers (AssemblyAI, OpenAI Whisper, Deepgram).

## Connections

- **Inputs** (left, top): Receive text from upstream blocks → triggers auto-send
- **Outputs** (right, bottom): Send prompt text to downstream blocks (terminals, decisions, etc.)`,
};
