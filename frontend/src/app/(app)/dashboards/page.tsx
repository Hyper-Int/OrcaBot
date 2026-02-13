// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
"use client";

// REVISION: desktop-header-v4-poll-all-paid-statuses
const MODULE_REVISION = "desktop-header-v4-poll-all-paid-statuses";
console.log(
  `[dashboards] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  FileText,
  Workflow,
  Trash2,
  LogOut,
  Code2,
  Boxes,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Shield,
  Settings,
  CheckCircle,
  XCircle,
  Clock,
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
import { PaywallDialog } from "@/components/subscription/PaywallDialog";
import { TrialBanner } from "@/components/subscription/TrialBanner";
import { API, DESKTOP_MODE } from "@/config/env";
import {
  listDashboards,
  createDashboard,
  deleteDashboard,
  listGlobalSecrets,
  createGlobalSecret,
  createGlobalEnvVar,
  deleteGlobalSecret,
  type UserSecret,
} from "@/lib/api/cloudflare";
import { listTemplates, deleteTemplate, approveTemplate } from "@/lib/api/cloudflare/templates";
import { formatRelativeTime, cn } from "@/lib/utils";
import type { Dashboard, TemplateCategory } from "@/types/dashboard";

export default function DashboardsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, logout, isAuthenticated, isAuthResolved, isAdmin, setUser } = useAuthStore();

  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const [newDashboardName, setNewDashboardName] = React.useState("");
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<string | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = React.useState<Dashboard | null>(null);
  const [deleteTemplateTarget, setDeleteTemplateTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [adminMode, setAdminMode] = React.useState(false);
  const [newSecretName, setNewSecretName] = React.useState("");
  const [newSecretValue, setNewSecretValue] = React.useState("");
  const [newEnvVarName, setNewEnvVarName] = React.useState("");
  const [newEnvVarValue, setNewEnvVarValue] = React.useState("");
  const [secretsSectionExpanded, setSecretsSectionExpanded] = React.useState(true);
  const [envVarsSectionExpanded, setEnvVarsSectionExpanded] = React.useState(true);

  // Redirect if not authenticated (skip in desktop mode — auto-login handles it)
  React.useEffect(() => {
    if (DESKTOP_MODE) return;
    if (!isAuthResolved) {
      return;
    }
    if (!isAuthenticated) {
      router.push("/login");
    }
  }, [isAuthenticated, isAuthResolved, router]);

  // Handle ?subscription=success — poll /users/me until subscription is active
  // (Stripe webhook may arrive after user is redirected back)
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("subscription") !== "success") return;

    // Remove the query param immediately
    const url = new URL(window.location.href);
    url.searchParams.delete("subscription");
    window.history.replaceState({}, "", url.toString());

    let cancelled = false;
    const POLL_INTERVALS = [0, 2000, 3000, 5000, 5000]; // immediate, then 2s, 3s, 5s, 5s

    const pollForActive = async () => {
      for (let attempt = 0; attempt < POLL_INTERVALS.length; attempt++) {
        if (cancelled) return;
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, POLL_INTERVALS[attempt]));
        }
        if (cancelled) return;

        try {
          const r = await fetch(API.cloudflare.usersMe, { credentials: "include" });
          if (!r.ok) continue;
          const data = (await r.json()) as {
            user?: { id: string; email: string; name: string; createdAt?: string };
            isAdmin?: boolean;
            subscription?: import("@/types").SubscriptionInfo;
          } | null;
          if (!data?.user) continue;

          const status = data.subscription?.status;
          if (status === "active" || status === "trialing" || status === "past_due" || status === "exempt") {
            setUser(data.user, data.isAdmin ?? false, data.subscription);
            toast.success("Subscription activated! Welcome to OrcaBot.");
            return;
          }
        } catch {
          // Network error — try again
        }
      }
      // Exhausted retries — update state with whatever we have and show info
      toast.info("Your payment is being processed. It may take a moment to activate.");
    };

    void pollForActive();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Fetch global secrets (all types)
  const secretsQuery = useQuery({
    queryKey: ["secrets", "_global"],
    queryFn: () => listGlobalSecrets(),
    enabled: isAuthenticated && isAuthResolved,
  });

  // Split into secrets (brokered) and env vars (non-brokered)
  const allSecrets = secretsQuery.data || [];
  const savedSecrets = allSecrets.filter((s: UserSecret) => s.type === 'secret' || !s.type); // Default to secret for backwards compat
  const savedEnvVars = allSecrets.filter((s: UserSecret) => s.type === 'env_var');

  // Helper to detect secret-like names for warning
  const looksLikeSecret = (name: string): boolean => {
    const patterns = ['_KEY', '_TOKEN', '_SECRET', 'API_KEY', 'ACCESS_KEY', 'PASSWORD', 'CREDENTIAL', 'AUTH_'];
    return patterns.some(pattern => name.toUpperCase().includes(pattern));
  };

  // Create dashboard mutation
  const createMutation = useMutation({
    mutationFn: ({ name, templateId }: { name: string; templateId?: string }) =>
      createDashboard(name, templateId),
    onSuccess: ({ dashboard, viewport }) => {
      queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      toast.success("Dashboard created");
      setIsCreateOpen(false);
      setNewDashboardName("");
      setSelectedTemplateId(undefined);
      // Stash template viewport so the dashboard page can restore it on load
      if (viewport) {
        sessionStorage.setItem(
          `template-viewport-${dashboard.id}`,
          JSON.stringify(viewport)
        );
      }
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

  // Delete template mutation (admin)
  const deleteTemplateMutation = useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast.success("Template deleted");
    },
    onError: (error) => {
      toast.error(`Failed to delete template: ${error.message}`);
    },
  });

  // Approve/reject template mutation (admin)
  const approveTemplateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'approved' | 'rejected' }) =>
      approveTemplate(id, status),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast.success(variables.status === 'approved' ? "Template approved" : "Template rejected");
    },
    onError: (error) => {
      toast.error(`Failed to update template: ${error.message}`);
    },
  });

  // Create secret mutation
  const createSecretMutation = useMutation({
    mutationFn: createGlobalSecret,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets", "_global"] });
      setNewSecretName("");
      setNewSecretValue("");
      toast.success("Secret saved");
    },
    onError: (error) => {
      toast.error(`Failed to create secret: ${error.message}`);
    },
  });

  // Delete secret mutation
  const deleteSecretMutation = useMutation({
    mutationFn: deleteGlobalSecret,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets", "_global"] });
      toast.success("Secret deleted");
    },
    onError: (error) => {
      toast.error(`Failed to delete secret: ${error.message}`);
    },
  });

  const handleAddSecret = () => {
    if (newSecretName.trim() && newSecretValue.trim()) {
      createSecretMutation.mutate({
        name: newSecretName.trim(),
        value: newSecretValue.trim(),
      });
    }
  };

  // Create env var mutation
  const createEnvVarMutation = useMutation({
    mutationFn: createGlobalEnvVar,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets", "_global"] });
      setNewEnvVarName("");
      setNewEnvVarValue("");
      toast.success("Environment variable saved");
    },
    onError: (error) => {
      toast.error(`Failed to create environment variable: ${error.message}`);
    },
  });

  const handleAddEnvVar = () => {
    if (newEnvVarName.trim() && newEnvVarValue.trim()) {
      createEnvVarMutation.mutate({
        name: newEnvVarName.trim(),
        value: newEnvVarValue.trim(),
      });
    }
  };

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
      <PaywallDialog />
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
              <TrialBanner />
              {isAdmin && (
                <Tooltip content={adminMode ? "Exit admin mode" : "Enter admin mode"}>
                  <Button
                  variant={adminMode ? "danger" : "ghost"}
                  size="sm"
                  onClick={() => setAdminMode(!adminMode)}
                  leftIcon={<Shield className="w-4 h-4" />}
                >
                  {adminMode ? "Admin" : "Admin"}
                </Button>
              </Tooltip>
            )}
              {!DESKTOP_MODE && (
                <div className="flex items-center gap-2">
                  <Avatar name={user?.name || "User"} size="sm" />
                  <span className="text-body-sm text-[var(--foreground-muted)]">
                    {user?.name}
                  </span>
                </div>
              )}
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
        {/* New Dashboard Section (Templates) */}
        <section className="mb-8">
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

            {/* Templates from API (admins see all, non-admins capped at 7) */}
            {(adminMode ? templates : templates?.slice(0, 7))?.map((template) => (
              <NewDashboardCard
                key={template.id}
                icon={getCategoryIcon(template.category)}
                title={template.name}
                description={
                  template.description || `${template.itemCount} blocks`
                }
                status={adminMode ? template.status : undefined}
                onClick={() => {
                  setSelectedTemplateId(template.id);
                  setNewDashboardName(template.name);
                  setIsCreateOpen(true);
                }}
                onDelete={adminMode ? () => setDeleteTemplateTarget({ id: template.id, name: template.name }) : undefined}
                onApprove={adminMode && template.status === 'pending_review'
                  ? () => approveTemplateMutation.mutate({ id: template.id, status: 'approved' })
                  : undefined}
                onReject={adminMode && template.status !== 'rejected'
                  ? () => approveTemplateMutation.mutate({ id: template.id, status: 'rejected' })
                  : undefined}
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

        {/* Two-column layout: Dashboards (left) + Environment Variables (right) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Your Dashboards Section */}
          <section>
            <h2 className="text-h2 text-[var(--foreground)] mb-4">
              Your Dashboards
            </h2>

            {isLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-24" />
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

          {/* Secrets & Environment Variables Section */}
          <section>
            <h2 className="text-h2 text-[var(--foreground)] mb-4">
              Secrets & Environment Variables
            </h2>
            <Card className="p-5">
              <p className="text-caption text-[var(--foreground-muted)] mb-4">
                Secrets and environment variables that will be auto-applied to all new terminals.
              </p>

              <div className="space-y-4">
                {/* ========== SECRETS SECTION (brokered) ========== */}
                <div className="border border-[var(--border)] rounded-lg">
                  <button
                    type="button"
                    onClick={() => setSecretsSectionExpanded(!secretsSectionExpanded)}
                    className="flex items-center justify-between w-full px-4 py-3 hover:bg-[var(--background-elevated)] transition-colors rounded-t-lg"
                  >
                    <div className="flex items-center gap-2">
                      {secretsSectionExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      <Shield className="w-4 h-4 text-[var(--status-success)]" />
                      <span className="font-medium">Secrets</span>
                      <span className="text-sm text-[var(--foreground-muted)]">({savedSecrets.length})</span>
                    </div>
                    <span className="text-sm text-[var(--foreground-muted)]">API keys, tokens</span>
                  </button>
                  {secretsSectionExpanded && (
                    <div className="border-t border-[var(--border)] p-4 space-y-4">
                      <p className="text-sm text-[var(--foreground-muted)]">
                        Secrets are brokered - the LLM cannot read them directly.
                      </p>
                      {/* Add new secret form */}
                      <div className="flex gap-2">
                        <div className="w-1/3 min-w-0">
                          <Input
                            placeholder="NAME"
                            value={newSecretName}
                            onChange={(e) => setNewSecretName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                            className="w-full font-mono"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            data-form-type="other"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <Input
                            type="text"
                            placeholder="Value"
                            value={newSecretValue}
                            onChange={(e) => setNewSecretValue(e.target.value)}
                            className="w-full"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            data-form-type="other"
                            style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
                          />
                        </div>
                        <Button
                          variant="secondary"
                          size="icon-sm"
                          onClick={handleAddSecret}
                          disabled={
                            !newSecretName.trim() ||
                            !newSecretValue.trim() ||
                            createSecretMutation.isPending
                          }
                          className="shrink-0"
                        >
                          <Plus className="w-4 h-4" />
                        </Button>
                      </div>
                      {/* Secrets list */}
                      <div className="space-y-2 max-h-40 overflow-auto">
                        {secretsQuery.isLoading && (
                          <div className="text-sm text-[var(--foreground-muted)]">Loading...</div>
                        )}
                        {!secretsQuery.isLoading && savedSecrets.length === 0 && (
                          <div className="text-sm text-[var(--foreground-muted)] text-center py-4">
                            No secrets configured yet.
                          </div>
                        )}
                        {savedSecrets.map((secret) => (
                          <div
                            key={secret.id}
                            className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <Shield className="w-4 h-4 text-[var(--status-success)] flex-shrink-0" />
                              <span className="text-sm font-mono truncate">{secret.name}</span>
                              <span className="text-sm text-[var(--foreground-muted)]">=</span>
                              <span className="text-sm text-[var(--foreground-muted)]">••••••••</span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => deleteSecretMutation.mutate(secret.id)}
                              className="text-[var(--status-error)] hover:text-[var(--status-error)] shrink-0"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* ========== ENVIRONMENT VARIABLES SECTION (non-brokered) ========== */}
                <div className="border border-[var(--border)] rounded-lg">
                  <button
                    type="button"
                    onClick={() => setEnvVarsSectionExpanded(!envVarsSectionExpanded)}
                    className="flex items-center justify-between w-full px-4 py-3 hover:bg-[var(--background-elevated)] transition-colors rounded-t-lg"
                  >
                    <div className="flex items-center gap-2">
                      {envVarsSectionExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      <Settings className="w-4 h-4 text-[var(--foreground-muted)]" />
                      <span className="font-medium">Environment Variables</span>
                      <span className="text-sm text-[var(--foreground-muted)]">({savedEnvVars.length})</span>
                    </div>
                    <span className="text-sm text-[var(--foreground-muted)]">Config values</span>
                  </button>
                  {envVarsSectionExpanded && (
                    <div className="border-t border-[var(--border)] p-4 space-y-4">
                      <p className="text-sm text-[var(--foreground-muted)]">
                        Environment variables are set directly - the LLM can read them.
                      </p>
                      {/* Warning for secret-like names */}
                      {newEnvVarName && looksLikeSecret(newEnvVarName) && (
                        <div className="flex items-start gap-2 rounded border border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 px-3 py-2">
                          <AlertCircle className="w-4 h-4 text-[var(--status-warning)] flex-shrink-0 mt-0.5" />
                          <div className="text-sm text-[var(--foreground)]">
                            <span className="font-medium">{newEnvVarName}</span> looks like an API key or secret.
                            Consider adding it to <span className="font-medium">Secrets</span> instead for protection.
                          </div>
                        </div>
                      )}
                      {/* Add new env var form */}
                      <div className="flex gap-2">
                        <div className="w-1/3 min-w-0">
                          <Input
                            placeholder="NAME"
                            value={newEnvVarName}
                            onChange={(e) => setNewEnvVarName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                            className="w-full font-mono"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            data-form-type="other"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <Input
                            type="text"
                            placeholder="Value"
                            value={newEnvVarValue}
                            onChange={(e) => setNewEnvVarValue(e.target.value)}
                            className="w-full"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            data-form-type="other"
                          />
                        </div>
                        <Button
                          variant="secondary"
                          size="icon-sm"
                          onClick={handleAddEnvVar}
                          disabled={
                            !newEnvVarName.trim() ||
                            !newEnvVarValue.trim() ||
                            createEnvVarMutation.isPending
                          }
                          className="shrink-0"
                        >
                          <Plus className="w-4 h-4" />
                        </Button>
                      </div>
                      {/* Env vars list */}
                      <div className="space-y-2 max-h-40 overflow-auto">
                        {secretsQuery.isLoading && (
                          <div className="text-sm text-[var(--foreground-muted)]">Loading...</div>
                        )}
                        {!secretsQuery.isLoading && savedEnvVars.length === 0 && (
                          <div className="text-sm text-[var(--foreground-muted)] text-center py-4">
                            No environment variables configured yet.
                          </div>
                        )}
                        {savedEnvVars.map((envVar) => (
                          <div
                            key={envVar.id}
                            className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-mono truncate">{envVar.name}</span>
                              <span className="text-sm text-[var(--foreground-muted)]">=</span>
                              <span className="text-sm text-[var(--foreground-muted)]">••••••••</span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => deleteSecretMutation.mutate(envVar.id)}
                              className="text-[var(--status-error)] hover:text-[var(--status-error)] shrink-0"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          </section>
        </div>
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

      {/* Delete Template Confirmation Dialog (admin) */}
      <Dialog
        open={!!deleteTemplateTarget}
        onOpenChange={(open) => !open && setDeleteTemplateTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Template</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the template "{deleteTemplateTarget?.name}"? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTemplateTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              isLoading={deleteTemplateMutation.isPending}
              onClick={() => {
                if (deleteTemplateTarget) {
                  deleteTemplateMutation.mutate(deleteTemplateTarget.id, {
                    onSuccess: () => setDeleteTemplateTarget(null),
                  });
                }
              }}
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
  onDelete?: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  status?: string;
}

function NewDashboardCard({
  icon,
  title,
  description,
  onClick,
  onDelete,
  onApprove,
  onReject,
  status,
}: NewDashboardCardProps) {
  return (
    <div className="relative group">
      <button
        onClick={onClick}
        className={cn(
          "flex flex-col items-center justify-center p-6 rounded-[var(--radius-card)] w-full",
          "bg-[var(--background-elevated)] border border-[var(--border)]",
          "hover:bg-[var(--background-hover)] hover:border-[var(--border-strong)]",
          "transition-colors cursor-pointer text-center",
          status === 'pending_review' && "border-[var(--status-warning)]/40",
          status === 'rejected' && "border-[var(--status-error)]/40 opacity-60"
        )}
      >
        <div className="mb-3 text-[var(--foreground-muted)]">{icon}</div>
        <h3 className="text-h4 text-[var(--foreground)] mb-1">{title}</h3>
        <p className="text-caption text-[var(--foreground-subtle)]">
          {description}
        </p>
        {status === 'pending_review' && (
          <span className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--status-warning)]/20 text-[var(--status-warning)] text-xs font-medium">
            <Clock className="w-3 h-3" />
            Pending Review
          </span>
        )}
        {status === 'rejected' && (
          <span className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--status-error)]/20 text-[var(--status-error)] text-xs font-medium">
            <XCircle className="w-3 h-3" />
            Rejected
          </span>
        )}
      </button>
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
        {onApprove && (
          <button
            onClick={(e) => { e.stopPropagation(); onApprove(); }}
            className="p-1 hover:bg-[var(--background-hover)] rounded"
            title="Approve template"
          >
            <CheckCircle className="w-4 h-4 text-[var(--status-success)]" />
          </button>
        )}
        {onReject && (
          <button
            onClick={(e) => { e.stopPropagation(); onReject(); }}
            className="p-1 hover:bg-[var(--background-hover)] rounded"
            title="Reject template"
          >
            <XCircle className="w-4 h-4 text-[var(--status-warning)]" />
          </button>
        )}
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 hover:bg-[var(--background-hover)] rounded"
          >
            <Trash2 className="w-4 h-4 text-[var(--foreground-subtle)] hover:text-[var(--status-error)]" />
          </button>
        )}
      </div>
    </div>
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
