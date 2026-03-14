// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "./types";
// Integrations
import { twitterDoc } from "./content/twitter";
import { gmailDoc } from "./content/gmail";
import { githubDoc } from "./content/github";
import { calendarDoc } from "./content/calendar";
import { slackDoc } from "./content/slack";
import { discordDoc } from "./content/discord";
import { telegramDoc } from "./content/telegram";
import { whatsappDoc } from "./content/whatsapp";
import { teamsDoc } from "./content/teams";
import { matrixDoc } from "./content/matrix";
import { googleChatDoc } from "./content/google-chat";
import { sheetsDoc } from "./content/sheets";
import { formsDoc } from "./content/forms";
import { contactsDoc } from "./content/contacts";
// Features
import { secretsDoc } from "./content/secrets";
import { terminalsDoc } from "./content/terminals";
import { browserDoc } from "./content/browser";
import { workspaceDoc } from "./content/workspace";
import { notesDoc } from "./content/notes";
import { todosDoc } from "./content/todos";
import { linksDoc } from "./content/links";
import { recipesDoc } from "./content/recipes";
import { schedulesDoc } from "./content/schedules";
import { decisionsDoc } from "./content/decisions";
import { promptsDoc } from "./content/prompts";
// Getting started
import { gettingStartedDoc } from "./content/getting-started";

/** All docs, indexed by slug */
export const allDocs: Record<string, DocEntry> = {
  // Integrations
  twitter: twitterDoc,
  gmail: gmailDoc,
  github: githubDoc,
  calendar: calendarDoc,
  slack: slackDoc,
  discord: discordDoc,
  telegram: telegramDoc,
  whatsapp: whatsappDoc,
  teams: teamsDoc,
  matrix: matrixDoc,
  "google-chat": googleChatDoc,
  sheets: sheetsDoc,
  forms: formsDoc,
  contacts: contactsDoc,
  // Features
  secrets: secretsDoc,
  terminals: terminalsDoc,
  browser: browserDoc,
  workspace: workspaceDoc,
  notes: notesDoc,
  todos: todosDoc,
  links: linksDoc,
  recipes: recipesDoc,
  schedules: schedulesDoc,
  decisions: decisionsDoc,
  prompts: promptsDoc,
  // Getting started
  "getting-started": gettingStartedDoc,
};

/** Get a doc by slug */
export function getDoc(slug: string): DocEntry | undefined {
  return allDocs[slug];
}

/** Get docs by category, sorted alphabetically by title */
export function getDocsByCategory(category: DocEntry["category"]): DocEntry[] {
  return Object.values(allDocs)
    .filter((d) => d.category === category)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Search docs by query string  - matches against tags, title, summary.
 * Returns ranked results (title/tag match > summary match).
 */
export function searchDocs(query: string, maxResults = 3): DocEntry[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);

  const scored = Object.values(allDocs).map((doc) => {
    let score = 0;
    for (const term of terms) {
      // Tag match (highest weight)
      if (doc.tags.some((t) => t.includes(term))) score += 3;
      // Title match
      if (doc.title.toLowerCase().includes(term)) score += 2;
      // Summary match
      if (doc.summary.toLowerCase().includes(term)) score += 1;
      // Body match (lowest weight)
      if (doc.body.toLowerCase().includes(term)) score += 0.5;
    }
    return { doc, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.doc);
}

/**
 * Build a grounding context string from all docs for chat system prompt injection.
 * Returns a condensed version of all docs suitable for LLM context.
 */
export function buildGroundingContext(): string {
  const docs = Object.values(allDocs);
  const sections = docs.map((doc) => {
    const steps = doc.quickHelp.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
    return `### ${doc.title}\n${doc.summary}\n\nQuick setup:\n${steps}\n\n${doc.body}`;
  });
  return sections.join("\n\n---\n\n");
}

/**
 * Build a targeted grounding context for a specific query.
 * Returns relevant doc content for the query, or empty string if no match.
 */
export function buildQueryGrounding(query: string): string {
  const matches = searchDocs(query, 2);
  if (matches.length === 0) return "";

  return matches
    .map((doc) => {
      const steps = doc.quickHelp.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
      return `### ${doc.title}\n${doc.summary}\n\nQuick setup:\n${steps}\n\n${doc.body}`;
    })
    .join("\n\n---\n\n");
}

export type { DocEntry } from "./types";
