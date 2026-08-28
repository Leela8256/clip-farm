/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static site: `next build` writes plain HTML/JS/CSS to ./out. There is no
  // Node server at runtime — any static host (nginx, S3/CDN, the marketplace shell)
  // can serve it, and every call the pages make goes straight to the RocketRide engine.
  output: "export",
  images: { unoptimized: true },
  // The RocketRide SDK runs in the browser but references the Node `ws` module
  // behind a `typeof window` guard; give the browser bundle an empty stand-in so
  // the bundlers don't try to resolve it.
  turbopack: {
    resolveAlias: {
      ws: { browser: "./lib/empty-module.js" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...(config.resolve.fallback ?? {}), ws: false };
    }
    return config;
  },
};
export default nextConfig;
