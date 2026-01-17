import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disable image optimization (not supported on Cloudflare Pages)
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
