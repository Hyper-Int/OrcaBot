// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import Link from "next/link";

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="border-b border-[var(--border)] px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <img src="/orca.png" alt="Orcabot" className="w-8 h-8 object-contain" />
            <span className="text-body font-semibold text-[var(--foreground)]">OrcaBot</span>
          </Link>
          <nav className="flex gap-6">
            <Link href="/terms" className="text-caption text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors">
              Terms of Service
            </Link>
            <Link href="/privacy" className="text-caption text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors">
              Privacy Policy
            </Link>
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-3xl mx-auto px-6 py-12 pb-24">
        <article className="legal-content">
          {children}
        </article>
      </main>
    </div>
  );
}
