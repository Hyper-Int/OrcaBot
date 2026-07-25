// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: blog-layout-v11-shared-header

"use client";

import { SiteHeader } from "@/components/SiteHeader";

export default function BlogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The blog is always the navy "midnight" surface. Scope the midnight theme to
    // this subtree so var(--foreground*) resolves to the light text colors even
    // when the visitor's global theme is light — otherwise the hard-coded navy
    // background pairs with near-black :root text and everything greys out.
    <div className="midnight" style={{ minHeight: "100vh", backgroundColor: "#0b1a2e", color: "#ffffff" }}>
      <SiteHeader section="Blog" />
      <main>{children}</main>
    </div>
  );
}
