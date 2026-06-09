/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app is fully wallet/RPC-driven and client-rendered. Tracing the
  // monorepo root makes Next try to bundle unrelated workspace files, so we
  // pin the trace root to THIS app.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
