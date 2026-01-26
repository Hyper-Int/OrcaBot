// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";
import type {
  DashboardTemplate,
  DashboardTemplateWithData,
  TemplateCategory,
} from "@/types/dashboard";

// ===== Response Types =====

interface TemplatesListResponse {
  templates: DashboardTemplate[];
}

interface TemplateResponse {
  template: DashboardTemplateWithData;
}

interface TemplateCreateResponse {
  template: {
    id: string;
    name: string;
    description: string;
    category: TemplateCategory;
    itemCount: number;
  };
}

interface TemplateCreateRequest {
  dashboardId: string;
  name: string;
  description?: string;
  category?: TemplateCategory;
}

// ===== Templates API =====

/**
 * List all available templates
 */
export async function listTemplates(
  category?: TemplateCategory
): Promise<DashboardTemplate[]> {
  const params = category ? `?category=${encodeURIComponent(category)}` : "";
  const response = await apiGet<TemplatesListResponse>(
    `${API.cloudflare.templates}${params}`
  );
  return response.templates;
}

/**
 * Get a template with full data (items and edges)
 */
export async function getTemplate(
  id: string
): Promise<DashboardTemplateWithData> {
  const response = await apiGet<TemplateResponse>(
    `${API.cloudflare.templates}/${id}`
  );
  return response.template;
}

/**
 * Export a dashboard as a template
 */
export async function createTemplate(data: TemplateCreateRequest): Promise<{
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  itemCount: number;
}> {
  const response = await apiPost<TemplateCreateResponse>(
    API.cloudflare.templates,
    data
  );
  return response.template;
}

/**
 * Delete a template (author only)
 */
export async function deleteTemplate(id: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.templates}/${id}`);
}
