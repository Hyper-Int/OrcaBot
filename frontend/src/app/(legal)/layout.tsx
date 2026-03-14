// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: legal-layout-v2-shared-header

"use client";

import { SiteHeader } from "@/components/SiteHeader";

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen" style={{ backgroundColor: "#0b1a2e", color: "#ffffff" }}>
      <SiteHeader />
      <main className="max-w-3xl mx-auto px-6 py-12 pb-24">
        <article className="legal-content">
          {children}
        </article>
      </main>
    </div>
  );
}
