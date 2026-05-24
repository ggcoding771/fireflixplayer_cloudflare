import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OpenNext for Cloudflare handles the output format
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
