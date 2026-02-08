// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: login-v3-redirect
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const MODULE_REVISION = "login-v3-redirect";
console.log(
  `[login] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

/** Login is now handled at root /. Redirect for any stale links. */
export default function LoginRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/");
  }, [router]);

  return (
    <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-[var(--accent-primary)] border-t-transparent" />
    </div>
  );
}
