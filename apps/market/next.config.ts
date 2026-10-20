import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.githubusercontent.com" },
      { protocol: "https", hostname: "**.cdninstagram.com" },
    ],
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "https://api.delegare.dev",
    NEXT_PUBLIC_MPPSCAN_API: process.env.NEXT_PUBLIC_MPPSCAN_API || "https://mppscan.com/api",
    NEXT_PUBLIC_CDP_BAZAAR_API: process.env.NEXT_PUBLIC_CDP_BAZAAR_API || "https://api.cdp.coinbase.com/platform/v2/x402",
  },
};

export default nextConfig;
