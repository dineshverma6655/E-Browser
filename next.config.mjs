/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // Prevents duplicate peer connection triggers in dev
  experimental: {
    // Used by the API routes (server/*.js): keep them as plain Node modules instead of bundling them.
    serverComponentsExternalPackages: ['pg', 'pusher', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
  },
  // The service worker and manifest must never be served from a stale HTTP cache, or devices miss new deploys.
  async headers() {
    return [
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }, { key: 'Service-Worker-Allowed', value: '/' }] },
      { source: '/manifest.json', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ];
  },
};

export default nextConfig;
