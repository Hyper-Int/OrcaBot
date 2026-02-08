// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Plus, AlertTriangle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  updateIntegrationPolicy,
  type TerminalIntegration,
  type IntegrationProvider,
  type AnyPolicy,
  type GmailPolicy,
  type CalendarPolicy,
  type ContactsPolicy,
  type SheetsPolicy,
  type FormsPolicy,
  type GoogleDrivePolicy,
  type OneDrivePolicy,
  type BoxPolicy,
  type GitHubPolicy,
  type BrowserPolicy,
  type MessagingPolicy,
  type SecurityLevel,
  getProviderDisplayName,
  getSecurityLevelColor,
  getSecurityLevelText,
  HIGH_RISK_CAPABILITIES,
} from "@/lib/api/cloudflare/integration-policies";

// Helper component for toggles
const Toggle: React.FC<{
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  warning?: boolean;
}> = ({ label, checked, onChange, description, warning }) => (
  <label className="flex items-start gap-2 cursor-pointer">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 rounded"
    />
    <div>
      <span className={cn("text-xs", warning && checked && "text-yellow-700")}>{label}</span>
      {description && (
        <div className="text-[10px] text-[var(--foreground-muted)]">{description}</div>
      )}
    </div>
  </label>
);

// Helper component for sections
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-2">
    <div className="text-xs font-medium text-[var(--foreground-muted)] uppercase">{title}</div>
    <div className="space-y-1.5">{children}</div>
  </div>
);

// Helper for domain list input
const DomainListInput: React.FC<{
  label: string;
  domains: string[];
  onChange: (domains: string[]) => void;
  placeholder?: string;
}> = ({ label, domains, onChange, placeholder = "example.com" }) => {
  const [newDomain, setNewDomain] = React.useState("");

  const addDomain = () => {
    if (newDomain.trim() && !domains.includes(newDomain.trim().toLowerCase())) {
      onChange([...domains, newDomain.trim().toLowerCase()]);
      setNewDomain("");
    }
  };

  return (
    <div className="space-y-1">
      <label className="text-[10px] text-[var(--foreground-muted)]">{label}</label>
      <div className="flex flex-wrap gap-1">
        {domains.map((domain, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--background)] border border-[var(--border)] text-[10px]"
          >
            {domain}
            <button
              onClick={() => onChange(domains.filter((_, j) => j !== i))}
              className="hover:text-red-600"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addDomain())}
          placeholder={placeholder}
          className="flex-1 px-2 py-1 text-[10px] rounded border border-[var(--border)] bg-[var(--background)]"
        />
        <Button variant="ghost" size="icon-sm" onClick={addDomain} className="h-6 w-6">
          <Plus className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
};

