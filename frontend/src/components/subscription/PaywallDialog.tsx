// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: paywall-dialog-v2-logout-option
const MODULE_REVISION = "paywall-dialog-v2-logout-option";
console.log(
  `[PaywallDialog] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { createCheckoutSession } from "@/lib/api/cloudflare/subscriptions";
import { API } from "@/config/env";
import { CreditCard, Zap, LogOut } from "lucide-react";
import { toast } from "sonner";

export function PaywallDialog() {
  const { subscription, isAuthenticated, user, logout } = useAuthStore();
  const [loading, setLoading] = React.useState(false);

  const isOpen = isAuthenticated && subscription?.status === "expired";

  const handleSubscribe = async () => {
    setLoading(true);
    try {
      const { url } = await createCheckoutSession();
      window.location.href = url;
    } catch {
      toast.error("Failed to start checkout. Please try again.");
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${API.cloudflare.base}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Ignore logout errors — clear local state anyway
    }
    logout();
    window.location.href = "/";
  };

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen}>
      <DialogContent
        className="sm:max-w-md"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-[var(--accent-primary)]" />
            Your free trial has ended
          </DialogTitle>
          <DialogDescription>
            Subscribe to OrcaBot to continue using sandboxed AI coding
            workspaces, multiplayer dashboards, and integrations.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="flex items-center gap-3 p-4 rounded-lg border border-[var(--border)] bg-[var(--background-surface)]">
            <CreditCard className="h-5 w-5 shrink-0 text-[var(--foreground-muted)]" />
            <div>
              <div className="font-semibold text-lg">$20/month</div>
              <div className="text-sm text-[var(--foreground-muted)]">
                Unlimited dashboards, terminals, and integrations
              </div>
            </div>
          </div>
        </div>
        <DialogFooter className="flex flex-col gap-2 sm:flex-col">
          <Button
            variant="primary"
            onClick={handleSubscribe}
            disabled={loading}
            isLoading={loading}
            className="w-full"
          >
            {loading ? "Redirecting to checkout..." : "Subscribe Now"}
          </Button>
          <button
            onClick={handleLogout}
            className="flex items-center justify-center gap-1.5 text-sm text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors py-1"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Log out{user?.email ? ` (${user.email})` : ""} and try a different account</span>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
