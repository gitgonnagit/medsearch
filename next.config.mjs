/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // Make the base path configurable for GitHub Pages project sites.
  // Set NEXT_PUBLIC_BASE_PATH env var in CI if you publish to <user>.github.io/<repo>.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '',
  // Avoid noisy build-time logs about ESLint during CI.
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
