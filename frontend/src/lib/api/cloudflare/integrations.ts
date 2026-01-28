// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { apiFetch, apiGet, apiPost } from "@/lib/api/client";
import { API } from "@/config/env";

export interface GoogleDriveFolder {
  id: string;
  name: string;
  linked_at?: string;
}

export interface GoogleDriveIntegration {
  connected: boolean;
  linked?: boolean;
  folder: GoogleDriveFolder | null;
}

export interface GoogleDriveLargeFile {
  id: string;
  path: string;
  size: number;
}

export interface GoogleDriveSyncStatus {
  connected: boolean;
  folder?: GoogleDriveFolder | null;
  status?: string;
  totalFiles?: number;
  totalBytes?: number;
  cacheSyncedFiles?: number;
  cacheSyncedBytes?: number;
  workspaceSyncedFiles?: number;
  workspaceSyncedBytes?: number;
  largeFiles?: GoogleDriveLargeFile[];
  lastSyncAt?: string | null;
  syncError?: string | null;
}

export interface GoogleDriveManifest {
  version: number;
  folderId: string;
  folderName: string;
  folderPath: string;
  updatedAt: string;
  directories: string[];
  entries: Array<{
    id: string;
    name: string;
    path: string;
    mimeType: string;
    size: number;
    modifiedTime: string | null;
  }>;
}

export interface GoogleDriveManifestResponse {
  connected: boolean;
  folder?: GoogleDriveFolder | null;
  manifest?: GoogleDriveManifest | null;
}

export interface GithubRepo {
  id: string | number;
  owner: string;
  name: string;
  fullName?: string;
  branch?: string;
  private?: boolean;
  linked_at?: string;
}

export interface GithubIntegration {
  connected: boolean;
  linked?: boolean;
  repo: GithubRepo | null;
}

export interface GithubSyncStatus {
  connected: boolean;
  repo?: GithubRepo | null;
  status?: string;
  totalFiles?: number;
  totalBytes?: number;
  cacheSyncedFiles?: number;
  cacheSyncedBytes?: number;
  workspaceSyncedFiles?: number;
  workspaceSyncedBytes?: number;
  largeFiles?: GoogleDriveLargeFile[];
  lastSyncAt?: string | null;
  syncError?: string | null;
}

export interface GithubManifestResponse {
  connected: boolean;
  repo?: GithubRepo | null;
  manifest?: GoogleDriveManifest | null;
}

export interface BoxFolder {
  id: string;
  name: string;
  linked_at?: string;
}

export interface BoxIntegration {
  connected: boolean;
  linked?: boolean;
  folder: BoxFolder | null;
}

export interface BoxSyncStatus {
  connected: boolean;
  folder?: BoxFolder | null;
  status?: string;
  totalFiles?: number;
  totalBytes?: number;
  cacheSyncedFiles?: number;
  cacheSyncedBytes?: number;
  workspaceSyncedFiles?: number;
  workspaceSyncedBytes?: number;
  largeFiles?: GoogleDriveLargeFile[];
  lastSyncAt?: string | null;
  syncError?: string | null;
}

export interface BoxManifestResponse {
  connected: boolean;
  folder?: BoxFolder | null;
  manifest?: GoogleDriveManifest | null;
}

export interface OnedriveFolder {
  id: string;
  name: string;
  linked_at?: string;
}

export interface OnedriveIntegration {
  connected: boolean;
  linked?: boolean;
  folder: OnedriveFolder | null;
}

export interface OnedriveSyncStatus {
  connected: boolean;
  folder?: OnedriveFolder | null;
  status?: string;
  totalFiles?: number;
  totalBytes?: number;
  cacheSyncedFiles?: number;
  cacheSyncedBytes?: number;
  workspaceSyncedFiles?: number;
  workspaceSyncedBytes?: number;
  largeFiles?: GoogleDriveLargeFile[];
  lastSyncAt?: string | null;
  syncError?: string | null;
}

export interface OnedriveManifestResponse {
  connected: boolean;
  folder?: OnedriveFolder | null;
  manifest?: GoogleDriveManifest | null;
}

