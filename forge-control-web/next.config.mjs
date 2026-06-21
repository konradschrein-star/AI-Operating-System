/** @type {import('next').NextConfig} */
const FORGE_CONTROL = process.env.FORGE_CONTROL_URL ?? 'http://127.0.0.1:7700';

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/api/proxy/:path*', destination: `${FORGE_CONTROL}/api/:path*` },
    ];
  },
};

export default nextConfig;
