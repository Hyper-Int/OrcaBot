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

export async function listGithubRepos(): Promise<{ connected: boolean; repos: GithubRepo[] }> {
  return apiGet<{ connected: boolean; repos: GithubRepo[] }>(API.cloudflare.githubRepos);
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
