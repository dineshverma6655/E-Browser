/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // Prevents duplicate peer connection triggers in dev
  webpack: (config) => {
    return config;
  },
};

export default nextConfig;
