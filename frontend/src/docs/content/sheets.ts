// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const sheetsDoc: DocEntry = {
  title: "Google Sheets Integration",
  slug: "sheets",
  category: "google",
  icon: "sheets",
  summary: "Browse and view Google Sheets spreadsheets, and give AI agents access to your data.",
  quickHelp: [
    "Add a Sheets block to your dashboard from the integrations panel.",
    "Click 'Connect Sheets' in the settings menu  - sign in with Google OAuth.",
    "Select a spreadsheet from your Google Drive.",
    "The block displays your spreadsheet data (first 100 rows).",
    "Wire to a terminal to give agents read/write access to your sheets.",
  ],
  tags: ["sheets", "google sheets", "spreadsheet", "data", "google", "oauth"],
  body: `## What You Need

**A Google Account** with Google Sheets. Authorization uses Google's standard OAuth flow.

## Setup Steps

### 1. Add the Sheets Block
From the integrations panel, add a Sheets block to your dashboard.

### 2. Connect Your Account
Open the settings menu and click **Connect Sheets**. Sign in with Google and approve access.

### 3. Select a Spreadsheet
After connecting, a spreadsheet picker appears. Select the spreadsheet you want to work with.

### 4. Browse Data
The block displays your spreadsheet data in a table view:
- Switch between sheets using the tab bar at the top
- Data shows the first 100 rows (columns A through Z)
- Click **Refresh** to reload the latest data

### 5. Wire to a Terminal
Draw a connection from the Sheets block to a terminal block to give the agent tools for reading and writing spreadsheet data.

## Troubleshooting

### Spreadsheet Not Appearing
- Make sure the spreadsheet is in your Google Drive (not shared with you as view-only without access).
- Try disconnecting and reconnecting to refresh the file list.

### Data Not Updating
- Click the **Refresh** button to reload. Data is not live-streamed  - it loads on demand.`,
};
