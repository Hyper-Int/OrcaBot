// REVISION: desktop-version-badge-v1
"use client";

import { useEffect, useState } from "react";
import { DESKTOP_MODE } from "@/config/env";
import { getAppVersion } from "@/lib/tauri-bridge";

/**
 * Small "v0.5.0" tag shown next to the Orcabot wordmark in the desktop app so
 * users can see which version they're running (invisible otherwise in a packaged
 * build). Renders nothing on web/Cloudflare builds or until the version resolves.
 */
export function DesktopVersionBadge({ className = "" }: { className?: string }) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!DESKTOP_MODE) return;
    let alive = true;
    getAppVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!DESKTOP_MODE || !version) return null;

  return (
    <span
      className={`text-xs font-medium text-[var(--foreground)] opacity-40 tabular-nums ${className}`}
      title={`Orcabot desktop v${version}`}
    >
      v{version}
    </span>
  );
}
