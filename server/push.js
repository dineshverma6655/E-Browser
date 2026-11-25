// Web Push (works when the app/tab is closed). Needs VAPID keys: `npm run vapid`.
const webpush = require('web-push');

function createPush(db) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const enabled = Boolean(pub && priv);

  if (enabled) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);
  } else {
    console.warn('> Push disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing (run `npm run vapid`).');
  }

  return {
    enabled,
    publicKey: pub || null,

    // Payload never contains chat text/photos — only "someone is calling / new message".
    async notify(userId, payload) {
      if (!enabled) return;
      const subs = await db.getPushSubscriptions(userId);
      await Promise.all(
        subs.map(async (sub) => {
          try {
            await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: payload.type === 'call' ? 45 : 3600, urgency: 'high' });
          } catch (e) {
            if (e.statusCode === 404 || e.statusCode === 410) {
              await db.deletePushSubscription(sub.endpoint).catch(() => {});
            } else {
              console.warn('> Push failed:', e.statusCode || e.message);
            }
          }
        })
      );
    },
  };
}

module.exports = { createPush };
