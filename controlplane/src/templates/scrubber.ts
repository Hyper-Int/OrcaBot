// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Scrubs sensitive data from dashboard items before template export.
 *
 * Scrubbing rules by item type:
 * - note: Clear text content, keep color
 * - todo: Clear item text, keep structure (item count, completed states)
 * - terminal: Keep name only, clear sessionId/ptyId
 * - link: Keep URL and title (assumed public)
 * - browser: Keep URL (assumed public)
 * - workspace: Keep as-is (no sensitive data)
 * - recipe: Clear step configs that may contain env vars/secrets
 * - prompt: Clear prompt text (may contain user instructions/data)
 * - schedule: Keep cron pattern, clear name and event trigger
 */

export type DashboardItemType =
  | 'note'
  | 'todo'
  | 'terminal'
  | 'link'
  | 'browser'
  | 'workspace'
  | 'recipe'
  | 'prompt'
  | 'schedule';

/**
 * Safely parse JSON, returning null on failure
 */
function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Scrub sensitive content from a dashboard item based on its type.
 * Returns a scrubbed version of the content string.
 */
export function scrubItemContent(
  type: DashboardItemType,
  content: string
): string {
  try {
    switch (type) {
      case 'note': {
        // Notes store { text: string, color: string }
        // Clear text but keep color for visual layout
        const parsed = safeParseJson(content) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object') {
          return JSON.stringify({
            text: '',
            color: parsed.color || 'yellow',
          });
        }
        return JSON.stringify({ text: '', color: 'yellow' });
      }

      case 'todo': {
        // Todos store { title: string, items: TodoItem[] }
        // Clear text from title and items but keep structure
        const parsed = safeParseJson(content) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object') {
          const items = Array.isArray(parsed.items) ? parsed.items : [];
          const scrubbedItems = items.map(
            (item: Record<string, unknown>, i: number) => ({
              id: `todo_${i}`,
              text: '', // Clear the text
              completed: item?.completed || false,
            })
          );
          return JSON.stringify({
            title: '', // Clear the title
            items: scrubbedItems,
          });
        }
        return JSON.stringify({ title: '', items: [] });
      }

      case 'terminal': {
        // Terminals store { name: string, sessionId?: string, ptyId?: string }
        // Keep name for context, clear session info
        const parsed = safeParseJson(content) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object') {
          return JSON.stringify({
            name: parsed.name || 'Terminal',
          });
        }
        return JSON.stringify({ name: 'Terminal' });
      }

      case 'recipe': {
        // Recipes store { title: string, steps: RecipeStep[] }
        // Step configs may contain env vars/secrets - clear them
        const parsed = safeParseJson(content) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object') {
          const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
          const scrubbedSteps = steps.map(
            (step: Record<string, unknown>, i: number) => ({
              id: `step_${i}`,
              type: step?.type || 'run_agent',
              name: step?.name || `Step ${i + 1}`,
              config: {}, // Clear config which may contain secrets
              nextStepId: null,
              onError: 'fail',
            })
          );
          return JSON.stringify({
            title: parsed.title || 'Recipe',
            description: '', // Clear description
            steps: scrubbedSteps,
          });
        }
        return JSON.stringify({ title: 'Recipe', description: '', steps: [] });
      }

      case 'link': {
        // Links store { url: string, title: string, description?: string, favicon?: string }
        // URLs and titles are assumed to be intentionally shareable
        // Clear description which may contain private notes
        const parsed = safeParseJson(content) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object') {
          return JSON.stringify({
            url: parsed.url || '',
            title: parsed.title || '',
            description: '', // Clear private description
            favicon: parsed.favicon || '',
          });
        }
        return content;
      }

      case 'browser': {
        // Browsers store { url: string }
        // URL is assumed to be intentionally shareable
        return content;
      }

      case 'workspace': {
        // Workspace blocks have no sensitive user data
        return content;
      }

      case 'prompt': {
        // Prompts store { prompt: string, ... }
        // Clear prompt text which may contain user instructions/data
        const parsed = safeParseJson(content) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object') {
          return JSON.stringify({
            prompt: '', // Clear user prompt
          });
        }
        return JSON.stringify({ prompt: '' });
      }

      case 'schedule': {
        // Schedules store { name: string, cron?: string, eventTrigger?: string, ... }
        // Keep structure but clear names and specific trigger details
        const parsed = safeParseJson(content) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object') {
          return JSON.stringify({
            name: '', // Clear name
            cron: parsed.cron || '', // Keep cron pattern (not sensitive)
            eventTrigger: '', // Clear event trigger
            enabled: parsed.enabled ?? true,
          });
        }
        return JSON.stringify({ name: '', cron: '', eventTrigger: '', enabled: true });
      }

      default:
        // Unknown type - return empty for safety
        return '';
    }
  } catch {
    // On any error, return safe default
    return '';
  }
}
