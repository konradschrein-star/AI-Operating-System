import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const FORGE_CONTROL = process.env.FORGE_CONTROL_URL ?? 'http://127.0.0.1:7700';

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/api/proxy/:path*', destination: `${FORGE_CONTROL}/api/:path*` },
    ];
  },
  webpack(config) {
    config.resolve.alias['@'] = path.resolve(__dirname, '.');
    return config;
  },
};

export default nextConfig;
