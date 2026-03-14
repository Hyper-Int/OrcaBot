// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const workspaceDoc: DocEntry = {
  title: "Workspace & File Explorer",
  slug: "workspace",
  category: "workspace",
  icon: "folder",
  summary: "Browse your sandbox files and connect cloud storage (Google Drive, GitHub, Box, OneDrive).",
  quickHelp: [
    "The workspace block shows the file tree from your sandbox's /workspace directory.",
    "Expand/collapse folders to navigate. Click files to open them.",
    "Connect cloud storage (GitHub, Drive, etc.) via the provider buttons.",
    "After connecting, select a repo or folder to sync into your workspace.",
    "Files sync on demand  - click the sync button to pull the latest changes.",
  ],
  tags: ["workspace", "files", "file explorer", "google drive", "github", "box", "onedrive", "sync"],
  body: `## What It Does

The workspace block shows the **file tree** of your sandbox's \`/workspace\` directory. When a terminal is active, you see live files from the sandbox. When no terminal is running, you see a cached preview of synced cloud storage files.

## Cloud Storage Integrations

Connect external storage to pull files into your workspace:

### GitHub
- Click the **GitHub** button → authorize with OAuth
- Pick a repository from the picker
- The repo is cloned into \`/workspace\`
- Auto-attaches GitHub tools to all active terminals

### Google Drive
- Click the **Drive** button → authorize with Google OAuth
- Browse and select a folder
- Files sync into your workspace

### Box / OneDrive
- Click the provider button → authorize
- Navigate the folder hierarchy to select what to sync
- Files pull into \`/workspace\`

## File Browsing

- **Expand/collapse** folders by clicking the arrow
- **Show hidden files** with the toggle at the top
- **Click files** to open them (if a terminal is connected)
- The \`lost+found\` system directory is automatically hidden

## Syncing

- Files sync **on demand**  - click the **sync button** (cloud icon) to pull the latest changes
- Sync timestamps show when the last sync happened
- Disconnecting a provider removes the sync but doesn't delete already-pulled files

## Troubleshooting

### Files Not Showing
- Make sure a terminal session is active. Without a running sandbox, you'll see cached previews only.
- Click **Sync** to refresh the file tree.

### "No Workspace" Message
- The sandbox VM may not be running yet. Create or activate a terminal to boot it.`,
};
