// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api/client";
import { API } from "@/config/env";

// ============================================
// Types
// ============================================

export type IntegrationProvider =
  | "gmail"
  | "google_calendar"
  | "google_contacts"
  | "google_sheets"
  | "google_forms"
  | "google_drive"
  | "onedrive"
  | "box"
  | "github"
  | "browser";

export type SecurityLevel = "restricted" | "elevated" | "full";

export interface BasePolicy {
  rateLimits?: {
    readsPerMinute?: number;
    writesPerHour?: number;
    sendsPerDay?: number;        // Gmail sends (daily limit)
    sendsPerHour?: number;       // Alternative: hourly send limit
    deletesPerHour?: number;     // Destructive operations
    downloadsPerHour?: number;   // Drive/OneDrive/Box downloads
    uploadsPerHour?: number;     // Drive/OneDrive/Box uploads
  };
}

export interface GmailPolicy extends BasePolicy {
  canRead: boolean;
  senderFilter?: {
    mode: "all" | "allowlist" | "blocklist";
    domains?: string[];
    addresses?: string[];
  };
  labelFilter?: {
    mode: "all" | "allowlist";
    labels?: string[];
  };
  canArchive: boolean;
  canTrash: boolean;
  canMarkRead: boolean;
  canLabel: boolean;
  canSend: boolean;
  sendPolicy?: {
    allowedRecipients?: string[];
    allowedDomains?: string[];
    requiredCc?: string[];
    maxPerHour?: number;
  };
}

export interface CalendarPolicy extends BasePolicy {
  canRead: boolean;
  calendarFilter?: {
    mode: "all" | "allowlist";
    calendarIds?: string[];
  };
  canCreate: boolean;
  createPolicy?: {
    maxDuration?: string;
    requireDescription?: boolean;
    allowedCalendars?: string[];
    blockedTimeRanges?: { start: string; end: string }[];
  };
  canUpdate: boolean;
  canDelete: boolean;
}

