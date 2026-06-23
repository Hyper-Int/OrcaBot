// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
"use client";

// REVISION: settings-page-v1-pat
const MODULE_REVISION = "settings-page-v1-pat";
console.log(`[settings] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Button, ThemeToggle } from "@/components/ui";
import { useAuthStore } from "@/stores/auth-store";
import { PersonalAccessTokensPanel } from "@/components/PersonalAccessTokensPanel";

export default function SettingsPage() {
  const router = useRouter();
  const { isAuthenticated, isAuthResolved } = useAuthStore();

  React.useEffect(() => {
    if (!isAuthResolved) return;
    if (!isAuthenticated) {
      router.push("/dashboards");
    }
  }, [isAuthenticated, isAuthResolved, router]);

  if (!isAuthResolved || !isAuthenticated) {
    return null;
  }

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--border)] bg-[var(--background-elevated)]">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/orca.png" alt="Orcabot" className="w-7 h-7 object-contain" />
            <span className="text-h4 text-[var(--foreground)]">Settings</span>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/dashboards")}
              leftIcon={<ArrowLeft className="w-4 h-4" />}
            >
              Dashboards
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        <PersonalAccessTokensPanel />
      </main>
    </div>
  );
}
