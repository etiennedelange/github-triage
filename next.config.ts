import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Off on purpose: Cache Components hangs page streaming on production Cloudflare Workers
  // (opennextjs/opennextjs-cloudflare#1225). Data caching uses `unstable_cache` instead.
  cacheComponents: false,
};

export default nextConfig;
