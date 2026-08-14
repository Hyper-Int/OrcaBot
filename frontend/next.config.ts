import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep dev/build type artifacts under the same dist dir to prevent
  // next-env.d.ts from flipping between .next/dev and .next imports.
  experimental: {
    isolatedDevBuild: false,
  },
  // Disable image optimization (not supported on Cloudflare Pages)
  images: {
    unoptimized: true,
  },
  // There is no benchmarks index page. /benchmarks lands on the default
  // benchmark itself, because an index that lists one thing and then makes you
  // click again is a page nobody wants to read. The tabs on each benchmark do
  // the navigating.
  //
  // Keep this in step with the FIRST entry of BENCHMARK_TABS in
  // src/components/BenchmarkTabs.tsx — next.config cannot import it, so the
  // default slug is duplicated here on purpose.
  //
  // The Labs section became Benchmarks. /labs URLs are live on the internet
  // (shared links, social cards), so every one of them permanently redirects.
  // Order matters — Next matches top-down:
  //   1. the published Labs post -> its benchmark's permanent page
  //   2. the section root -> the default benchmark, NOT via /benchmarks: that
  //      would be two hops for a link someone else already published
  //   3. everything else under /labs, which also covers the moved static assets
  //      (e.g. /labs/og-do-skills.png, referenced by already-cached social cards)
  async redirects() {
    const DEFAULT_BENCHMARK = "/benchmarks/agent-skills";
    return [
      {
        source: "/labs/do-skills-improve-coding-agent-accuracy",
        destination: DEFAULT_BENCHMARK,
        permanent: true,
      },
      { source: "/labs", destination: DEFAULT_BENCHMARK, permanent: true },
      { source: "/labs/:path*", destination: "/benchmarks/:path*", permanent: true },
      // Temporary on purpose. /benchmarks is the URL people share and the one
      // in the site nav, and which benchmark is the default will change as more
      // land. A 308 would be cached by browsers and CDNs and strand readers on
      // whichever benchmark happened to be first today.
      { source: "/benchmarks", destination: DEFAULT_BENCHMARK, permanent: false },
    ];
  },
};

export default nextConfig;
