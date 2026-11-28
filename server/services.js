// Shared, lazily created services for the serverless API routes (one set per warm function instance).
const Pusher = require('pusher');
const { createDb } = require('./db');
const { createPush } = require('./push');
const { createMedia } = require('./media');
const { createRt } = require('./rt');

// Pusher refuses events bigger than 10 KB. Anything larger (a photo sent as a data URL) is replaced by a tiny "poke":
// the receiving device then fetches the message over HTTP instead.
const MAX_EVENT_BYTES = 8000;

const channelOf = (userId) => `private-u-${userId}`;

function createPublisher() {
  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
  const enabled = Boolean(appId && key && secret && cluster);
  if (!enabled) console.warn('> Realtime push disabled: set PUSHER_APP_ID, PUSHER_SECRET, NEXT_PUBLIC_PUSHER_KEY, NEXT_PUBLIC_PUSHER_CLUSTER. Falling back to polling.');
  const pusher = enabled ? new Pusher({ appId, key, secret, cluster, useTLS: true }) : null;

  return {
    enabled,
    channelOf,
    authorize: (socketId, channel) => pusher.authorizeChannel(socketId, channel),
    async publish(userId, event, data) {
      if (!pusher) return;
      try {
        let name = event;
        let body = data;
        if (JSON.stringify(data || {}).length > MAX_EVENT_BYTES) {
          name = 'poke';
          body = {};
        }
        await pusher.trigger(channelOf(userId), name, body);
      } catch (e) {
        console.warn('> realtime publish failed:', e && e.message);
      }
    },
  };
}

function getServices() {
  const g = globalThis;
  if (!g.__eb_services) {
    const db = createDb();
    const push = createPush(db);
    const media = createMedia();
    const publisher = createPublisher();
    g.__eb_services = { db, push, media, publisher, rt: createRt({ db, push, media, publisher }) };
  }
  return g.__eb_services;
}

module.exports = { getServices };
