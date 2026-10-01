import type { NextConfig } from "next";

// An explicitly configured, trusted Product API supplies same-origin development
// routing. Production ingress routes /api and /auth directly to Python.
const backend = process.env.APPCHI_BACKEND_URL;
if (backend && !/^https?:\/\/[^\s?#]+$/.test(backend)) {
  throw new Error(
    "APPCHI_BACKEND_URL must be an absolute trusted HTTP(S) origin",
  );
}
const config: NextConfig = {
  distDir: process.env.APPCHI_NEXT_DIST_DIR ?? ".next",
  devIndicators: false,
  experimental: { proxyTimeout: 100000 },
  output: "standalone",
  poweredByHeader: false,
  async rewrites() {
    return backend
      ? ["api", "auth"].map((prefix) => ({
          source: `/${prefix}/:path*`,
          destination: `${backend.replace(/\/$/, "")}/${prefix}/:path*`,
        }))
      : [];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};
export default config;
