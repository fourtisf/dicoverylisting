/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: { unoptimized: true },
  // src/instrumentation.ts — the boot line. Next 14.2 still gates register()
  // behind this flag; without it the file is silently ignored, which is the
  // same failure mode as the banner it replaces.
  experimental: { instrumentationHook: true },
};

export default nextConfig;
