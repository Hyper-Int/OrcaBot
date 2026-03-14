// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: site-header-v1-shared

"use client";

import Link from "next/link";
import { MobileNav, type NavLink } from "@/components/MobileNav";
import { useAuthStore } from "@/stores/auth-store";

const HOME_LINK: NavLink = { href: "/", label: "Home" };

const BASE_NAV_LINKS: NavLink[] = [
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
];

interface SiteHeaderProps {
  /** Section label shown next to logo (e.g. "Docs", "Blog") */
  section?: string;
  /** Extra nav links prepended to the base links (e.g. splash page anchors) */
  extraLinks?: NavLink[];
  /** Show "Home" link before Docs (default true, set false on splash) */
  showHome?: boolean;
  /** Max width of the header content */
  maxWidth?: string;
  /** Positioning: "sticky" pins on scroll, "fixed" overlays content */
  position?: "static" | "sticky" | "fixed";
  /** Use translucent glass background so page content shows through */
  glass?: boolean;
  /** Optional callback for login button click (splash page uses custom handler) */
  onLoginClick?: (e: React.MouseEvent) => void;
  /** Optional extra element rendered after the logo+section (e.g. docs sidebar toggle) */
  afterLogo?: React.ReactNode;
}

export function SiteHeader({
  section,
  extraLinks,
  maxWidth = "80rem",
  position = "static",
  showHome = true,
  glass = false,
  onLoginClick,
  afterLogo,
}: SiteHeaderProps) {
  const { isAuthenticated } = useAuthStore();
  const loginHref = isAuthenticated ? "/dashboards" : "/go";
  const loginText = isAuthenticated ? "Dashboards" : "Sign In";

  const base = showHome ? [HOME_LINK, ...BASE_NAV_LINKS] : BASE_NAV_LINKS;
  const navLinks = extraLinks ? [...extraLinks, ...base] : base;

  const pinned = position === "sticky" || position === "fixed";

  return (
    <header
      style={{
        position,
        top: pinned ? 0 : undefined,
        left: position === "fixed" ? 0 : undefined,
        right: position === "fixed" ? 0 : undefined,
        zIndex: 40,
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        padding: "0.75rem 1.5rem",
        backgroundColor: glass
          ? "rgba(3,10,22,0.75)"
          : pinned
            ? "rgba(11,26,46,0.95)"
            : "transparent",
        backdropFilter: glass
          ? "blur(24px) saturate(1.4)"
          : pinned
            ? "blur(12px)"
            : undefined,
        WebkitBackdropFilter: glass
          ? "blur(24px) saturate(1.4)"
          : pinned
            ? "blur(12px)"
            : undefined,
      }}
    >
      <div
        style={{
          maxWidth,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {/* Left: logo + section label + optional extra */}
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <Link
            href="/"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              textDecoration: "none",
            }}
          >
            <img
              src="/orca.png"
              alt="Orcabot"
              style={{ width: 28, height: 28, objectFit: "contain" }}
            />
            <span
              style={{ fontWeight: 600, color: "#ffffff", fontSize: "0.9rem" }}
            >
              OrcaBot
            </span>
          </Link>

          {section && (
            <span
              style={{
                fontSize: "0.75rem",
                color: "rgba(255,255,255,0.4)",
                fontWeight: 500,
                letterSpacing: "0.02em",
              }}
            >
              {section}
            </span>
          )}

          {afterLogo}
        </div>

        {/* Right: nav links + login button (rightmost) */}
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <MobileNav links={navLinks} absolute />
          <Link
            href={loginHref}
            onClick={onLoginClick}
            style={{
              display: "inline-flex",
              alignItems: "center",
              fontSize: "0.82rem",
              fontWeight: 600,
              color: "#ffffff",
              textDecoration: "none",
              background: "#3b82f6",
              padding: "7px 16px",
              borderRadius: "8px",
              whiteSpace: "nowrap",
              boxShadow:
                "0 0 20px rgba(59,130,246,0.3), 0 2px 8px rgba(0,0,0,0.3)",
            }}
          >
            {loginText}
          </Link>
        </div>
      </div>
    </header>
  );
}
