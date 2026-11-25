require('dotenv').config({ path: ['.env.local', '.env'] });
const express = require('express');
const { createServer } = require('http');
const next = require('next');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');
const { ExpressPeerServer } = require('peer');
const { createDb } = require('./server/db');
const { createPush } = require('./server/push');
const { attachRealtime } = require('./server/realtime');
const { createMedia } = require('./server/media');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function main() {
  const db = createDb();
  await db.init();
  console.log('> PostgreSQL connected, schema ready.');

  const push = createPush(db);
  const media = createMedia();
  await app.prepare();

  const serverApp = express();
  const server = createServer(serverApp);

  // The frontend may be hosted on another origin (e.g. Vercel). CORS_ORIGIN = comma separated list of allowed origins.
  const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  serverApp.use(['/api/status', '/api/config', '/healthz'], (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    next();
  });

  serverApp.get('/healthz', async (_req, res) => {
    try {
      await db.pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  // Health of every moving part, shown in the app's settings panel
  serverApp.get('/api/status', async (_req, res) => {
    const out = { database: false, cloud: { configured: media.enabled, ok: false, error: null }, push: push.enabled };
    try {
      await db.pool.query('SELECT 1');
      out.database = true;
    } catch {
      /* stays false */
    }
    if (media.enabled) {
      const r = await media.ping();
      out.cloud.ok = r.ok;
      out.cloud.error = r.error || null;
    }
    res.json(out);
  });

  // Public config for the browser (VAPID public key, optional TURN).
  serverApp.get('/api/config', (_req, res) => {
    const turnUrl = process.env.TURN_URL || process.env.NEXT_PUBLIC_TURN_URL;
    const iceServers = (process.env.NEXT_PUBLIC_STUN_SERVERS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((urls) => ({ urls }));
    if (turnUrl) {
      iceServers.push({
        urls: turnUrl.split(',').map((s) => s.trim()),
        username: process.env.TURN_USERNAME || process.env.NEXT_PUBLIC_TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL || process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
      });
    }
    res.json({ vapidPublicKey: push.publicKey, iceServers });
  });

  // PeerJS signaling server for the direct P2P media/data channels
  // PeerJS and Socket.io share this HTTP server. PeerJS's default WebSocket server aborts EVERY upgrade request whose
  // path is not its own (HTTP 400), which would force Socket.io down to slow long-polling. So PeerJS gets a
  // `noServer` WebSocket server and we route WebSocket upgrades by path ourselves.
  let peerWss = null;
  let peerWsPath = null;
  serverApp.use(
    '/peerjs',
    ExpressPeerServer(server, {
      debug: false,
      path: '/',
      corsOptions: { origin: allowedOrigins.length ? allowedOrigins : false },
      createWebSocketServer: (opts) => {
        peerWsPath = opts.path;
        peerWss = new WebSocketServer({ noServer: true });
        return peerWss;
      },
    })
  );
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return;
    }
    if (peerWss && pathname === peerWsPath) {
      peerWss.handleUpgrade(req, socket, head, (ws) => peerWss.emit('connection', ws, req));
    }
  });

  serverApp.all('*', (req, res) => handle(req, res));

  const io = new Server(server, {
    cors: { origin: allowedOrigins.length ? allowedOrigins : false },
    maxHttpBufferSize: 6 * 1024 * 1024,
    transports: ['websocket', 'polling'],
  });
  attachRealtime(io, db, push, media);

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });

  const shutdown = async () => {
    io.close();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('> Startup failed:', e.message);
  process.exit(1);
});
