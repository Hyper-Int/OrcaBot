// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  X,
  CheckCircle,
  XCircle,
  Filter,
  Clock,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getAuditLog,
  getDashboardAuditLog,
  type AuditLogEntry,
  type IntegrationProvider,
  getProviderDisplayName,
} from "@/lib/api/cloudflare/integration-policies";

// Decision badge colors
const getDecisionColor = (decision: AuditLogEntry["decision"]) => {
  switch (decision) {
    case "allowed":
      return "bg-green-100 text-green-800 border-green-200";
    case "denied":
      return "bg-red-100 text-red-800 border-red-200";
    case "filtered":
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200";
  }
};

const getDecisionIcon = (decision: AuditLogEntry["decision"]) => {
  switch (decision) {
    case "allowed":
      return <CheckCircle className="w-3 h-3 text-green-600" />;
    case "denied":
      return <XCircle className="w-3 h-3 text-red-600" />;
    case "filtered":
      return <Filter className="w-3 h-3 text-yellow-600" />;
    default:
      return null;
  }
};

// Format timestamp for display
const formatTime = (isoString: string) => {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// Single audit log entry row
const AuditLogRow: React.FC<{
  entry: AuditLogEntry;
  showProvider?: boolean;
}> = ({ entry, showProvider }) => {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div
      className={cn(
        "rounded border border-[var(--border)] bg-[var(--background)]",
        entry.decision === "denied" && "border-red-200"
      )}
    >
      <div
        className="flex items-start gap-2 px-2 py-1.5 cursor-pointer hover:bg-[var(--background-elevated)]"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-shrink-0 mt-0.5">{getDecisionIcon(entry.decision)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {showProvider && entry.provider && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--background-elevated)] border border-[var(--border)]">
                {getProviderDisplayName(entry.provider)}
              </span>
            )}
            <span className="text-xs font-medium truncate">{entry.action}</span>
            <span
              className={cn(
                "text-[10px] px-1 py-0.5 rounded border",
                getDecisionColor(entry.decision)
              )}
            >
              {entry.decision}
            </span>
          </div>
          {entry.requestSummary && (
            <div className="text-[10px] text-[var(--foreground-muted)] truncate mt-0.5">
              {entry.requestSummary}
            </div>
          )}
        </div>
        <div className="flex-shrink-0 flex items-center gap-1 text-[10px] text-[var(--foreground-muted)]">
          <Clock className="w-3 h-3" />
          {formatTime(entry.createdAt)}
        </div>
      </div>

      {expanded && (
        <div className="px-2 py-1.5 border-t border-[var(--border)] text-[10px] space-y-1 bg-[var(--background-elevated)]">
          <div className="flex gap-2">
            <span className="text-[var(--foreground-muted)]">ID:</span>
            <span className="font-mono">{entry.id}</span>
          </div>
          {entry.resourceId && (
            <div className="flex gap-2">
              <span className="text-[var(--foreground-muted)]">Resource:</span>
              <span className="font-mono">{entry.resourceId}</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-[var(--foreground-muted)]">Policy Version:</span>
            <span>{entry.policyVersion}</span>
          </div>
          {entry.denialReason && (
            <div className="flex gap-2">
              <span className="text-[var(--foreground-muted)]">Reason:</span>
              <span className="text-red-600">{entry.denialReason}</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-[var(--foreground-muted)]">Time:</span>
            <span>{new Date(entry.createdAt).toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
};

// Props for the main component
interface AuditLogViewerProps {
  dashboardId: string;
  terminalId?: string; // If provided, shows per-terminal/integration logs
  provider?: IntegrationProvider; // If provided with terminalId, shows per-integration logs
  onClose?: () => void;
  compact?: boolean; // Compact mode for embedding in panels
}

export const AuditLogViewer: React.FC<AuditLogViewerProps> = ({
  dashboardId,
  terminalId,
  provider,
  onClose,
  compact = false,
}) => {
  const [page, setPage] = React.useState(0);
  const [decisionFilter, setDecisionFilter] = React.useState<AuditLogEntry["decision"] | "all">(
    "all"
  );
  const pageSize = compact ? 10 : 25;

  // Query audit logs
  const auditQuery = useQuery({
    queryKey: ["audit-log", dashboardId, terminalId, provider, page, pageSize],
    queryFn: () => {
      if (terminalId && provider) {
        return getAuditLog(dashboardId, terminalId, provider, pageSize, page * pageSize);
      }
      return getDashboardAuditLog(dashboardId, pageSize, page * pageSize);
    },
    staleTime: 30000,
  });

  const entries = auditQuery.data || [];
  const filteredEntries =
    decisionFilter === "all" ? entries : entries.filter((e) => e.decision === decisionFilter);

  const showProvider = !provider; // Show provider column when viewing dashboard-wide logs

  const title = provider
    ? `${getProviderDisplayName(provider)} Audit Log`
    : terminalId
      ? "Terminal Audit Log"
      : "Dashboard Audit Log";

  if (compact) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-medium text-[var(--foreground-muted)] uppercase">
            Recent Activity
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => auditQuery.refetch()}
            disabled={auditQuery.isFetching}
            className="h-5 w-5"
          >
            <RefreshCw className={cn("w-3 h-3", auditQuery.isFetching && "animate-spin")} />
          </Button>
        </div>
        {auditQuery.isLoading ? (
          <div className="text-[10px] text-[var(--foreground-muted)]">Loading...</div>
        ) : filteredEntries.length === 0 ? (
          <div className="text-[10px] text-[var(--foreground-muted)]">No activity yet</div>
        ) : (
          <div className="space-y-1">
            {filteredEntries.slice(0, 5).map((entry) => (
              <AuditLogRow key={entry.id} entry={entry} showProvider={showProvider} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--background-elevated)] rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <span className="font-medium">{title}</span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => auditQuery.refetch()}
              disabled={auditQuery.isFetching}
            >
              <RefreshCw className={cn("w-4 h-4", auditQuery.isFetching && "animate-spin")} />
            </Button>
            {onClose && (
              <Button variant="ghost" size="icon-sm" onClick={onClose}>
                <X className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="px-4 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-xs text-[var(--foreground-muted)]">Filter:</span>
          {(["all", "allowed", "denied", "filtered"] as const).map((d) => (
            <Button
              key={d}
              variant={decisionFilter === d ? "secondary" : "ghost"}
              size="sm"
              className="text-[10px] h-6 px-2"
              onClick={() => setDecisionFilter(d)}
            >
              {d === "all" ? "All" : d.charAt(0).toUpperCase() + d.slice(1)}
            </Button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-2">
          {auditQuery.isLoading ? (
            <div className="text-sm text-[var(--foreground-muted)] text-center py-8">
              Loading audit log...
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="text-sm text-[var(--foreground-muted)] text-center py-8">
              {decisionFilter === "all"
                ? "No audit log entries yet"
                : `No ${decisionFilter} entries`}
            </div>
          ) : (
            filteredEntries.map((entry) => (
              <AuditLogRow key={entry.id} entry={entry} showProvider={showProvider} />
            ))
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--border)]">
          <div className="text-xs text-[var(--foreground-muted)]">
            Page {page + 1} &middot; {entries.length} entries
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={entries.length < pageSize}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AuditLogViewer;
