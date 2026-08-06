// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: benchmarks-layout-v1-shared-header

"use client";

import { SiteHeader } from "@/components/SiteHeader";

export default function BenchmarksLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // Benchmarks shares the blog's navy "midnight" surface. Scope the midnight
    // theme to this subtree so var(--foreground*) resolves to the light text
    // colors even when the visitor's global theme is light — otherwise the
    // hard-coded navy background pairs with near-black :root text and everything
    // greys out.
    <div className="midnight" style={{ minHeight: "100vh", backgroundColor: "#0b1a2e", color: "#ffffff" }}>
      <SiteHeader section="Benchmarks" position="sticky" />
      <main>{children}</main>
    </div>
  );
}
