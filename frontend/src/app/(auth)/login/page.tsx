// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: login-v2-redirect-to-splash
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const MODULE_REVISION = "login-v2-redirect-to-splash";
console.log(
  `[login] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

/**
 * Login page now redirects to /splash, which handles both
 * unauthenticated login and authenticated dashboard access.
 */
export default function LoginPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/splash");
  }, [router]);

  return (
    <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-[var(--accent-primary)] border-t-transparent" />
    </div>
  );
}