// Gmail Policy Editor
const GmailPolicyEditor: React.FC<{
  policy: GmailPolicy;
  onChange: (policy: GmailPolicy) => void;
}> = ({ policy, onChange }) => {
  const update = <K extends keyof GmailPolicy>(key: K, value: GmailPolicy[K]) => {
    onChange({ ...policy, [key]: value });
  };

  return (
    <div className="space-y-4">
      <Section title="Reading">
        <Toggle label="Can read emails" checked={policy.canRead} onChange={(v) => update("canRead", v)} />
        {policy.canRead && (
          <div className="pl-4 space-y-2">
            <div className="text-[10px] text-[var(--foreground-muted)]">
              Filter by sender (optional):
            </div>
            <select
              className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
              value={policy.senderFilter?.mode || "all"}
              onChange={(e) =>
                update("senderFilter", {
                  mode: e.target.value as "all" | "allowlist" | "blocklist",
                  domains: policy.senderFilter?.domains || [],
                })
              }
            >
              <option value="all">All senders</option>
              <option value="allowlist">Only these domains</option>
              <option value="blocklist">Block these domains</option>
            </select>
            {policy.senderFilter?.mode !== "all" && (
              <DomainListInput
                label={policy.senderFilter?.mode === "allowlist" ? "Allowed domains" : "Blocked domains"}
                domains={policy.senderFilter?.domains || []}
                onChange={(domains) =>
                  update("senderFilter", { ...policy.senderFilter!, domains })
                }
              />
            )}
          </div>
        )}
      </Section>

      <Section title="Actions">
        <Toggle label="Can archive" checked={policy.canArchive} onChange={(v) => update("canArchive", v)} />
        <Toggle label="Can mark as read" checked={policy.canMarkRead} onChange={(v) => update("canMarkRead", v)} />
        <Toggle label="Can add labels" checked={policy.canLabel} onChange={(v) => update("canLabel", v)} />
        <Toggle
          label="Can trash emails"
          checked={policy.canTrash}
          onChange={(v) => update("canTrash", v)}
          warning
          description="Moves emails to trash"
        />
      </Section>

      <Section title="Sending">
        <Toggle
          label="Can send emails"
          checked={policy.canSend}
          onChange={(v) => update("canSend", v)}
          warning
          description="Send emails on your behalf"
        />
        {policy.canSend && (
          <div className="pl-4 space-y-2">
            <DomainListInput
              label="Allowed recipient domains (empty = all)"
              domains={policy.sendPolicy?.allowedDomains || []}
              onChange={(domains) =>
                update("sendPolicy", { ...policy.sendPolicy, allowedDomains: domains })
              }
            />
            <DomainListInput
              label="Required CC (always CC these addresses)"
              domains={policy.sendPolicy?.requiredCc || []}
              onChange={(requiredCc) =>
                update("sendPolicy", { ...policy.sendPolicy, requiredCc })
              }
              placeholder="manager@company.com"
            />
          </div>
        )}
      </Section>
    </div>
  );
};

// Calendar Policy Editor
const CalendarPolicyEditor: React.FC<{
  policy: CalendarPolicy;
  onChange: (policy: CalendarPolicy) => void;
}> = ({ policy, onChange }) => {
  const update = <K extends keyof CalendarPolicy>(key: K, value: CalendarPolicy[K]) => {
    onChange({ ...policy, [key]: value });
  };

  return (
    <div className="space-y-4">
      <Section title="Reading">
        <Toggle label="Can read events" checked={policy.canRead} onChange={(v) => update("canRead", v)} />
      </Section>

      <Section title="Creating">
        <Toggle
          label="Can create events"
          checked={policy.canCreate}
          onChange={(v) => update("canCreate", v)}
          description="Create new calendar events"
        />
      </Section>

      <Section title="Modifying">
        <Toggle label="Can update events" checked={policy.canUpdate} onChange={(v) => update("canUpdate", v)} />
        <Toggle
          label="Can delete events"
          checked={policy.canDelete}
          onChange={(v) => update("canDelete", v)}
          warning
          description="Permanently delete calendar events"
        />
      </Section>
    </div>
  );
};

