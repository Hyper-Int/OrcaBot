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
};

export default nextConfig;
