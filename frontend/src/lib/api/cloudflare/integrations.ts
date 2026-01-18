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
