/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // Prevents duplicate peer connection triggers in dev
  // The service worker and manifest must never be served from a stale HTTP cache, or devices miss new deploys.
  async headers() {
    return [
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }, { key: 'Service-Worker-Allowed', value: '/' }] },
      { source: '/manifest.json', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ];
  },
  webpack: (config) => {
    return config;
  },
};

export default nextConfig;