export async function getGoogleDriveIntegration(
  dashboardId?: string
): Promise<GoogleDriveIntegration> {
  const url = new URL(API.cloudflare.googleDriveIntegration);
  if (dashboardId) {
    url.searchParams.set("dashboard_id", dashboardId);
  }
  return apiGet<GoogleDriveIntegration>(url.toString());
}

export async function unlinkGoogleDriveFolder(
  dashboardId: string
): Promise<{ ok: boolean }> {
  const url = new URL(API.cloudflare.googleDriveFolder);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

export async function disconnectGoogleDrive(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(API.cloudflare.googleDriveDisconnect, {
    method: "DELETE",
  });
}

export async function getGoogleDriveSyncStatus(
  dashboardId: string
): Promise<GoogleDriveSyncStatus> {
  const url = new URL(API.cloudflare.googleDriveStatus);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<GoogleDriveSyncStatus>(url.toString());
}

export async function getGoogleDriveManifest(
  dashboardId: string
): Promise<GoogleDriveManifestResponse> {
  const url = new URL(API.cloudflare.googleDriveManifest);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<GoogleDriveManifestResponse>(url.toString());
}

export async function getGithubIntegration(
  dashboardId?: string
): Promise<GithubIntegration> {
  const url = new URL(API.cloudflare.githubIntegration);
  if (dashboardId) {
    url.searchParams.set("dashboard_id", dashboardId);
  }
  return apiGet<GithubIntegration>(url.toString());
}

export async function listGithubRepos(): Promise<{ connected: boolean; repos: GithubRepo[]; error?: string }> {
  return apiGet<{ connected: boolean; repos: GithubRepo[]; error?: string }>(API.cloudflare.githubRepos);
}

export async function setGithubRepo(
  dashboardId: string,
  repo: GithubRepo
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.githubRepo, {
    dashboardId,
    repoId: repo.id,
    repoOwner: repo.owner,
    repoName: repo.name,
    repoBranch: repo.branch,
  });
}

export async function unlinkGithubRepo(
  dashboardId: string
): Promise<{ ok: boolean }> {
  const url = new URL(API.cloudflare.githubRepo);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

export async function disconnectGithub(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(API.cloudflare.githubDisconnect, {
    method: "DELETE",
  });
}

export async function getGithubSyncStatus(
  dashboardId: string
): Promise<GithubSyncStatus> {
  const url = new URL(API.cloudflare.githubStatus);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<GithubSyncStatus>(url.toString());
}

export async function syncGithub(dashboardId: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.githubSync, { dashboardId });
}

export async function syncGithubLargeFiles(
  dashboardId: string,
  fileIds: string[]
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.githubSyncLarge, {
    dashboardId,
    fileIds,
  });
}

export async function getGithubManifest(
  dashboardId: string
): Promise<GithubManifestResponse> {
  const url = new URL(API.cloudflare.githubManifest);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<GithubManifestResponse>(url.toString());
}

export async function getBoxIntegration(
  dashboardId?: string
): Promise<BoxIntegration> {
  const url = new URL(API.cloudflare.boxIntegration);
  if (dashboardId) {
    url.searchParams.set("dashboard_id", dashboardId);
  }
  return apiGet<BoxIntegration>(url.toString());
}

export async function listBoxFolders(
  parentId?: string
): Promise<{ connected: boolean; parentId: string; folders: BoxFolder[] }> {
  const url = new URL(API.cloudflare.boxFolders);
  if (parentId) {
    url.searchParams.set("parent_id", parentId);
  }
  return apiGet<{ connected: boolean; parentId: string; folders: BoxFolder[] }>(url.toString());
}

export async function setBoxFolder(
  dashboardId: string,
  folder: BoxFolder
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.boxFolder, {
    dashboardId,
    folderId: folder.id,
    folderName: folder.name,
  });
}

