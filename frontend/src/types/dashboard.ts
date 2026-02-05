// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Dashboard represents a collaborative workspace
 */
export interface Dashboard {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  /** Number of secrets configured for this dashboard */
  secretsCount?: number;
}

/**
 * Dashboard item types
 */
export type DashboardItemType = "note" | "todo" | "terminal" | "link" | "browser" | "workspace" | "recipe" | "prompt" | "schedule" | "gmail" | "calendar" | "contacts" | "sheets" | "forms";

/**
 * Position on the canvas
 */
export interface Position {
  x: number;
  y: number;
}

/**
 * Size of a block
 */
export interface Size {
  width: number;
  height: number;
}

/**
 * Base dashboard item
 */
export interface DashboardItem {
  id: string;
  dashboardId: string;
  type: DashboardItemType;
  content: string;
  position: Position;
  size: Size;
  /** Type-specific metadata (e.g., note color, terminal settings) */
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Client-only: stable key for React reconciliation during temp->real ID transitions */
  _stableKey?: string;
}

/**
 * Connection edge between blocks
 */
export interface DashboardEdge {
  id: string;
  dashboardId: string;
  sourceItemId: string;
  targetItemId: string;
  sourceHandle?: string;
  targetHandle?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Note block content
 */
export interface NoteContent {
  text: string;
  color: "yellow" | "blue" | "green" | "pink" | "purple";
}

/**
 * Todo item
 */
export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  assigneeId?: string;
}

/**
 * Todo block content
 */
export interface TodoContent {
  title: string;
  items: TodoItem[];
}

/**
 * Link block content
 */
export interface LinkContent {
  url: string;
  title: string;
  description?: string;
  favicon?: string;
}

/**
 * Terminal block content
 */
export interface TerminalContent {
  name: string;
  sessionId?: string;
  ptyId?: string;
}

/**
 * Browser block content
 */
export interface BrowserContent {
  url: string;
}

/**
 * Recipe step types
 */
export type RecipeStepType =
  | "run_agent"
  | "wait"
  | "branch"
  | "notify"
  | "human_approval";

/**
 * Recipe step
 */
export interface RecipeStep {
  id: string;
  type: RecipeStepType;
  name: string;
  config: Record<string, unknown>;
  nextStepId: string | null;
  onError: "fail" | "retry" | "skip";
}

/**
 * Recipe (workflow definition)
 */
export interface Recipe {
  id: string;
  dashboardId: string;
  name: string;
  description: string;
  steps: RecipeStep[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Execution status
 */
export type ExecutionStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed";

/**
 * Execution (recipe run)
 */
export interface Execution {
  id: string;
  recipeId: string;
  status: ExecutionStatus;
  currentStepId: string | null;
  context: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

/**
 * Session (terminal session)
 */
export interface Session {
  id: string;
  dashboardId: string;
  itemId: string;
  ownerUserId: string;
  ownerName: string;
  sandboxSessionId: string;
  sandboxMachineId?: string;
  ptyId: string; // PTY ID in the sandbox
  status: "creating" | "active" | "stopped" | "error";
  region: string;
  createdAt: string;
  stoppedAt: string | null;
}

/**
 * Dashboard membership role
 */
export type DashboardRole = "owner" | "editor" | "viewer";

/**
 * Dashboard member
 */
export interface DashboardMember {
  userId: string;
  dashboardId: string;
  role: DashboardRole;
  joinedAt: string;
}

/**
 * Template category
 */
export type TemplateCategory = 'coding' | 'automation' | 'documentation' | 'custom';

/**
 * Template item (stored in template data)
 */
export interface TemplateItem {
  placeholderId: string;
  type: DashboardItemType;
  content: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

/**
 * Template edge (stored in template data)
 */
export interface TemplateEdge {
  sourcePlaceholderId: string;
  targetPlaceholderId: string;
  sourceHandle?: string;
  targetHandle?: string;
}

/**
 * Dashboard template (summary for listing)
 */
export interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  previewImageUrl?: string;
  authorId: string;
  authorName: string;
  itemCount: number;
  isFeatured: boolean;
  useCount: number;
  status?: 'pending_review' | 'approved' | 'rejected';
  createdAt: string;
  updatedAt: string;
}

/**
 * Dashboard template with full data for import
 */
export interface DashboardTemplateWithData extends DashboardTemplate {
  items: TemplateItem[];
  edges: TemplateEdge[];
  viewport?: { x: number; y: number; zoom: number };
}
