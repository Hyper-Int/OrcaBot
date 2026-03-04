// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import Link from "next/link";

export default function BlogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen" style={{ backgroundColor: "#0b1a2e", color: "var(--foreground)" }}>
      {/* Header */}
      <header className="border-b border-[var(--border)] px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-3 hover:opacity-80 transition-opacity"
          >
            <img
              src="/orca.png"
              alt="Orcabot"
              className="w-8 h-8 object-contain"
            />
            <span className="text-body font-semibold text-[var(--foreground)]">
              OrcaBot
            </span>
          </Link>
          <nav className="flex gap-6">
            <Link
              href="/blog"
              className="text-caption text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
            >
              Blog
            </Link>
            <Link
              href="/terms"
              className="text-caption text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
            >
              Terms
            </Link>
            <Link
              href="/privacy"
              className="text-caption text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
            >
              Privacy
            </Link>
          </nav>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}
