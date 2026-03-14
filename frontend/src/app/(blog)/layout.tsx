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
    <div style={{ minHeight: "100vh", backgroundColor: "#0b1a2e", color: "#ffffff" }}>
      <SiteHeader section="Blog" />
      <main>{children}</main>
    </div>
  );
}