// GitHub Policy Editor
const GitHubPolicyEditor: React.FC<{
  policy: GitHubPolicy;
  onChange: (policy: GitHubPolicy) => void;
}> = ({ policy, onChange }) => {
  const update = <K extends keyof GitHubPolicy>(key: K, value: GitHubPolicy[K]) => {
    onChange({ ...policy, [key]: value });
  };

  return (
    <div className="space-y-4">
      <Section title="Repository Access">
        <Toggle label="Can read repositories" checked={policy.canReadRepos} onChange={(v) => update("canReadRepos", v)} />
        <Toggle label="Can read code" checked={policy.canReadCode} onChange={(v) => update("canReadCode", v)} />
        <Toggle label="Can clone" checked={policy.canClone} onChange={(v) => update("canClone", v)} />
      </Section>

      <Section title="Code Operations">
        <Toggle
          label="Can push code"
          checked={policy.canPush}
          onChange={(v) => update("canPush", v)}
          warning
          description="Push commits to repositories"
        />
        {policy.canPush && (
          <div className="pl-4">
            <DomainListInput
              label="Blocked branches (can't push to)"
              domains={policy.pushPolicy?.blockedBranches || []}
              onChange={(blockedBranches) =>
                update("pushPolicy", { ...policy.pushPolicy, blockedBranches })
              }
              placeholder="main, production"
            />
          </div>
        )}
      </Section>

      <Section title="Issues & PRs">
        <Toggle label="Can read issues" checked={policy.canReadIssues} onChange={(v) => update("canReadIssues", v)} />
        <Toggle label="Can create issues" checked={policy.canCreateIssues} onChange={(v) => update("canCreateIssues", v)} />
        <Toggle label="Can comment on issues" checked={policy.canCommentIssues} onChange={(v) => update("canCommentIssues", v)} />
        <Toggle label="Can read PRs" checked={policy.canReadPRs} onChange={(v) => update("canReadPRs", v)} />
        <Toggle label="Can create PRs" checked={policy.canCreatePRs} onChange={(v) => update("canCreatePRs", v)} />
        <Toggle
          label="Can approve PRs"
          checked={policy.canApprovePRs}
          onChange={(v) => update("canApprovePRs", v)}
          warning
        />
        <Toggle
          label="Can merge PRs"
          checked={policy.canMergePRs}
          onChange={(v) => update("canMergePRs", v)}
          warning
          description="Merge pull requests"
        />
      </Section>
    </div>
  );
};

// Browser Policy Editor
const BrowserPolicyEditor: React.FC<{
  policy: BrowserPolicy;
  onChange: (policy: BrowserPolicy) => void;
}> = ({ policy, onChange }) => {
  const update = <K extends keyof BrowserPolicy>(key: K, value: BrowserPolicy[K]) => {
    onChange({ ...policy, [key]: value });
  };

  return (
    <div className="space-y-4">
      <Section title="URL Access">
        <div className="flex items-center gap-2 p-2 rounded bg-yellow-100/20 border border-yellow-500/30">
          <AlertTriangle className="w-4 h-4 text-yellow-600 flex-shrink-0" />
          <span className="text-[10px] text-yellow-700">Browser requires URL allowlist</span>
        </div>
        <DomainListInput
          label="Allowed URL patterns"
          domains={policy.urlFilter?.patterns || []}
          onChange={(patterns) =>
            update("urlFilter", { mode: "allowlist", patterns })
          }
          placeholder="https://example.com/*"
        />
      </Section>

      <Section title="Interaction">
        <Toggle label="Can navigate" checked={policy.canNavigate} onChange={(v) => update("canNavigate", v)} />
        <Toggle label="Can click" checked={policy.canClick} onChange={(v) => update("canClick", v)} />
        <Toggle label="Can type" checked={policy.canType} onChange={(v) => update("canType", v)} />
        <Toggle label="Can scroll" checked={policy.canScroll} onChange={(v) => update("canScroll", v)} />
        <Toggle label="Can screenshot" checked={policy.canScreenshot} onChange={(v) => update("canScreenshot", v)} />
        <Toggle label="Can extract text" checked={policy.canExtractText} onChange={(v) => update("canExtractText", v)} />
      </Section>

      <Section title="Forms">
        <Toggle label="Can fill forms" checked={policy.canFillForms} onChange={(v) => update("canFillForms", v)} />
        <Toggle
          label="Can submit forms"
          checked={policy.canSubmitForms}
          onChange={(v) => update("canSubmitForms", v)}
          warning
          description="Submit form data to websites"
        />
      </Section>

      <Section title="Files & Security">
        <Toggle label="Can download files" checked={policy.canDownload} onChange={(v) => update("canDownload", v)} />
        <Toggle
          label="Can upload files"
          checked={policy.canUpload}
          onChange={(v) => update("canUpload", v)}
          warning
        />
        <Toggle
          label="Can execute JavaScript"
          checked={policy.canExecuteJs}
          onChange={(v) => update("canExecuteJs", v)}
          warning
          description="Run JavaScript in page context"
        />
        <Toggle
          label="Can input credentials"
          checked={policy.canInputCredentials}
          onChange={(v) => update("canInputCredentials", v)}
          warning
          description="Type passwords and login credentials"
        />
      </Section>
    </div>
  );
};

