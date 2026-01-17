// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import dynamic from "next/dynamic";

const DashboardPage = dynamic(() => import("./page.client"), {
  ssr: false,
});

export default DashboardPage;