export async function unlinkBoxFolder(
  dashboardId: string
): Promise<{ ok: boolean }> {
  const url = new URL(API.cloudflare.boxFolder);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

export async function disconnectBox(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(API.cloudflare.boxDisconnect, {
    method: "DELETE",
  });
}

export async function getBoxSyncStatus(
  dashboardId: string
): Promise<BoxSyncStatus> {
  const url = new URL(API.cloudflare.boxStatus);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<BoxSyncStatus>(url.toString());
}

export async function syncBox(dashboardId: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.boxSync, { dashboardId });
}

export async function syncBoxLargeFiles(
  dashboardId: string,
  fileIds: string[]
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.boxSyncLarge, {
    dashboardId,
    fileIds,
  });
}

export async function getBoxManifest(
  dashboardId: string
): Promise<BoxManifestResponse> {
  const url = new URL(API.cloudflare.boxManifest);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<BoxManifestResponse>(url.toString());
}

export async function getOnedriveIntegration(
  dashboardId?: string
): Promise<OnedriveIntegration> {
  const url = new URL(API.cloudflare.onedriveIntegration);
  if (dashboardId) {
    url.searchParams.set("dashboard_id", dashboardId);
  }
  return apiGet<OnedriveIntegration>(url.toString());
}

export async function listOnedriveFolders(
  parentId?: string
): Promise<{ connected: boolean; parentId: string; folders: OnedriveFolder[] }> {
  const url = new URL(API.cloudflare.onedriveFolders);
  if (parentId) {
    url.searchParams.set("parent_id", parentId);
  }
  return apiGet<{ connected: boolean; parentId: string; folders: OnedriveFolder[] }>(url.toString());
}

export async function setOnedriveFolder(
  dashboardId: string,
  folder: OnedriveFolder
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.onedriveFolder, {
    dashboardId,
    folderId: folder.id,
    folderName: folder.name,
  });
}

export async function unlinkOnedriveFolder(
  dashboardId: string
): Promise<{ ok: boolean }> {
  const url = new URL(API.cloudflare.onedriveFolder);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

export async function disconnectOnedrive(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(API.cloudflare.onedriveDisconnect, {
    method: "DELETE",
  });
}

export async function getOnedriveSyncStatus(
  dashboardId: string
): Promise<OnedriveSyncStatus> {
  const url = new URL(API.cloudflare.onedriveStatus);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<OnedriveSyncStatus>(url.toString());
}

export async function syncOnedrive(dashboardId: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.onedriveSync, { dashboardId });
}

export async function syncOnedriveLargeFiles(
  dashboardId: string,
  fileIds: string[]
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.onedriveSyncLarge, {
    dashboardId,
    fileIds,
  });
}

export async function getOnedriveManifest(
  dashboardId: string
): Promise<OnedriveManifestResponse> {
  const url = new URL(API.cloudflare.onedriveManifest);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<OnedriveManifestResponse>(url.toString());
}

export async function syncGoogleDrive(dashboardId: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.googleDriveSync, { dashboardId });
}

export async function syncGoogleDriveLargeFiles(
  dashboardId: string,
  fileIds: string[]
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.googleDriveSyncLarge, {
    dashboardId,
    fileIds,
  });
}

// ============================================
// Gmail Integration
// ============================================

export interface GmailMessage {
  messageId: string;
  threadId: string;
  internalDate: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  snippet: string | null;
  labels: string[];
  sizeEstimate: number;
  bodyState: "none" | "snippet" | "full";
}

export interface GmailIntegration {
  connected: boolean;
  linked: boolean;
  emailAddress: string | null;
  labelIds?: string[];
  status?: string;
  lastSyncedAt?: string | null;
  watchExpiration?: string | null;
}

export interface GmailStatus {
  connected: boolean;
  emailAddress?: string;
  labelIds?: string[];
  historyId?: string | null;
  watchExpiration?: string | null;
  watchActive?: boolean;
  status?: string;
  lastSyncedAt?: string | null;
  syncError?: string | null;
  messageCount?: number;
}

export interface GmailMessagesResponse {
  messages: GmailMessage[];
  total: number;
  limit: number;
  offset: number;
}

