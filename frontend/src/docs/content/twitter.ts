// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const twitterDoc: DocEntry = {
  title: "X (Twitter) Integration",
  slug: "twitter",
  category: "messaging",
  icon: "twitter",
  summary: "Let your AI agents post tweets, search X, and monitor accounts.",
  quickHelp: [
    "Go to developer.x.com and create a developer account (this is separate from your regular X/Twitter login).",
    "Create a new App in the developer portal  - give it a name and note the Bearer Token it generates.",
    "Paste the Bearer Token into the X block on your dashboard.",
    "Draw a wire from the X block to a terminal block to give that agent access to X tools.",
    "Set a policy on the connection to control what the agent can do (search only, post tweets, etc.).",
  ],
  tags: ["twitter", "x", "social media", "bearer token", "developer account", "tweet", "post"],
  body: `## What You Need

**An X Developer Account**  - this is different from a regular X/Twitter account. You need to apply at [developer.x.com](https://developer.x.com).

**A Bearer Token**  - after creating an app in the developer portal, you'll get an App-only Bearer Token. This is a long string that starts with uppercase letters/numbers. Copy it carefully  - you can only see it once.

## Setup Steps

### 1. Create a Developer Account
Go to [developer.x.com](https://developer.x.com) and sign up. You may need to describe your use case. Approval is usually instant for basic access.

### 2. Create an App
In the developer portal, go to Projects & Apps → create a new App. Name it something like "Orcabot" or your project name.

### 3. Get Your Bearer Token
After creating the app, go to Keys and Tokens. Generate a Bearer Token (under "App-only" section). Copy it immediately  - it won't be shown again.

### 4. Connect in Orcabot
Paste the Bearer Token into the X block on your dashboard. Click Connect. The block will verify your token and show your account.

### 5. Wire to a Terminal
Draw a connection from the X block to any terminal block. This gives the AI agent in that terminal access to X tools.

### 6. Set a Policy (Recommended)
Click the edge between the blocks to configure a policy. You can restrict what the agent can do:
- **Search only**  - agent can search tweets but not post
- **Read + Write**  - agent can search and post tweets
- **Specific accounts**  - limit which accounts the agent can interact with

## What Your Agent Can Do

Once wired, the AI agent can:
- **Search tweets**  - find tweets by keyword, hashtag, or user
- **Post tweets**  - compose and publish tweets (if app has write permission)
- **Read profiles**  - look up user information
- **Read timelines**  - see recent tweets from specific users

## Troubleshooting

### "Unauthorized" or "403 Forbidden"
- Your Bearer Token may be invalid or revoked. Generate a new one at developer.x.com.
- Check that your app has the right permissions (read vs read+write).

### "Rate Limited"
- X API has rate limits. The free tier allows ~100 tweets/month and limited searches.
- Consider upgrading to the Basic tier ($100/mo) for higher limits.

### Can't Find Developer Portal
- Go directly to developer.x.com (not x.com or twitter.com).
- You need to log in with your X account, then apply for developer access separately.

### Token Shows as Connected but Agent Can't Use It
- Make sure you've drawn a wire from the X block to the terminal block.
- Check the policy on the connection  - it may be restricting the actions.`,
};
