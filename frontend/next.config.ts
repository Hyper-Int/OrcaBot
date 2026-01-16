import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for Cloudflare Pages deployment
  output: "standalone",

  // Disable image optimization (not supported on Cloudflare Pages)
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