export interface GmailMessageDetail {
  messageId: string;
  threadId: string;
  labels: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string };
    }>;
  };
  internalDate?: string;
  sizeEstimate?: number;
}

export type GmailActionType =
  | "archive"
  | "trash"
  | "mark_read"
  | "mark_unread"
  | "label_add"
  | "label_remove";

export async function getGmailIntegration(
  dashboardId?: string
): Promise<GmailIntegration> {
  const url = new URL(API.cloudflare.gmailIntegration);
  if (dashboardId) {
    url.searchParams.set("dashboard_id", dashboardId);
  }
  return apiGet<GmailIntegration>(url.toString());
}

export async function setupGmailMirror(
  dashboardId: string,
  labelIds?: string[]
): Promise<{ ok: boolean; emailAddress: string }> {
  return apiPost<{ ok: boolean; emailAddress: string }>(
    API.cloudflare.gmailSetup,
    {
      dashboardId,
      labelIds,
    }
  );
}

export async function unlinkGmailMirror(
  dashboardId: string
): Promise<{ ok: boolean }> {
  const url = new URL(API.cloudflare.gmailIntegration);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

export async function getGmailStatus(dashboardId: string): Promise<GmailStatus> {
  const url = new URL(API.cloudflare.gmailStatus);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<GmailStatus>(url.toString());
}

export async function syncGmail(
  dashboardId: string
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.gmailSync, { dashboardId });
}

export async function getGmailMessages(
  dashboardId: string,
  options?: { limit?: number; offset?: number }
): Promise<GmailMessagesResponse> {
  const url = new URL(API.cloudflare.gmailMessages);
  url.searchParams.set("dashboard_id", dashboardId);
  if (options?.limit) {
    url.searchParams.set("limit", String(options.limit));
  }
  if (options?.offset) {
    url.searchParams.set("offset", String(options.offset));
  }
  return apiGet<GmailMessagesResponse>(url.toString());
}

export async function getGmailMessageDetail(
  dashboardId: string,
  messageId: string,
  format?: "metadata" | "full"
): Promise<GmailMessageDetail> {
  const url = new URL(API.cloudflare.gmailMessage);
  url.searchParams.set("dashboard_id", dashboardId);
  url.searchParams.set("message_id", messageId);
  if (format) {
    url.searchParams.set("format", format);
  }
  return apiGet<GmailMessageDetail>(url.toString());
}

export async function performGmailAction(
  dashboardId: string,
  messageId: string,
  action: GmailActionType,
  labelIds?: string[]
): Promise<{ ok: boolean; labels: string[] }> {
  return apiPost<{ ok: boolean; labels: string[] }>(API.cloudflare.gmailAction, {
    dashboardId,
    messageId,
    action,
    labelIds,
  });
}

export async function startGmailWatch(
  dashboardId: string
): Promise<{ ok: boolean; historyId: string; expiration: string }> {
  return apiPost<{ ok: boolean; historyId: string; expiration: string }>(
    API.cloudflare.gmailWatch,
    { dashboardId }
  );
}

export async function stopGmailWatch(
  dashboardId: string
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.gmailStop, { dashboardId });
}

export async function disconnectGmail(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(API.cloudflare.gmailDisconnect, {
    method: "DELETE",
  });
}

// ============================================
// Google Calendar Integration
// ============================================

export interface CalendarEvent {
  eventId: string;
  calendarId: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  allDay: boolean;
  status: string | null;
  htmlLink: string | null;
  organizerEmail: string | null;
  attendees: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
  }>;
}

export interface CalendarIntegration {
  connected: boolean;
  linked: boolean;
  emailAddress: string | null;
  calendarId?: string;
  status?: string;
  lastSyncedAt?: string | null;
}

export interface CalendarStatus {
  connected: boolean;
  emailAddress?: string;
  calendarId?: string;
  status?: string;
  lastSyncedAt?: string | null;
  syncError?: string | null;
  eventCount?: number;
}

export interface CalendarEventsResponse {
  events: CalendarEvent[];
  total: number;
  limit: number;
  offset: number;
}

