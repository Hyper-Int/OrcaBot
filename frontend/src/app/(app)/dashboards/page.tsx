// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  FileText,
  Terminal,
  Workflow,
  Trash2,
  LogOut,
  Code2,
  Bot,
  Boxes,
} from "lucide-react";
import { toast } from "sonner";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
  Avatar,
  ThemeToggle,
  Tooltip,
} from "@/components/ui";
import { useAuthStore } from "@/stores/auth-store";
import { API } from "@/config/env";
import { listDashboards, createDashboard, deleteDashboard } from "@/lib/api/cloudflare";
import { listTemplates } from "@/lib/api/cloudflare/templates";
import { formatRelativeTime, cn } from "@/lib/utils";
import type { Dashboard, DashboardTemplate, TemplateCategory } from "@/types/dashboard";

export default function DashboardsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, logout, isAuthenticated, isAuthResolved } = useAuthStore();

  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const [newDashboardName, setNewDashboardName] = React.useState("");
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<string | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = React.useState<Dashboard | null>(null);

  // Redirect if not authenticated
  React.useEffect(() => {
    if (!isAuthResolved) {
      return;
    }
    if (!isAuthenticated) {
      router.push("/login");
    }
  }, [isAuthenticated, isAuthResolved, router]);

  // Fetch dashboards
  const {
    data: dashboards,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["dashboards"],
    queryFn: listDashboards,
    enabled: isAuthenticated && isAuthResolved,
  });

  // Fetch templates
  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: () => listTemplates(),
    enabled: isAuthenticated && isAuthResolved,
  });

  // Create dashboard mutation
  const createMutation = useMutation({
    mutationFn: ({ name, templateId }: { name: string; templateId?: string }) =>
      createDashboard(name, templateId),
    onSuccess: (dashboard) => {
      queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast.success("Dashboard created");
      setIsCreateOpen(false);
      setNewDashboardName("");
      setSelectedTemplateId(undefined);
      router.push(`/dashboards/${dashboard.id}`);
    },
    onError: (error) => {
      toast.error(`Failed to create dashboard: ${error.message}`);
    },
  });

  // Delete dashboard mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteDashboard(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast.success("Dashboard deleted");
      setDeleteTarget(null);
    },
    onError: (error) => {
      toast.error(`Failed to delete dashboard: ${error.message}`);
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (newDashboardName.trim()) {
      createMutation.mutate({
        name: newDashboardName.trim(),
        templateId: selectedTemplateId,
      });
    }
  };

  // Helper function to get icon for template category
  const getCategoryIcon = (category: TemplateCategory) => {
    switch (category) {
      case "coding":
        return <Code2 className="w-6 h-6" />;
      case "automation":
        return <Workflow className="w-6 h-6" />;
      case "documentation":
        return <FileText className="w-6 h-6" />;
      default:
        return <Boxes className="w-6 h-6" />;
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${API.cloudflare.base}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Ignore logout errors and clear local state anyway.
    }
    logout();
    router.push("/login");
  };

  if (!isAuthResolved || !isAuthenticated) {
    return null;
  }

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="border-b border-[var(--border)] bg-[var(--background-elevated)]">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/orca.png"
              alt="Orcabot"
              className="w-7 h-7 object-contain"
            />
            <span className="text-h4 text-[var(--foreground)]">OrcaBot</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Avatar name={user?.name || "User"} size="sm" />
              <span className="text-body-sm text-[var(--foreground-muted)]">
                {user?.name}
              </span>
            </div>
            <Tooltip content="Toggle theme">
              <ThemeToggle />
            </Tooltip>
            <Tooltip content="Log out">
              <Button variant="ghost" size="icon-sm" onClick={handleLogout}>
                <LogOut className="w-4 h-4" />
              </Button>
            </Tooltip>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* New Dashboard Section */}
        <section className="mb-12">
          <h2 className="text-h2 text-[var(--foreground)] mb-4">
            New Dashboard
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Blank dashboard option */}
            <NewDashboardCard
              icon={<Plus className="w-6 h-6" />}
              title="Blank"
              description="Start from scratch"
              onClick={() => {
                setSelectedTemplateId(undefined);
                setIsCreateOpen(true);
              }}
            />

            {/* Templates from API */}
            {templates?.slice(0, 7).map((template) => (
              <NewDashboardCard
                key={template.id}
                icon={getCategoryIcon(template.category)}
                title={template.name}
                description={
                  template.description || `${template.itemCount} blocks`
                }
                onClick={() => {
                  setSelectedTemplateId(template.id);
                  setNewDashboardName(template.name);
                  setIsCreateOpen(true);
                }}
              />
            ))}

            {/* Show placeholder cards when no templates exist */}
            {(!templates || templates.length === 0) && (
              <>
                <NewDashboardCard
                  icon={<Code2 className="w-6 h-6" />}
                  title="Agentic Coding"
                  description="AI-assisted dev setup"
                  onClick={() => {
                    setSelectedTemplateId(undefined);
                    setNewDashboardName("Agentic Coding");
                    setIsCreateOpen(true);
                  }}
                />
                <NewDashboardCard
                  icon={<Workflow className="w-6 h-6" />}
                  title="Automation"
                  description="Workflow orchestration"
                  onClick={() => {
                    setSelectedTemplateId(undefined);
                    setNewDashboardName("Automation");
                    setIsCreateOpen(true);
                  }}
                />
                <NewDashboardCard
                  icon={<FileText className="w-6 h-6" />}
                  title="Documentation"
                  description="Notes and links"
                  onClick={() => {
                    setSelectedTemplateId(undefined);
                    setNewDashboardName("Documentation");
                    setIsCreateOpen(true);
                  }}
                />
              </>
            )}
          </div>
        </section>

        {/* Your Dashboards Section */}
        <section>
          <h2 className="text-h2 text-[var(--foreground)] mb-4">
            Your Dashboards
          </h2>

          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-32" />
              ))}
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-body text-[var(--status-error)]">
                Failed to load dashboards. Please try again.
              </p>
              <Button
                variant="secondary"
                className="mt-4"
                onClick={() =>
                  queryClient.invalidateQueries({ queryKey: ["dashboards"] })
                }
              >
                Retry
              </Button>
            </div>
          ) : dashboards && dashboards.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {dashboards.map((dashboard) => (
                <DashboardCard
                  key={dashboard.id}
                  dashboard={dashboard}
                  onClick={() => router.push(`/dashboards/${dashboard.id}`)}
                  onDelete={() => setDeleteTarget(dashboard)}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-12 border border-dashed border-[var(--border)] rounded-lg">
              <p className="text-body text-[var(--foreground-muted)] mb-4">
                No dashboards yet. Create your first one!
              </p>
              <Button
                variant="primary"
                onClick={() => setIsCreateOpen(true)}
                leftIcon={<Plus className="w-4 h-4" />}
              >
                New Dashboard
              </Button>
            </div>
          )}
        </section>
      </main>

      {/* Create Dashboard Dialog */}
      <Dialog
        open={isCreateOpen}
        onOpenChange={(open) => {
          setIsCreateOpen(open);
          if (!open) {
            setSelectedTemplateId(undefined);
            setNewDashboardName("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Dashboard</DialogTitle>
            <DialogDescription>
              {selectedTemplateId
                ? "Creating from template. Give your dashboard a name."
                : "Give your new dashboard a name to get started."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="py-4 space-y-4">
              <Input
                placeholder="Dashboard name"
                value={newDashboardName}
                onChange={(e) => setNewDashboardName(e.target.value)}
                autoFocus
              />
              {selectedTemplateId && (
                <div className="flex items-center justify-between text-sm text-[var(--foreground-muted)] bg-[var(--background)] rounded-md px-3 py-2 border border-[var(--border)]">
                  <span>
                    Using template:{" "}
                    <span className="font-medium text-[var(--foreground)]">
                      {templates?.find((t) => t.id === selectedTemplateId)?.name}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedTemplateId(undefined)}
                    className="text-xs text-[var(--foreground-subtle)] hover:text-[var(--foreground)] underline"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                isLoading={createMutation.isPending}
                disabled={!newDashboardName.trim()}
              >
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Dashboard</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              isLoading={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ===== Sub-components =====

interface NewDashboardCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}

function NewDashboardCard({
  icon,
  title,
  description,
  onClick,
}: NewDashboardCardProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center justify-center p-6 rounded-[var(--radius-card)]",
        "bg-[var(--background-elevated)] border border-[var(--border)]",
        "hover:bg-[var(--background-hover)] hover:border-[var(--border-strong)]",
        "transition-colors cursor-pointer text-center"
      )}
    >
      <div className="mb-3 text-[var(--foreground-muted)]">{icon}</div>
      <h3 className="text-h4 text-[var(--foreground)] mb-1">{title}</h3>
      <p className="text-caption text-[var(--foreground-subtle)]">
        {description}
      </p>
    </button>
  );
}

interface DashboardCardProps {
  dashboard: Dashboard;
  onClick: () => void;
  onDelete: () => void;
}

function DashboardCard({ dashboard, onClick, onDelete }: DashboardCardProps) {
  return (
    <Card className="group cursor-pointer hover:border-[var(--border-strong)] transition-colors">
      <div onClick={onClick}>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <CardTitle className="truncate pr-2">{dashboard.name}</CardTitle>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-[var(--background-hover)] rounded transition-all"
            >
              <Trash2 className="w-4 h-4 text-[var(--foreground-subtle)] hover:text-[var(--status-error)]" />
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-caption text-[var(--foreground-subtle)]">
            Updated {formatRelativeTime(dashboard.updatedAt)}
          </p>
        </CardContent>
      </div>
    </Card>
  );
}
