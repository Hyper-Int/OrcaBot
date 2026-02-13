// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: trial-banner-v2-stripe-trial
const MODULE_REVISION = "trial-banner-v2-stripe-trial";
console.log(
  `[TrialBanner] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import { useAuthStore } from "@/stores/auth-store";
import { createPortalSession } from "@/lib/api/cloudflare/subscriptions";
import { Clock, Settings } from "lucide-react";
import { toast } from "sonner";

export function TrialBanner() {
  const { subscription } = useAuthStore();

  if (!subscription) return null;
  if (subscription.status === "exempt") return null;

  if (subscription.status === "trialing" && subscription.trialEndsAt) {
    const daysLeft = Math.max(
      0,
      Math.ceil(
        (new Date(subscription.trialEndsAt).getTime() - Date.now()) /
          (1000 * 60 * 60 * 24)
      )
    );
    // Stripe trial (has currentPeriodEnd) vs free trial (no billing data)
    const isStripeTrial = !!subscription.currentPeriodEnd;

    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] text-sm">
        <Clock className="h-3.5 w-3.5" />
        <span>
          {daysLeft} day{daysLeft !== 1 ? "s" : ""} left in {isStripeTrial ? "trial" : "free trial"}
        </span>
        {isStripeTrial && <ManageSubscriptionButton />}
      </div>
    );
  }

  if (subscription.status === "active") {
    return <ManageSubscriptionButton />;
  }

  if (subscription.status === "past_due") {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-red-500/10 text-red-500 text-sm">
        <Clock className="h-3.5 w-3.5" />
        <span>Payment issue — please update your billing info</span>
        <ManageSubscriptionButton />
      </div>
    );
  }

  return null;
}

function ManageSubscriptionButton() {
  const [loading, setLoading] = React.useState(false);

  const handleManage = async () => {
    setLoading(true);
    try {
      const { url } = await createPortalSession();
      window.location.href = url;
    } catch {
      toast.error("Failed to open billing portal.");
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleManage}
      disabled={loading}
      className="flex items-center gap-1 text-sm text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors disabled:opacity-50"
    >
      <Settings className="h-3.5 w-3.5" />
      <span>{loading ? "Opening..." : "Manage subscription"}</span>
    </button>
  );
}