export async function getCalendarIntegration(
  dashboardId?: string
): Promise<CalendarIntegration> {
  const url = new URL(API.cloudflare.calendarIntegration);
  if (dashboardId) {
    url.searchParams.set("dashboard_id", dashboardId);
  }
  return apiGet<CalendarIntegration>(url.toString());
}

export async function setupCalendarMirror(
  dashboardId: string,
  calendarId?: string
): Promise<{ ok: boolean; emailAddress: string }> {
  return apiPost<{ ok: boolean; emailAddress: string }>(
    API.cloudflare.calendarSetup,
    {
      dashboardId,
      calendarId,
    }
  );
}

export async function unlinkCalendarMirror(
  dashboardId: string
): Promise<{ ok: boolean }> {
  const url = new URL(API.cloudflare.calendarIntegration);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

export async function getCalendarStatus(dashboardId: string): Promise<CalendarStatus> {
  const url = new URL(API.cloudflare.calendarStatus);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<CalendarStatus>(url.toString());
}

export async function syncCalendar(
  dashboardId: string
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.calendarSync, { dashboardId });
}

export async function getCalendarEvents(
  dashboardId: string,
  options?: { limit?: number; offset?: number; timeMin?: string; timeMax?: string }
): Promise<CalendarEventsResponse> {
  const url = new URL(API.cloudflare.calendarEvents);
  url.searchParams.set("dashboard_id", dashboardId);
  if (options?.limit) {
    url.searchParams.set("limit", String(options.limit));
  }
  if (options?.offset) {
    url.searchParams.set("offset", String(options.offset));
  }
  if (options?.timeMin) {
    url.searchParams.set("time_min", options.timeMin);
  }
  if (options?.timeMax) {
    url.searchParams.set("time_max", options.timeMax);
  }
  return apiGet<CalendarEventsResponse>(url.toString());
}

export async function getCalendarEventDetail(
  dashboardId: string,
  eventId: string
): Promise<CalendarEvent> {
  const url = new URL(API.cloudflare.calendarEvent);
  url.searchParams.set("dashboard_id", dashboardId);
  url.searchParams.set("event_id", eventId);
  return apiGet<CalendarEvent>(url.toString());
}

export async function disconnectCalendar(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(API.cloudflare.calendarDisconnect, {
    method: "DELETE",
  });
}

// ============================================
// Google Contacts Integration
// ============================================

export interface Contact {
  resourceName: string;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  emailAddresses: Array<{ value?: string; type?: string }>;
  phoneNumbers: Array<{ value?: string; type?: string }>;
  organizations: Array<{ name?: string; title?: string }>;
  photoUrl: string | null;
  notes: string | null;
}

export interface ContactsIntegration {
  connected: boolean;
  linked: boolean;
  emailAddress: string | null;
  status?: string;
  lastSyncedAt?: string | null;
}

export interface ContactsStatus {
  connected: boolean;
  emailAddress?: string;
  status?: string;
  lastSyncedAt?: string | null;
  syncError?: string | null;
  contactCount?: number;
}

export interface ContactsResponse {
  contacts: Contact[];
  total: number;
  limit: number;
  offset: number;
}

export async function getContactsIntegration(
  dashboardId?: string
): Promise<ContactsIntegration> {
  const url = new URL(API.cloudflare.contactsIntegration);
  if (dashboardId) {
    url.searchParams.set("dashboard_id", dashboardId);
  }
  return apiGet<ContactsIntegration>(url.toString());
}

export async function setupContactsMirror(
  dashboardId: string
): Promise<{ ok: boolean; emailAddress: string }> {
  return apiPost<{ ok: boolean; emailAddress: string }>(
    API.cloudflare.contactsSetup,
    { dashboardId }
  );
}

export async function unlinkContactsMirror(
  dashboardId: string
): Promise<{ ok: boolean }> {
  const url = new URL(API.cloudflare.contactsIntegration);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

export async function getContactsStatus(dashboardId: string): Promise<ContactsStatus> {
  const url = new URL(API.cloudflare.contactsStatus);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiGet<ContactsStatus>(url.toString());
}

export async function syncContacts(
  dashboardId: string
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.contactsSync, { dashboardId });
}

