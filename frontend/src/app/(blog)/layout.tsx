// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: blog-layout-v9-auth-button

"use client";

import Link from "next/link";
import { MobileNav } from "@/components/MobileNav";
import { useAuthStore } from "@/stores/auth-store";

const NAV_LINKS = [
  { href: "/blog", label: "Blog" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
];

export default function BlogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated } = useAuthStore();
  const loginHref = isAuthenticated ? "/dashboards" : "/go";
  const loginText = isAuthenticated ? "Dashboards" : "Sign In";

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#0b1a2e", color: "#ffffff" }}>
      <header style={{ position: "relative", borderBottom: "1px solid rgba(255,255,255,0.1)", padding: "1rem 1.5rem" }}>
        <div style={{ maxWidth: "64rem", margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>

          <Link href="/" style={{ display: "flex", alignItems: "center", gap: "0.75rem", textDecoration: "none" }}>
            <img src="/orca.png" alt="Orcabot" style={{ width: 32, height: 32, objectFit: "contain" }} />
            <span style={{ fontWeight: 600, color: "#ffffff", fontSize: "0.9rem" }}>OrcaBot</span>
          </Link>

          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <Link
              href={loginHref}
              style={{ display: "inline-flex", alignItems: "center", fontSize: "0.82rem", fontWeight: 600, color: "#ffffff", textDecoration: "none", background: "#3b82f6", padding: "7px 16px", borderRadius: "8px", whiteSpace: "nowrap", boxShadow: "0 0 20px rgba(59,130,246,0.3), 0 2px 8px rgba(0,0,0,0.3)" }}
            >
              {loginText}
            </Link>
            <MobileNav links={NAV_LINKS} absolute />
          </div>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}
