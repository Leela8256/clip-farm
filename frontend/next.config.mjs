// In Docker (prod compose), the frontend container reaches the API by its
// service name; in local dev, the API runs on the host's localhost:8000.
const API_ORIGIN = process.env.API_ORIGIN || "http://localhost:8000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output for a minimal production image (docker-compose.prod.yml)
  // — bundles only the traced dependencies, not the full node_modules tree.
  output: "standalone",
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` },
      { source: "/ws/:path*", destination: `${API_ORIGIN}/ws/:path*` },
    ];
  },
};
export default nextConfig;