export async function getContacts(
  dashboardId: string,
  options?: { limit?: number; offset?: number; search?: string }
): Promise<ContactsResponse> {
  const url = new URL(API.cloudflare.contactsList);
  url.searchParams.set("dashboard_id", dashboardId);
  if (options?.limit) {
    url.searchParams.set("limit", String(options.limit));
  }
  if (options?.offset) {
    url.searchParams.set("offset", String(options.offset));
  }
  if (options?.search) {
    url.searchParams.set("search", options.search);
  }
  return apiGet<ContactsResponse>(url.toString());
}

export async function getContactDetail(
  dashboardId: string,
  resourceName: string
): Promise<Contact> {
  const url = new URL(API.cloudflare.contactsDetail);
  url.searchParams.set("dashboard_id", dashboardId);
  url.searchParams.set("resource_name", resourceName);
  return apiGet<Contact>(url.toString());
}

export async function searchContacts(
  dashboardId: string,
  query: string
): Promise<{ contacts: Contact[] }> {
  const url = new URL(API.cloudflare.contactsSearch);
  url.searchParams.set("dashboard_id", dashboardId);
  url.searchParams.set("q", query);
  return apiGet<{ contacts: Contact[] }>(url.toString());
}

export async function disconnectContacts(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(API.cloudflare.contactsDisconnect, {
    method: "DELETE",
  });
}

// ============================================
// Google Sheets Integration
// ============================================

export interface Spreadsheet {
  spreadsheetId: string;
  name: string;
  url: string;
  sheets: Array<{
    sheetId: number;
    title: string;
    index: number;
    rowCount?: number;
    columnCount?: number;
  }>;
}

export interface SheetsIntegration {
  connected: boolean;
  linked: boolean;
  emailAddress: string | null;
  spreadsheetId?: string;
  spreadsheetName?: string;
  status?: string;
}

export interface SpreadsheetListResponse {
  connected: boolean;
  spreadsheets: Array<{
    id: string;
    name: string;
  }>;
}

export interface SheetValues {
  range: string;
  values: unknown[][];
  majorDimension?: "ROWS" | "COLUMNS";
}

export async function getSheetsIntegration(
  dashboardId?: string
): Promise<SheetsIntegration> {
  const url = new URL(API.cloudflare.sheetsIntegration);
  if (dashboardId) {
    url.searchParams.set("dashboard_id", dashboardId);
  }
  return apiGet<SheetsIntegration>(url.toString());
}

export async function setupSheetsMirror(
  dashboardId: string
): Promise<{ ok: boolean; emailAddress: string }> {
  return apiPost<{ ok: boolean; emailAddress: string }>(
    API.cloudflare.sheetsSetup,
    { dashboardId }
  );
}

export async function unlinkSheetsMirror(
  dashboardId: string
): Promise<{ ok: boolean }> {
  const url = new URL(API.cloudflare.sheetsIntegration);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

export async function listSpreadsheets(): Promise<SpreadsheetListResponse> {
  return apiGet<SpreadsheetListResponse>(API.cloudflare.sheetsList);
}

export async function getSpreadsheet(dashboardId: string, spreadsheetId: string): Promise<Spreadsheet> {
  const url = new URL(API.cloudflare.sheetsSpreadsheet);
  url.searchParams.set("dashboard_id", dashboardId);
  url.searchParams.set("spreadsheet_id", spreadsheetId);
  return apiGet<Spreadsheet>(url.toString());
}

export async function readSheetValues(
  dashboardId: string,
  spreadsheetId: string,
  range: string
): Promise<SheetValues> {
  const url = new URL(API.cloudflare.sheetsValues);
  url.searchParams.set("dashboard_id", dashboardId);
  url.searchParams.set("spreadsheet_id", spreadsheetId);
  url.searchParams.set("range", range);
  return apiGet<SheetValues>(url.toString());
}

export async function writeSheetValues(
  spreadsheetId: string,
  range: string,
  values: unknown[][]
): Promise<{ ok: boolean; updatedCells: number }> {
  return apiPost<{ ok: boolean; updatedCells: number }>(
    API.cloudflare.sheetsValues,
    { spreadsheetId, range, values }
  );
}

export async function appendSheetValues(
  spreadsheetId: string,
  range: string,
  values: unknown[][]
): Promise<{ ok: boolean; updatedRange: string; updatedRows: number }> {
  return apiPost<{ ok: boolean; updatedRange: string; updatedRows: number }>(
    API.cloudflare.sheetsAppend,
    { spreadsheetId, range, values }
  );
}

export async function setLinkedSpreadsheet(
  dashboardId: string,
  spreadsheetId: string,
  spreadsheetName: string
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.sheetsLink, {
    dashboardId,
    spreadsheetId,
    spreadsheetName,
  });
}

