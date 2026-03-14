// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const browserDoc: DocEntry = {
  title: "Browser Block",
  slug: "browser",
  category: "blocks",
  icon: "globe",
  summary: "A built-in Chromium browser running in the sandbox for testing websites and web apps.",
  quickHelp: [
    "Add a browser block to your dashboard.",
    "The browser starts automatically when the block is visible.",
    "Enter a URL to navigate  - or let your AI agent open pages.",
    "Use the refresh button to reload the page.",
    "The browser runs in the sandbox VM alongside your terminals.",
  ],
  tags: ["browser", "chromium", "web", "testing", "vnc", "preview"],
  body: `## What It Does

The browser block streams a **Chromium browser** running inside your sandbox VM directly to the dashboard using VNC (remote desktop). This lets you:
- Test websites and web apps your agent is building
- Preview localhost servers started from a terminal
- Browse the web from the sandbox environment

## How It Works

- The browser runs **inside the sandbox VM**  - same environment as your terminals
- It streams to your dashboard via VNC (you see a live video feed of the browser)
- Mouse and keyboard input works through the remote desktop protocol
- Multiple browser blocks share the same browser instance

## Usage

### Navigate to a URL
Enter a URL in the block's content area. URLs starting with \`http://\` or \`https://\` are opened automatically.

### Test Localhost
If your agent starts a dev server (e.g., \`npm run dev\` on port 3000), navigate to \`http://localhost:3000\` in the browser block to preview it.

### Refresh
Click the **reload** button in the header to refresh the current page.

## Limitations

- **No clipboard sync**  - copy/paste between your computer and the browser block doesn't work across the VNC boundary.
- **Performance**  - the browser streams over the network, so it may feel slightly laggy compared to a local browser.
- **Single instance**  - all browser blocks on a dashboard share one Chromium process.

## Troubleshooting

### Browser Won't Start
- The sandbox VM may be booting. Wait 10-30 seconds.
- If it stays stuck, try removing and re-adding the browser block.

### Black Screen
- The browser may still be loading. Wait a few seconds.
- Click refresh to force a page reload.

### Can't Interact
- Click inside the browser block first to focus it.
- Some keyboard shortcuts may be captured by your OS instead of the remote browser.`,
};
