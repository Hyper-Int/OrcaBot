// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const linksDoc: DocEntry = {
  title: "Link Blocks",
  slug: "links",
  category: "blocks",
  icon: "link",
  summary: "Bookmark URLs with rich previews  - favicon, title, and description.",
  quickHelp: [
    "Add a link block to your dashboard.",
    "Enter a URL  - the block displays a rich preview with favicon, title, and description.",
    "Click the block to open the link in a new browser tab.",
    "Use links to bookmark documentation, APIs, dashboards, or tools your team needs.",
  ],
  tags: ["link", "url", "bookmark", "preview", "favicon"],
  body: `## What It Does

Link blocks are **rich bookmarks** on your dashboard. Enter a URL and the block displays a preview with the site's favicon, title, hostname, and description. Click anywhere on the block to open the link in a new tab.

## Usage

- Enter a URL in the block's content
- The block automatically shows the favicon, page title, and description
- Click the block to open the link in a new browser tab
- Use links to collect reference material, API docs, or tools for your project`,
};