// Generic Drive Policy Editor (works for Google Drive, OneDrive, Box)
const DrivePolicyEditor: React.FC<{
  policy: GoogleDrivePolicy | OneDrivePolicy | BoxPolicy;
  onChange: (policy: GoogleDrivePolicy | OneDrivePolicy | BoxPolicy) => void;
  providerName: string;
}> = ({ policy, onChange, providerName }) => {
  const update = <K extends keyof (GoogleDrivePolicy | OneDrivePolicy | BoxPolicy)>(
    key: K,
    value: (GoogleDrivePolicy | OneDrivePolicy | BoxPolicy)[K]
  ) => {
    onChange({ ...policy, [key]: value } as GoogleDrivePolicy | OneDrivePolicy | BoxPolicy);
  };

  return (
    <div className="space-y-4">
      <Section title="Reading">
        <Toggle label="Can read files" checked={policy.canRead} onChange={(v) => update("canRead", v)} />
        <Toggle label="Can download files" checked={policy.canDownload} onChange={(v) => update("canDownload", v)} />
      </Section>

      <Section title="Writing">
        <Toggle label="Can upload files" checked={policy.canUpload} onChange={(v) => update("canUpload", v)} />
        <Toggle label="Can create files/folders" checked={policy.canCreate} onChange={(v) => update("canCreate", v)} />
        <Toggle label="Can update files" checked={policy.canUpdate} onChange={(v) => update("canUpdate", v)} />
        <Toggle label="Can move files" checked={policy.canMove} onChange={(v) => update("canMove", v)} />
        <Toggle
          label="Can delete files"
          checked={policy.canDelete}
          onChange={(v) => update("canDelete", v)}
          warning
          description="Permanently delete files"
        />
      </Section>

      <Section title="Sharing">
        <Toggle
          label="Can share files"
          checked={policy.canShare}
          onChange={(v) => update("canShare", v)}
          warning
          description="Share files with others"
        />
      </Section>
    </div>
  );
};

// Messaging Policy Editor (Slack, Discord, Telegram, etc.)
const MessagingPolicyEditor: React.FC<{
  policy: MessagingPolicy;
  onChange: (policy: MessagingPolicy) => void;
  providerName: string;
}> = ({ policy, onChange, providerName }) => {
  const update = <K extends keyof MessagingPolicy>(key: K, value: MessagingPolicy[K]) => {
    onChange({ ...policy, [key]: value });
  };

  return (
    <div className="space-y-4">
      <Section title="Receiving">
        <Toggle
          label="Can receive messages"
          checked={policy.canReceive ?? false}
          onChange={(v) => update("canReceive", v)}
          description={`Receive inbound messages from ${providerName}`}
        />
        <Toggle
          label="Can read history"
          checked={policy.canReadHistory ?? false}
          onChange={(v) => update("canReadHistory", v)}
          description="Read past messages in channels"
        />
        {(policy.canReceive || policy.canReadHistory) && (
          <div className="pl-4 space-y-2">
            <div className="text-[10px] text-[var(--foreground-muted)]">Channel access:</div>
            <select
              className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
              value={policy.channelFilter?.mode || "allowlist"}
              onChange={(e) =>
                update("channelFilter", {
                  mode: e.target.value as "all" | "allowlist",
                  channelIds: policy.channelFilter?.channelIds || [],
                  channelNames: policy.channelFilter?.channelNames || [],
                })
              }
            >
              <option value="all">All channels</option>
              <option value="allowlist">Only specific channels</option>
            </select>
            {policy.channelFilter?.mode === "allowlist" && (
              <DomainListInput
                label="Allowed channels"
                domains={policy.channelFilter?.channelNames || []}
                onChange={(names) =>
                  update("channelFilter", { ...policy.channelFilter!, channelNames: names })
                }
                placeholder="#channel-name"
              />
            )}
          </div>
        )}
      </Section>

      <Section title="Sending">
        <Toggle
          label="Can send messages"
          checked={policy.canSend ?? false}
          onChange={(v) => update("canSend", v)}
          warning
          description={`Send messages on your behalf in ${providerName}`}
        />
        {policy.canSend && (
          <div className="pl-4 space-y-2">
            <Toggle
              label="Require thread reply"
              checked={policy.sendPolicy?.requireThreadReply ?? false}
              onChange={(v) =>
                update("sendPolicy", { ...policy.sendPolicy, requireThreadReply: v })
              }
              description="Only allow replies in threads, not new top-level messages"
            />
          </div>
        )}
      </Section>

      <Section title="Actions">
        <Toggle
          label="Can react"
          checked={policy.canReact ?? false}
          onChange={(v) => update("canReact", v)}
          description="Add emoji reactions to messages"
        />
        <Toggle
          label="Can upload files"
          checked={policy.canUploadFiles ?? false}
          onChange={(v) => update("canUploadFiles", v)}
          warning
        />
        <Toggle
          label="Can edit messages"
          checked={policy.canEditMessages ?? false}
          onChange={(v) => update("canEditMessages", v)}
          warning
          description="Edit previously sent messages"
        />
        <Toggle
          label="Can delete messages"
          checked={policy.canDeleteMessages ?? false}
          onChange={(v) => update("canDeleteMessages", v)}
          warning
          description="Permanently delete messages"
        />
      </Section>
    </div>
  );
};

