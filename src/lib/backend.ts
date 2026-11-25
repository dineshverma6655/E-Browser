// Where the realtime backend (server.js: Socket.io + PeerJS + API) lives.
// Empty  -> same origin as the page (local dev / everything on one host).
// Set NEXT_PUBLIC_BACKEND_URL=https://your-backend.onrender.com when the frontend is hosted elsewhere (e.g. Vercel).
export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '');

export const backendUrl = (path: string): string => `${BACKEND_URL}${path}`;

export const peerEndpoint = (): { host: string; port: number; secure: boolean } => {
  const u = new URL(BACKEND_URL || window.location.origin);
  const secure = u.protocol === 'https:';
  return { host: u.hostname, port: u.port ? parseInt(u.port, 10) : secure ? 443 : 80, secure };
};