export async function disconnectSheets(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(API.cloudflare.sheetsDisconnect, {
    method: "DELETE",
  });
}

// ============================================
// Google Forms Integration
// ============================================

export interface FormQuestion {
  questionId: string;
  required?: boolean;
  choiceQuestion?: { type: string; options: Array<{ value: string }> };
  textQuestion?: { paragraph: boolean };
  scaleQuestion?: { low: number; high: number };
  dateQuestion?: { includeTime: boolean; includeYear: boolean };
  timeQuestion?: { duration: boolean };
}

export interface FormItem {
  itemId: string;
  title?: string;
  description?: string;
  question?: FormQuestion;
}

export interface Form {
  formId: string;
  title: string;
  description?: string;
  documentTitle?: string;
  responderUri?: string;
  items: FormItem[];
}

export interface FormResponse {
  responseId: string;
  respondentEmail?: string;
  submittedAt: string;
  answers?: Record<string, {
    questionId: string;
    textAnswers?: { answers: Array<{ value: string }> };
  }>;
}

export interface FormsIntegration {
  connected: boolean;
  linked: boolean;
  emailAddress: string | null;
  formId?: string;
  formTitle?: string;
  status?: string;
}

export interface FormsListResponse {
  connected: boolean;
  forms: Array<{ id: string; name: string }>;
}

export interface FormResponsesResponse {
  total: number;
  responses: FormResponse[];
}

export async function getFormsIntegration(
  dashboardId?: string
): Promise<FormsIntegration> {
  const url = new URL(API.cloudflare.formsIntegration);
  if (dashboardId) {
    url.searchParams.set("dashboard_id", dashboardId);
  }
  return apiGet<FormsIntegration>(url.toString());
}

export async function setupFormsMirror(
  dashboardId: string
): Promise<{ ok: boolean; emailAddress: string }> {
  return apiPost<{ ok: boolean; emailAddress: string }>(
    API.cloudflare.formsSetup,
    { dashboardId }
  );
}

export async function unlinkFormsMirror(
  dashboardId: string
): Promise<{ ok: boolean }> {
  const url = new URL(API.cloudflare.formsIntegration);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

export async function listForms(): Promise<FormsListResponse> {
  return apiGet<FormsListResponse>(API.cloudflare.formsList);
}

export async function getForm(formId: string): Promise<Form> {
  const url = new URL(API.cloudflare.formsForm);
  url.searchParams.set("form_id", formId);
  return apiGet<Form>(url.toString());
}

export async function getFormResponses(
  dashboardId: string,
  formId: string
): Promise<FormResponsesResponse> {
  const url = new URL(API.cloudflare.formsResponses);
  url.searchParams.set("dashboard_id", dashboardId);
  url.searchParams.set("form_id", formId);
  return apiGet<FormResponsesResponse>(url.toString());
}

export async function setLinkedForm(
  dashboardId: string,
  formId: string,
  formTitle: string
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(API.cloudflare.formsLink, {
    dashboardId,
    formId,
    formTitle,
  });
}

export async function disconnectForms(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(API.cloudflare.formsDisconnect, {
    method: "DELETE",
  });
}
