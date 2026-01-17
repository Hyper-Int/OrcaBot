// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import dynamic from "next/dynamic";

export const runtime = "edge";

const DashboardPage = dynamic(() => import("./page.client"), {
  ssr: false,
});

export default DashboardPage;
