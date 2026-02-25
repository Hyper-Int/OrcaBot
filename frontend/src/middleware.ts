// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: desktop-middleware-v3-go-route
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DESKTOP_MODE === "true") {
    // Redirect root, /login, and /go to /dashboards
    if (
      request.nextUrl.pathname === "/" ||
      request.nextUrl.pathname === "/login" ||
      request.nextUrl.pathname === "/go"
    ) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboards";
      const response = NextResponse.redirect(url);
      response.cookies.set("orcabot-desktop", "1", {
        path: "/",
        sameSite: "lax",
      });
      return response;
    }

    // For all other matched paths, set the desktop cookie so client JS can read it
    const response = NextResponse.next();
    response.cookies.set("orcabot-desktop", "1", {
      path: "/",
      sameSite: "lax",
    });
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/login", "/go", "/dashboards/:path*"],
};
