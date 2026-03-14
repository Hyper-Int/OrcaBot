// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const calendarDoc: DocEntry = {
  title: "Google Calendar Integration",
  slug: "calendar",
  category: "google",
  icon: "calendar",
  summary: "Let your AI agents view, create, and manage events on your Google Calendar.",
  quickHelp: [
    "Add a Calendar block to your dashboard from the integrations panel.",
    "Click 'Connect'  - you'll sign in with Google to authorize access.",
    "Grant calendar permissions when prompted.",
    "Draw a wire from the Calendar block to a terminal block.",
    "Set a policy to control what the agent can do (read-only, create events, etc.).",
  ],
  tags: ["calendar", "google calendar", "events", "schedule", "meetings", "oauth"],
  body: `## What You Need

**A Google Account** with Google Calendar. Authorization uses Google's standard OAuth flow.

## Setup Steps

### 1. Add the Calendar Block
From the integrations panel, add a Calendar block to your dashboard.

### 2. Connect Your Account
Click **Connect** and sign in with Google. Approve calendar access when prompted.

### 3. Wire to a Terminal
Draw a connection from the Calendar block to a terminal block.

### 4. Set a Policy
- **Read-only**  - view calendars and events, but can't create or modify
- **Create events**  - can add new events but not modify existing ones
- **Full access**  - view, create, update, and delete events

## What Your Agent Can Do

- **List calendars**  - see all your calendars
- **View events**  - browse upcoming or past events with details
- **Create events**  - schedule new events with title, time, attendees
- **Update events**  - modify existing event details
- **Delete events**  - remove events from your calendar

## Security

- OAuth tokens stay in the control plane  - the agent never sees them.
- All calendar API calls go through the policy gateway.

## Troubleshooting

### Events Not Showing
- Make sure the right calendar is selected (you may have multiple).
- Check the date range  - the agent may be looking at a different time window.

### Can't Create Events
- Check the policy allows event creation.
- Some Google Workspace calendars restrict third-party apps from creating events.`,
};