// Generic Simple Policy Editor (for Contacts, Sheets, Forms)
const SimplePolicyEditor: React.FC<{
  policy: ContactsPolicy | SheetsPolicy | FormsPolicy;
  onChange: (policy: ContactsPolicy | SheetsPolicy | FormsPolicy) => void;
  hasDelete?: boolean;
}> = ({ policy, onChange, hasDelete = true }) => {
  const update = (key: string, value: boolean) => {
    onChange({ ...policy, [key]: value } as ContactsPolicy | SheetsPolicy | FormsPolicy);
  };

  const p = policy as unknown as Record<string, boolean>;

  return (
    <div className="space-y-4">
      <Section title="Reading">
        <Toggle label="Can read" checked={p.canRead ?? false} onChange={(v) => update("canRead", v)} />
        {"canReadResponses" in policy && (
          <Toggle
            label="Can read responses"
            checked={(policy as FormsPolicy).canReadResponses ?? false}
            onChange={(v) => update("canReadResponses", v)}
          />
        )}
      </Section>

      <Section title="Writing">
        {"canCreate" in policy && (
          <Toggle label="Can create" checked={p.canCreate ?? false} onChange={(v) => update("canCreate", v)} />
        )}
        {"canUpdate" in policy && (
          <Toggle label="Can update" checked={p.canUpdate ?? false} onChange={(v) => update("canUpdate", v)} />
        )}
        {"canWrite" in policy && (
          <Toggle label="Can write" checked={p.canWrite ?? false} onChange={(v) => update("canWrite", v)} />
        )}
        {hasDelete && "canDelete" in policy && (
          <Toggle
            label="Can delete"
            checked={p.canDelete ?? false}
            onChange={(v) => update("canDelete", v)}
            warning
          />
        )}
      </Section>
    </div>
  );
};

// Main Policy Editor Dialog
interface PolicyEditorDialogProps {
  integration: TerminalIntegration;
  dashboardId: string;
  terminalId: string;
  onClose: () => void;
  onSuccess: () => void;
  /** Called with new security level after policy update, for syncing edge data */
  onPolicyUpdate?: (provider: IntegrationProvider, securityLevel: SecurityLevel) => void;
}

