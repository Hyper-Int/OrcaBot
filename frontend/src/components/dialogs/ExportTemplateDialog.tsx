// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Input,
  Textarea,
} from "@/components/ui";
import { createTemplate } from "@/lib/api/cloudflare/templates";
import type { TemplateCategory } from "@/types/dashboard";

interface ExportTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboardId: string;
  dashboardName: string;
  viewport?: { x: number; y: number; zoom: number };
}

const CATEGORIES: { value: TemplateCategory; label: string }[] = [
  { value: "coding", label: "Agentic Coding" },
  { value: "automation", label: "Automation" },
  { value: "documentation", label: "Documentation" },
  { value: "custom", label: "Custom" },
];

export function ExportTemplateDialog({
  open,
  onOpenChange,
  dashboardId,
  dashboardName,
  viewport,
}: ExportTemplateDialogProps) {
  const [name, setName] = React.useState(dashboardName);
  const [description, setDescription] = React.useState("");
  const [category, setCategory] = React.useState<TemplateCategory>("custom");

  // Reset form when dialog opens
  React.useEffect(() => {
    if (open) {
      setName(dashboardName);
      setDescription("");
      setCategory("custom");
    }
  }, [open, dashboardName]);

  const mutation = useMutation({
    mutationFn: () =>
      createTemplate({
        dashboardId,
        name,
        description,
        category,
        viewport,
      }),
    onSuccess: (result) => {
      toast.success(`Template "${result.name}" submitted for review. It will be visible to everyone once approved (usually within 24 hours).`);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to export template"
      );
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Template name is required");
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Export as Template</DialogTitle>
            <DialogDescription>
              Submit this dashboard layout for review. Once approved, it will
              be available to all users. Private content will be scrubbed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label
                htmlFor="template-name"
                className="text-sm font-medium text-[var(--foreground)]"
              >
                Template Name
              </label>
              <Input
                id="template-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Template"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="template-description"
                className="text-sm font-medium text-[var(--foreground)]"
              >
                Description
              </label>
              <Textarea
                id="template-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what this template is useful for..."
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="template-category"
                className="text-sm font-medium text-[var(--foreground)]"
              >
                Category
              </label>
              <select
                id="template-category"
                value={category}
                onChange={(e) =>
                  setCategory(e.target.value as TemplateCategory)
                }
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] focus:ring-offset-2"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="rounded-md bg-[var(--status-warning)]/10 border border-[var(--status-warning)]/20 p-3 text-sm">
              <p className="font-medium text-[var(--foreground)] mb-1">
                The following will be cleared:
              </p>
              <ul className="list-disc ml-4 text-[var(--foreground-muted)] space-y-0.5">
                <li>Note contents</li>
                <li>Todo item text</li>
                <li>Terminal session data</li>
                <li>Recipe configurations</li>
              </ul>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || !name.trim()}>
              {mutation.isPending ? "Submitting..." : "Submit for Review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