export interface ContactsPolicy extends BasePolicy {
  canRead: boolean;
  contactFilter?: {
    mode: "all" | "allowlist" | "blocklist";
    groups?: string[];
    domains?: string[];
  };
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface SheetsPolicy extends BasePolicy {
  canRead: boolean;
  spreadsheetFilter?: {
    mode: "all" | "allowlist";
    spreadsheetIds?: string[];
    folderIds?: string[];
  };
  canWrite: boolean;
  writePolicy?: {
    allowedSpreadsheets?: string[];
    canCreateNew: boolean;
    canDeleteSheets: boolean;
  };
  canUseFormulas: boolean;
  blockedFormulas?: string[];
}

export interface FormsPolicy extends BasePolicy {
  canRead: boolean;
  canReadResponses: boolean;
  formFilter?: {
    mode: "all" | "allowlist";
    formIds?: string[];
  };
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface GoogleDrivePolicy extends BasePolicy {
  canRead: boolean;
  canDownload: boolean;
  folderFilter?: {
    mode: "all" | "allowlist" | "blocklist";
    folderIds?: string[];
    folderPaths?: string[];
  };
  fileTypeFilter?: {
    mode: "all" | "allowlist" | "blocklist";
    mimeTypes?: string[];
    extensions?: string[];
  };
  maxFileSize?: number;
  canUpload: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canMove: boolean;
  uploadPolicy?: {
    allowedFolders?: string[];
    allowedTypes?: string[];
    maxFileSize?: number;
  };
  canShare: boolean;
  sharePolicy?: {
    allowedDomains?: string[];
    maxPermission?: "reader" | "commenter" | "writer";
    noPublicSharing: boolean;
  };
}

export interface OneDrivePolicy extends BasePolicy {
  canRead: boolean;
  canDownload: boolean;
  folderFilter?: {
    mode: "all" | "allowlist" | "blocklist";
    folderPaths?: string[];
  };
  fileTypeFilter?: {
    mode: "all" | "allowlist" | "blocklist";
    extensions?: string[];
  };
  maxFileSize?: number;
  canUpload: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canMove: boolean;
  canShare: boolean;
  sharePolicy?: {
    allowedDomains?: string[];
    maxPermission?: "read" | "write";
    noAnonymousLinks: boolean;
  };
}

export interface BoxPolicy extends BasePolicy {
  canRead: boolean;
  canDownload: boolean;
  folderFilter?: {
    mode: "all" | "allowlist" | "blocklist";
    folderIds?: string[];
  };
  fileTypeFilter?: {
    mode: "all" | "allowlist" | "blocklist";
    extensions?: string[];
  };
  maxFileSize?: number;
  canUpload: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canMove: boolean;
  canShare: boolean;
  sharePolicy?: {
    maxAccessLevel?: "previewer" | "viewer" | "editor";
    noOpenAccess: boolean;
  };
}

export interface GitHubPolicy extends BasePolicy {
  canReadRepos: boolean;
  repoFilter?: {
    mode: "all" | "allowlist" | "blocklist";
    repos?: string[];
    orgs?: string[];
    visibility?: "all" | "public" | "private";
  };
  canReadCode: boolean;
  canClone: boolean;
  canPush: boolean;
  pushPolicy?: {
    allowedBranches?: string[];
    blockedBranches?: string[];
    requireBranchPrefix?: string;
  };
  canReadIssues: boolean;
  canCreateIssues: boolean;
  canCommentIssues: boolean;
  canCloseIssues: boolean;
  canReadPRs: boolean;
  canCreatePRs: boolean;
  canApprovePRs: boolean;
  canMergePRs: boolean;
  canCreateReleases: boolean;
  canTriggerActions: boolean;
  canCreateRepos: boolean;
  canDeleteRepos: boolean;
  canManageSettings: boolean;
}

export interface BrowserPolicy extends BasePolicy {
  canNavigate: boolean;
  urlFilter: {
    mode: "allowlist";
    patterns: string[];
    blockedPatterns?: string[];
  };
  canClick: boolean;
  canType: boolean;
  canScroll: boolean;
  canScreenshot: boolean;
  canExtractText: boolean;
  canFillForms: boolean;
  canSubmitForms: boolean;
  formPolicy?: {
    allowedDomains?: string[];
    noPasswordFields: boolean;
    noPaymentFields: boolean;
  };
  canDownload: boolean;
  downloadPolicy?: {
    allowedTypes?: string[];
    maxFileSize?: number;
    allowedDomains?: string[];
  };
  canUpload: boolean;
  uploadPolicy?: {
    allowedDomains?: string[];
    maxFileSize?: number;
  };
  canExecuteJs: boolean;
  jsPolicy?: {
    allowedDomains?: string[];
    noEval: boolean;
  };
  canUseStoredCredentials: boolean;
  canInputCredentials: boolean;
  canReadCookies: boolean;
  canInspectNetwork: boolean;
  canModifyRequests: boolean;
}

export type AnyPolicy =
  | GmailPolicy
  | CalendarPolicy
  | ContactsPolicy
  | SheetsPolicy
  | FormsPolicy
  | GoogleDrivePolicy
  | OneDrivePolicy
  | BoxPolicy
  | GitHubPolicy
  | BrowserPolicy;

export interface AvailableIntegration {
  provider: IntegrationProvider;
  userIntegrationId?: string;
  accountEmail?: string;
  accountLabel?: string;
  connected: boolean;
  attached: boolean;
  terminalIntegrationId?: string;
  policyId?: string;
}

export interface TerminalIntegration {
  id: string;
  terminalId: string;
  dashboardId: string;
  userId: string;
  provider: IntegrationProvider;
  userIntegrationId: string | null;
  activePolicyId: string | null;
  accountEmail: string | null;
  accountLabel: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  // From joined policy
  policy: AnyPolicy | null;
  policyVersion: number | null;
  securityLevel: SecurityLevel | null;
}

export interface IntegrationPolicy {
  id: string;
  terminalIntegrationId: string;
  version: number;
  policy: AnyPolicy;
  securityLevel: SecurityLevel;
  createdAt: string;
  createdBy: string;
}

export interface AuditLogEntry {
  id: string;
  terminalId?: string;
  provider?: IntegrationProvider;
  action: string;
  resourceId: string | null;
  policyVersion: number;
  decision: "allowed" | "denied" | "filtered";
  denialReason: string | null;
  requestSummary: string | null;
  createdAt: string;
}

// ============================================
// API Functions
// ============================================

/**
 * List integrations available to attach to a terminal
 */
export async function listAvailableIntegrations(
  dashboardId: string,
  terminalId: string
): Promise<AvailableIntegration[]> {
  const response = await apiGet<{ integrations: AvailableIntegration[] }>(
    `${API.cloudflare.dashboards}/${dashboardId}/terminals/${terminalId}/available-integrations`
  );
  return response.integrations;
}

/**
 * List integrations attached to a terminal
 */
export async function listTerminalIntegrations(
  dashboardId: string,
  terminalId: string
): Promise<TerminalIntegration[]> {
  const response = await apiGet<{ integrations: TerminalIntegration[] }>(
    `${API.cloudflare.dashboards}/${dashboardId}/terminals/${terminalId}/integrations`
  );
  return response.integrations;
}

/**
 * Attach an integration to a terminal
 */
export async function attachIntegration(
  dashboardId: string,
  terminalId: string,
  data: {
    provider: IntegrationProvider;
    userIntegrationId?: string;
    policy?: AnyPolicy;
    accountLabel?: string;
    highRiskConfirmations?: string[];
  }
): Promise<{
  id: string;
  provider: IntegrationProvider;
  userIntegrationId: string | null;
  activePolicyId: string;
  policyVersion: number;
  securityLevel: SecurityLevel;
  accountEmail: string | null;
  accountLabel: string | null;
}> {
  return apiPost(
    `${API.cloudflare.dashboards}/${dashboardId}/terminals/${terminalId}/integrations`,
    data
  );
}

/**
 * Update an integration's policy
 */
export async function updateIntegrationPolicy(
  dashboardId: string,
  terminalId: string,
  provider: IntegrationProvider,
  data: {
    policy: AnyPolicy;
    highRiskConfirmations?: string[];
  }
): Promise<{
  activePolicyId: string;
  policyVersion: number;
  previousPolicyId: string | null;
  securityLevel: SecurityLevel;
}> {
  return apiPut(
    `${API.cloudflare.dashboards}/${dashboardId}/terminals/${terminalId}/integrations/${provider}`,
    data
  );
}

/**
 * Detach an integration from a terminal
 */
export async function detachIntegration(
  dashboardId: string,
  terminalId: string,
  provider: IntegrationProvider
): Promise<{ detached: boolean; deletedAt: string }> {
  return apiDelete(
    `${API.cloudflare.dashboards}/${dashboardId}/terminals/${terminalId}/integrations/${provider}`
  );
}

/**
 * Get policy history for an integration
 */
export async function getPolicyHistory(
  dashboardId: string,
  terminalId: string,
  provider: IntegrationProvider
): Promise<IntegrationPolicy[]> {
  const response = await apiGet<{ policies: IntegrationPolicy[] }>(
    `${API.cloudflare.dashboards}/${dashboardId}/terminals/${terminalId}/integrations/${provider}/history`
  );
  return response.policies;
}

/**
 * Get audit log for an integration
 */
export async function getAuditLog(
  dashboardId: string,
  terminalId: string,
  provider: IntegrationProvider,
  limit = 100,
  offset = 0
): Promise<AuditLogEntry[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  const response = await apiGet<{ entries: AuditLogEntry[] }>(
    `${API.cloudflare.dashboards}/${dashboardId}/terminals/${terminalId}/integrations/${provider}/audit?${params}`
  );
  return response.entries;
}

/**
 * Get dashboard-wide audit log
 */
export async function getDashboardAuditLog(
  dashboardId: string,
  limit = 100,
  offset = 0
): Promise<AuditLogEntry[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  const response = await apiGet<{ entries: AuditLogEntry[] }>(
    `${API.cloudflare.dashboards}/${dashboardId}/integration-audit?${params}`
  );
  return response.entries;
}

// ============================================
// Helper Functions
// ============================================

/**
 * High-risk capabilities that require explicit user confirmation
 */
export const HIGH_RISK_CAPABILITIES: Record<IntegrationProvider, string[]> = {
  gmail: ["canSend", "canTrash"],
  google_calendar: ["canDelete"],
  google_contacts: ["canDelete"],
  google_sheets: ["writePolicy.canDeleteSheets"],
  google_forms: ["canDelete"],
  google_drive: ["canDelete", "canShare"],
  onedrive: ["canDelete", "canShare"],
  box: ["canDelete", "canShare"],
  github: ["canPush", "canMergePRs", "canApprovePRs", "canDeleteRepos"],
  browser: ["canSubmitForms", "canExecuteJs", "canUpload", "canInputCredentials"],
};

/**
 * Get display name for a provider
 */
export function getProviderDisplayName(provider: IntegrationProvider): string {
  const names: Record<IntegrationProvider, string> = {
    gmail: "Gmail",
    google_calendar: "Google Calendar",
    google_contacts: "Google Contacts",
    google_sheets: "Google Sheets",
    google_forms: "Google Forms",
    google_drive: "Google Drive",
    onedrive: "OneDrive",
    box: "Box",
    github: "GitHub",
    browser: "Browser",
  };
  return names[provider] || provider;
}

/**
 * Get icon name for a provider (Lucide icon names)
 */
export function getProviderIcon(provider: IntegrationProvider): string {
  const icons: Record<IntegrationProvider, string> = {
    gmail: "Mail",
    google_calendar: "Calendar",
    google_contacts: "Users",
    google_sheets: "Sheet",
    google_forms: "FileText",
    google_drive: "FolderOpen",
    onedrive: "Cloud",
    box: "Box",
    github: "Github",
    browser: "Globe",
  };
  return icons[provider] || "Plug";
}

/**
 * Get security level color class
 */
export function getSecurityLevelColor(level: SecurityLevel): string {
  switch (level) {
    case "restricted":
      return "text-green-600 bg-green-100";
    case "elevated":
      return "text-yellow-600 bg-yellow-100";
    case "full":
      return "text-red-600 bg-red-100";
  }
}

/**
 * Get security level icon (empty - labels only)
 */
export function getSecurityLevelIcon(_level: SecurityLevel): string {
  // No icons - text labels are clearer
  return "";
}

/**
 * Get security level display text
 */
export function getSecurityLevelText(level: SecurityLevel): string {
  switch (level) {
    case "restricted":
      return "Restricted";
    case "elevated":
      return "Elevated";
    case "full":
      return "Full Access";
  }
}

/**
 * Create a read-only policy for a provider (no write/delete/send capabilities)
 */
export function createReadOnlyPolicy(provider: IntegrationProvider): AnyPolicy {
  switch (provider) {
    case "gmail":
      return {
        canRead: true,
        canArchive: false,
        canTrash: false,
        canMarkRead: false,
        canLabel: false,
        canSend: false,
      } as GmailPolicy;

    case "google_calendar":
      return {
        canRead: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      } as CalendarPolicy;

    case "google_contacts":
      return {
        canRead: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      } as ContactsPolicy;

    case "google_sheets":
      return {
        canRead: true,
        canWrite: false,
        canUseFormulas: false,
        writePolicy: { canCreateNew: false, canDeleteSheets: false },
      } as SheetsPolicy;

    case "google_forms":
      return {
        canRead: true,
        canReadResponses: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      } as FormsPolicy;

    case "google_drive":
      return {
        canRead: true,
        canDownload: true,
        canUpload: false,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        canMove: false,
        canShare: false,
        sharePolicy: { noPublicSharing: true },
      } as GoogleDrivePolicy;

    case "onedrive":
      return {
        canRead: true,
        canDownload: true,
        canUpload: false,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        canMove: false,
        canShare: false,
        sharePolicy: { noAnonymousLinks: true },
      } as OneDrivePolicy;

    case "box":
      return {
        canRead: true,
        canDownload: true,
        canUpload: false,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        canMove: false,
        canShare: false,
        sharePolicy: { noOpenAccess: true },
      } as BoxPolicy;

    case "github":
      return {
        canReadRepos: true,
        canReadCode: true,
        canClone: true,
        canPush: false,
        canReadIssues: true,
        canCreateIssues: false,
        canCommentIssues: false,
        canCloseIssues: false,
        canReadPRs: true,
        canCreatePRs: false,
        canApprovePRs: false,
        canMergePRs: false,
        canCreateReleases: false,
        canTriggerActions: false,
        canCreateRepos: false,
        canDeleteRepos: false,
        canManageSettings: false,
      } as GitHubPolicy;

    case "browser":
      // Browser doesn't have a meaningful read-only mode
      // Return restrictive defaults - caller should provide URL patterns
      return {
        canNavigate: true,
        urlFilter: { mode: "allowlist" as const, patterns: [] },
        canClick: false,
        canType: false,
        canScroll: true,
        canScreenshot: true,
        canExtractText: true,
        canFillForms: false,
        canSubmitForms: false,
        canDownload: false,
        canUpload: false,
        canExecuteJs: false,
        canUseStoredCredentials: false,
        canInputCredentials: false,
        canReadCookies: false,
        canInspectNetwork: false,
        canModifyRequests: false,
      } as BrowserPolicy;

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${provider}`);
    }
  }
}

// ============================================
// Block Type to Provider Mapping (for canvas edge integration)
// ============================================

/**
 * Map dashboard block types to integration providers
 * Used for auto-attaching integrations when edges are drawn on canvas
 */
export const BLOCK_TYPE_TO_PROVIDER: Partial<Record<string, IntegrationProvider>> = {
  gmail: "gmail",
  calendar: "google_calendar",
  contacts: "google_contacts",
  sheets: "google_sheets",
  forms: "google_forms",
  browser: "browser",
  // google_drive is handled specially via workspace linking
};

/**
 * Check if a block type is an integration block
 */
export function isIntegrationBlockType(type: string): type is keyof typeof BLOCK_TYPE_TO_PROVIDER {
  return type in BLOCK_TYPE_TO_PROVIDER;
}

/**
 * Get the integration provider for a block type
 */
export function getProviderForBlockType(type: string): IntegrationProvider | null {
  return BLOCK_TYPE_TO_PROVIDER[type] ?? null;
}

/**
 * Get the block type for an integration provider
 */
export function getBlockTypeForProvider(provider: IntegrationProvider): string | null {
  for (const [blockType, prov] of Object.entries(BLOCK_TYPE_TO_PROVIDER)) {
    if (prov === provider) return blockType;
  }
  return null;
}
