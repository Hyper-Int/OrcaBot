// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Cloudflare Web Analytics beacon.
//
// The app's own analytics (POST /analytics/events) require a signed-in user and
// stamp every row with a user_id, so an anonymous reader on a blog, docs or
// benchmark page produces no record at all. /admin/metrics is therefore about
// accounts rather than visits, and a link shared publicly is invisible to it.
// This fills that gap and nothing else: page views, referrers and countries for
// people who never sign in.
//
// Cookieless, with no cross-site identifier and no fingerprinting, so it needs no
// consent banner - which is the reason to prefer it here over anything heavier on
// a site whose front page is read by people who have not agreed to anything.
//
// Two gates, both deliberate:
//
//   No token, no script. Unset the variable and this renders nothing, so it stays
//   inert in local development and in any build that has not been given one.
//
//   Never in the desktop app. That build is served from localhost inside Tauri;
//   beaconing a desktop user's navigation to a third party is not something a
//   local app should do, and it would fail offline besides.

export function WebAnalytics() {
  const token = process.env.NEXT_PUBLIC_CF_BEACON_TOKEN;
  if (!token) return null;
  if (process.env.NEXT_PUBLIC_DESKTOP_MODE === "true") return null;

  return (
    <script
      defer
      src="https://static.cloudflareinsights.com/beacon.min.js"
      data-cf-beacon={JSON.stringify({ token })}
    />
  );
}
