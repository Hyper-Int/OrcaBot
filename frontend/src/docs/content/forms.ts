// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const formsDoc: DocEntry = {
  title: "Google Forms Integration",
  slug: "forms",
  category: "google",
  icon: "forms",
  summary: "View and analyze Google Form responses from your dashboard.",
  quickHelp: [
    "Add a Forms block to your dashboard from the integrations panel.",
    "Click 'Connect Forms' in the settings menu  - sign in with Google OAuth.",
    "Select a form from your Google account.",
    "Browse responses in a two-pane view (list on left, details on right).",
    "Wire to a terminal to give agents access to form response data.",
  ],
  tags: ["forms", "google forms", "responses", "survey", "google", "oauth"],
  body: `## What You Need

**A Google Account** with Google Forms. Authorization uses Google's standard OAuth flow.

## Setup Steps

### 1. Add the Forms Block
From the integrations panel, add a Forms block to your dashboard.

### 2. Connect Your Account
Open the settings menu and click **Connect Forms**. Sign in with Google and approve access.

### 3. Select a Form
After connecting, select a form from the picker. The block loads the form's responses.

### 4. Browse Responses
The block shows responses in a two-pane layout:
- **Left pane:** List of all responses with submission timestamps
- **Right pane:** Selected response details showing each question and answer

Click any response in the list to see its full details.

### 5. Wire to a Terminal
Draw a connection from the Forms block to a terminal to let agents analyze response data.

## Troubleshooting

### Form Not Appearing
- Only forms you own will appear in the picker.
- Forms shared with you may not be listed  - check form ownership.

### Responses Not Loading
- Click **Refresh** to reload. New responses require a manual refresh.`,
};