export const PolicyEditorDialog: React.FC<PolicyEditorDialogProps> = ({
  integration,
  dashboardId,
  terminalId,
  onClose,
  onSuccess,
  onPolicyUpdate,
}) => {
  const [policy, setPolicy] = React.useState<AnyPolicy>(integration.policy || ({} as AnyPolicy));

  const updateMutation = useMutation({
    mutationFn: (data: { policy: AnyPolicy; highRiskConfirmations?: string[] }) =>
      updateIntegrationPolicy(dashboardId, terminalId, integration.provider, data),
    onSuccess: (result) => {
      // Notify parent to update edge data with new security level
      onPolicyUpdate?.(integration.provider, result.securityLevel);
      onSuccess();
      onClose();
    },
  });

  const handleSave = () => {
    // Auto-confirm all high-risk capabilities that are enabled in the policy.
    // Enabling a toggle in the editor IS the user's explicit confirmation.
    const providerCaps = HIGH_RISK_CAPABILITIES[integration.provider] || [];
    const policyObj = policy as unknown as Record<string, unknown>;
    const confirmations = providerCaps.filter((cap) => {
      const parts = cap.split(".");
      let value: unknown = policyObj;
      for (const part of parts) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[part];
        } else {
          return false;
        }
      }
      return Boolean(value);
    });

    updateMutation.mutate({
      policy,
      highRiskConfirmations: confirmations,
    });
  };

  // Render appropriate editor based on provider
  const renderEditor = () => {
    switch (integration.provider) {
      case "gmail":
        return (
          <GmailPolicyEditor
            policy={policy as GmailPolicy}
            onChange={(p) => setPolicy(p)}
          />
        );
      case "google_calendar":
        return (
          <CalendarPolicyEditor
            policy={policy as CalendarPolicy}
            onChange={(p) => setPolicy(p)}
          />
        );
      case "github":
        return (
          <GitHubPolicyEditor
            policy={policy as GitHubPolicy}
            onChange={(p) => setPolicy(p)}
          />
        );
      case "browser":
        return (
          <BrowserPolicyEditor
            policy={policy as BrowserPolicy}
            onChange={(p) => setPolicy(p)}
          />
        );
      case "google_drive":
      case "onedrive":
      case "box":
        return (
          <DrivePolicyEditor
            policy={policy as GoogleDrivePolicy | OneDrivePolicy | BoxPolicy}
            onChange={(p) => setPolicy(p)}
            providerName={getProviderDisplayName(integration.provider)}
          />
        );
      case "google_contacts":
      case "google_sheets":
      case "google_forms":
        return (
          <SimplePolicyEditor
            policy={policy as ContactsPolicy | SheetsPolicy | FormsPolicy}
            onChange={(p) => setPolicy(p)}
          />
        );
      case "slack":
      case "discord":
      case "telegram":
      case "whatsapp":
      case "teams":
      case "matrix":
      case "google_chat":
        return (
          <MessagingPolicyEditor
            policy={policy as MessagingPolicy}
            onChange={(p) => setPolicy(p)}
            providerName={getProviderDisplayName(integration.provider)}
          />
        );
      default:
        return <div className="text-sm text-[var(--foreground-muted)]">Policy editor not available for this provider.</div>;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--background-elevated)] rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div>
            <div className="font-medium">
              Edit {getProviderDisplayName(integration.provider)} Policy
            </div>
            {integration.accountEmail && (
              <div className="text-xs text-[var(--foreground-muted)]">
                {integration.accountEmail}
              </div>
            )}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-4 overflow-auto flex-1">{renderEditor()}</div>

        {updateMutation.error && (
          <div className="px-4 py-2 text-xs text-red-600 bg-red-50 border-t border-red-200">
            Failed to update policy: {(updateMutation.error as Error).message}
          </div>
        )}

        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border)]">
          <div className="flex items-center gap-1 text-[10px] text-[var(--foreground-muted)]">
            <Info className="w-3 h-3" />
            Changes take effect immediately
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Saving..." : "Save Policy"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PolicyEditorDialog;
