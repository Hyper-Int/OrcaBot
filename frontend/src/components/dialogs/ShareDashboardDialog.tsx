// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Mail,
  Trash2,
  RefreshCw,
  Crown,
  Pencil,
  Eye,
  Clock,
  Loader2,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
  Input,
} from "@/components/ui";
import {
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  resendInvitation,
  cancelInvitation,
  type DashboardMember,
  type DashboardInvitation,
} from "@/lib/api/cloudflare/members";

interface ShareDashboardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboardId: string;
  dashboardName: string;
  currentUserRole: string;
}

const ROLE_CONFIG = {
  owner: { icon: Crown, label: "Owner", color: "text-amber-500" },
  editor: { icon: Pencil, label: "Editor", color: "text-blue-500" },
  viewer: { icon: Eye, label: "Viewer", color: "text-gray-500" },
} as const;

export function ShareDashboardDialog({
  open,
  onOpenChange,
  dashboardId,
  dashboardName,
  currentUserRole,
}: ShareDashboardDialogProps) {
  const queryClient = useQueryClient();
  const [email, setEmail] = React.useState("");
  const [selectedRole, setSelectedRole] = React.useState<"editor" | "viewer">(
    "viewer"
  );

  const isOwner = currentUserRole === "owner";

  // Reset form when dialog opens
  React.useEffect(() => {
    if (open) {
      setEmail("");
      setSelectedRole("viewer");
    }
  }, [open]);

  // Fetch members and invitations
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard-members", dashboardId],
    queryFn: () => listMembers(dashboardId),
    enabled: open,
  });

  // Add member mutation
  const addMutation = useMutation({
    mutationFn: (data: { email: string; role: "editor" | "viewer" }) =>
      addMember(dashboardId, data),
    onSuccess: (result) => {
      if (result.member) {
        toast.success(`Added ${result.member.email} as ${result.member.role}`);
      } else if (result.invitation) {
        toast.success(`Invitation sent to ${result.invitation.email}`);
      }
      setEmail("");
      queryClient.invalidateQueries({
        queryKey: ["dashboard-members", dashboardId],
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to add member"
      );
    },
  });

  // Update role mutation
  const updateRoleMutation = useMutation({
    mutationFn: ({
      memberId,
      role,
    }: {
      memberId: string;
      role: "editor" | "viewer";
    }) => updateMemberRole(dashboardId, memberId, { role }),
    onSuccess: (result) => {
      toast.success(`Updated ${result.member.name} to ${result.member.role}`);
      queryClient.invalidateQueries({
        queryKey: ["dashboard-members", dashboardId],
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to update role"
      );
    },
  });

  // Remove member mutation
  const removeMutation = useMutation({
    mutationFn: (memberId: string) => removeMember(dashboardId, memberId),
    onSuccess: () => {
      toast.success("Member removed");
      queryClient.invalidateQueries({
        queryKey: ["dashboard-members", dashboardId],
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove member"
      );
    },
  });

  // Resend invitation mutation
  const resendMutation = useMutation({
    mutationFn: (invitationId: string) =>
      resendInvitation(dashboardId, invitationId),
    onSuccess: () => {
      toast.success("Invitation resent");
      queryClient.invalidateQueries({
        queryKey: ["dashboard-members", dashboardId],
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to resend invitation"
      );
    },
  });

  // Cancel invitation mutation
  const cancelMutation = useMutation({
    mutationFn: (invitationId: string) =>
      cancelInvitation(dashboardId, invitationId),
    onSuccess: () => {
      toast.success("Invitation cancelled");
      queryClient.invalidateQueries({
        queryKey: ["dashboard-members", dashboardId],
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to cancel invitation"
      );
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    addMutation.mutate({ email: email.trim().toLowerCase(), role: selectedRole });
  };

  const formatExpiry = (expiresAt: string) => {
    const expiry = new Date(expiresAt);
    const now = new Date();
    const daysLeft = Math.ceil(
      (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysLeft <= 0) return "Expired";
    if (daysLeft === 1) return "Expires tomorrow";
    return `Expires in ${daysLeft} days`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share &quot;{dashboardName}&quot;</DialogTitle>
          <DialogDescription>
            Invite people to collaborate on this dashboard.
          </DialogDescription>
        </DialogHeader>

        {/* Add member form - only for owners */}
        {isOwner && (
          <form onSubmit={handleSubmit} className="flex gap-2">
            <Input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1"
            />
            <select
              value={selectedRole}
              onChange={(e) =>
                setSelectedRole(e.target.value as "editor" | "viewer")
              }
              className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <Button
              type="submit"
              disabled={addMutation.isPending || !email.trim()}
              size="sm"
            >
              {addMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Mail className="w-4 h-4" />
              )}
            </Button>
          </form>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--foreground-muted)]" />
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="text-sm text-[var(--status-error)] py-4">
            Failed to load members. Please try again.
          </div>
        )}

        {/* Members list */}
        {data && (
          <div className="space-y-4 mt-4">
            <div>
              <h4 className="text-sm font-medium text-[var(--foreground)] mb-2">
                Members ({data.members.length})
              </h4>
              <div className="space-y-2">
                {data.members.map((member) => (
                  <MemberRow
                    key={member.userId}
                    member={member}
                    isOwner={isOwner}
                    onRoleChange={(role) =>
                      updateRoleMutation.mutate({ memberId: member.userId, role })
                    }
                    onRemove={() => removeMutation.mutate(member.userId)}
                    isUpdating={updateRoleMutation.isPending}
                    isRemoving={removeMutation.isPending}
                  />
                ))}
              </div>
            </div>

            {/* Pending invitations */}
            {data.invitations.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-[var(--foreground)] mb-2">
                  Pending Invitations ({data.invitations.length})
                </h4>
                <div className="space-y-2">
                  {data.invitations.map((invitation) => (
                    <InvitationRow
                      key={invitation.id}
                      invitation={invitation}
                      isOwner={isOwner}
                      formatExpiry={formatExpiry}
                      onResend={() => resendMutation.mutate(invitation.id)}
                      onCancel={() => cancelMutation.mutate(invitation.id)}
                      isResending={resendMutation.isPending}
                      isCancelling={cancelMutation.isPending}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ===== Helper Components =====

interface MemberRowProps {
  member: DashboardMember;
  isOwner: boolean;
  onRoleChange: (role: "editor" | "viewer") => void;
  onRemove: () => void;
  isUpdating: boolean;
  isRemoving: boolean;
}

function MemberRow({
  member,
  isOwner,
  onRoleChange,
  onRemove,
  isUpdating,
  isRemoving,
}: MemberRowProps) {
  const config = ROLE_CONFIG[member.role];
  const Icon = config.icon;
  const isOwnerMember = member.role === "owner";

  return (
    <div className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2">
      <div className="flex items-center gap-3 min-w-0">
        <Icon className={`w-4 h-4 flex-shrink-0 ${config.color}`} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--foreground)] truncate">
            {member.name}
          </div>
          <div className="text-xs text-[var(--foreground-muted)] truncate">
            {member.email}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {isOwner && !isOwnerMember ? (
          <>
            <select
              value={member.role}
              onChange={(e) =>
                onRoleChange(e.target.value as "editor" | "viewer")
              }
              disabled={isUpdating}
              className="h-7 text-xs rounded border border-[var(--border)] bg-[var(--background)] px-1"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRemove}
              disabled={isRemoving}
              className="text-[var(--status-error)] hover:text-[var(--status-error)]"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </>
        ) : (
          <span className="text-xs text-[var(--foreground-muted)]">
            {config.label}
          </span>
        )}
      </div>
    </div>
  );
}

interface InvitationRowProps {
  invitation: DashboardInvitation;
  isOwner: boolean;
  formatExpiry: (expiresAt: string) => string;
  onResend: () => void;
  onCancel: () => void;
  isResending: boolean;
  isCancelling: boolean;
}

function InvitationRow({
  invitation,
  isOwner,
  formatExpiry,
  onResend,
  onCancel,
  isResending,
  isCancelling,
}: InvitationRowProps) {
  const config = ROLE_CONFIG[invitation.role];
  const Icon = config.icon;

  return (
    <div className="flex items-center justify-between rounded-md border border-dashed border-[var(--border)] bg-[var(--background)] px-3 py-2">
      <div className="flex items-center gap-3 min-w-0">
        <Icon className={`w-4 h-4 flex-shrink-0 ${config.color}`} />
        <div className="min-w-0">
          <div className="text-sm text-[var(--foreground)] truncate">
            {invitation.email}
          </div>
          <div className="flex items-center gap-1 text-xs text-[var(--foreground-subtle)]">
            <Clock className="w-3 h-3" />
            {formatExpiry(invitation.expiresAt)}
          </div>
        </div>
      </div>

      {isOwner && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onResend}
            disabled={isResending}
            title="Resend invitation"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isResending ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCancel}
            disabled={isCancelling}
            className="text-[var(--status-error)] hover:text-[var(--status-error)]"
            title="Cancel invitation"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
