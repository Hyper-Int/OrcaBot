// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const schedulesDoc: DocEntry = {
  title: "Schedules (Cron)",
  slug: "schedules",
  category: "blocks",
  icon: "clock",
  summary: "Run commands on a schedule using simple intervals or full cron expressions.",
  quickHelp: [
    "Add a schedule block to your dashboard.",
    "Enter the command to run (e.g., 'npm run build').",
    "Set the interval  - every N minutes or hours (simple mode).",
    "Or switch to advanced mode for full 5-field cron expressions.",
    "Toggle the schedule ON to start. Click 'Run Now' for immediate execution.",
  ],
  tags: ["schedule", "cron", "timer", "recurring", "automation", "interval"],
  body: `## What It Does

Schedule blocks configure **cron-based task execution**. Set a command to run at regular intervals and monitor execution history.

## Two Modes

### Simple Mode
- Set an interval: every N **minutes** or **hours**
- The cron expression is generated automatically (e.g., every 5 minutes = \`*/5 * * * *\`)

### Advanced Mode (Cron)
- Edit all 5 cron fields directly: minute, hour, day-of-month, month, day-of-week
- Full cron syntax supported

## Features

- **ON/OFF toggle**  - enable or disable the schedule
- **Run Now**  - trigger immediate execution without waiting for the next scheduled time
- **Next run countdown**  - shows when the next execution will happen
- **Execution history**  - view recent runs with timestamps, status (completed/failed/running/timeout), and trigger source (manual or scheduled)
- **Command field**  - enter any shell command to execute

## Troubleshooting

### "Schedule Not Saved Yet"
- Make changes to the schedule (interval, command) to trigger an initial save before using "Run Now".

### Command Not Running
- Make sure the schedule toggle is ON.
- Check execution history for error status  - the command may be failing.`,
};
