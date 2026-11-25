// Socket.io realtime layer: auth, presence, pairing, call signaling, message relay + offline queue.
const { randomUUID } = require('crypto');

const RING_TIMEOUT_MS = 40_000;
// A locked phone / network switch drops the socket while the P2P media keeps flowing. Give the user this long to come back.
const CALL_GRACE_MS = Number(process.env.CALL_GRACE_MS) || 60_000;
const VIDEO_MAX = 500 * 1024 * 1024; // 500 MB
const IMAGE_MAX = 500 * 1024 * 1024; // 500 MB
const MAX_UNSEEN_VIDEOS = 6; // a sender may have at most 6 videos the partner has not seen yet
const IMAGE_MIME = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;
const VIDEO_MIME = /^video\/[a-z0-9.+-]+$/i;
// Every message has its OWN timer, counted from the moment it was sent (default 24 h).
const MSG_TTL_MS = (Number(process.env.MESSAGE_TTL_HOURS) || 24) * 60 * 60 * 1000;
const MAX_MSG_CHARS = 4 * 1024 * 1024; // base64 photo upper bound
const ID_RE = /^P2P-[A-Z0-9]{6,12}$/;

// A reply quotes another message. `mine` is relative to the sender (the receiver flips it).
function cleanReply(r) {
  if (!r || typeof r.id !== 'string') return undefined;
  return {
    id: r.id.slice(0, 80),
    text: typeof r.text === 'string' ? r.text.slice(0, 200) : undefined,
    kind: ['text', 'photo', 'video'].includes(r.kind) ? r.kind : 'text',
    mine: Boolean(r.mine),
  };
}

function attachRealtime(io, db, push, media = { enabled: false }) {
  const online = new Map(); // userId -> socketId
  const socketUser = new Map(); // socketId -> userId
  const calls = new Map(); // userId -> call (both participants point at the same object)
  const pairAttempts = new Map(); // socketId -> [timestamps]

  const emitTo = (userId, event, data) => {
    const sid = online.get(userId);
    if (sid) io.to(sid).emit(event, data);
    return Boolean(sid);
  };

  // Cloud videos: strip the internal key, hand the receiver a short-lived download URL instead.
  const cleanupMedia = (payloads) => {
    if (!media.enabled) return;
    for (const p of payloads || []) if (p && p.media && p.media.key) media.remove(p.media.key);
  };
  const outbound = async (p) => {
    if (!p.media) return p;
    if (!media.enabled) return null;
    const url = await media.downloadUrl(p.media.key);
    return { id: p.id, timestamp: p.timestamp, replyTo: p.replyTo, media: { kind: p.media.kind, mime: p.media.mime, size: p.media.size, url } };
  };

  const rateLimited = (socketId) => {
    const now = Date.now();
    const list = (pairAttempts.get(socketId) || []).filter((t) => now - t < 60_000);
    list.push(now);
    pairAttempts.set(socketId, list);
    return list.length > 6;
  };

  // ---- call lifecycle ----
  const clearCall = (call) => {
    clearTimeout(call.timer);
    clearTimeout(call.dropTimer);
    calls.delete(call.caller);
    calls.delete(call.callee);
  };

  async function endCall(call, status, notify) {
    if (!call || call.done) return;
    call.done = true;
    clearCall(call);
    const secs = call.answeredAt ? (Date.now() - call.answeredAt) / 1000 : 0;
    await db.finishCall(call.id, status, secs).catch((e) => console.error('finishCall', e));
    for (const [userId, event, data] of notify) emitTo(userId, event, data);

    // A record of the call appears in BOTH chats (missed calls too, even if the person is offline).
    // It is stored like a message, so it waits until it has been seen, then it is deleted.
    for (const [userId, other] of [[call.caller, call.callee], [call.callee, call.caller]]) {
      try {
        const entry = {
          id: `call-${call.id}-${userId}`,
          timestamp: Date.now(),
          call: { video: call.video, status, duration: Math.round(secs), outgoing: call.caller === userId },
        };
        await db.queueMessage(entry.id, userId, other, entry);
        emitTo(userId, 'chat-message', entry);
      } catch (e) {
        console.error('call entry failed', e);
      }
    }
  }

  io.on('connection', (socket) => {
    const me = () => socketUser.get(socket.id);

    socket.on('register-user', async ({ userId, secret } = {}, ack) => {
      try {
        if (typeof userId !== 'string' || !ID_RE.test(userId) || typeof secret !== 'string' || secret.length < 16) {
          return socket.emit('register-error', { code: 'bad-request' });
        }
        const auth = await db.authenticate(userId, secret);
        if (auth === 'denied') return socket.emit('register-error', { code: 'id-taken' });

        // Only one live socket per user: the newest wins.
        const old = online.get(userId);
        if (old && old !== socket.id) {
          socketUser.delete(old);
          io.to(old).emit('replaced');
        }
        online.set(userId, socket.id);
        socketUser.set(socket.id, userId);

        // Back within the grace period: the call carries on.
        const liveCall = calls.get(userId);
        if (liveCall && liveCall.dropTimer) {
          clearTimeout(liveCall.dropTimer);
          liveCall.dropTimer = null;
        }

        const partnerId = await db.getPartner(userId);
        const partnerOnline = Boolean(partnerId && online.has(partnerId));
        if (partnerOnline) emitTo(partnerId, 'partner-status', { partnerId: userId, online: true });

        socket.emit('registered', { userId, partnerId, isPartnerOnline: partnerOnline, isNew: auth === 'created', inCall: calls.has(userId) });

        // Re-deliver everything not yet SEEN. Rows are deleted only when the client confirms (messages-seen).
        const queued = await db.peekMessages(userId, MSG_TTL_MS);
        for (const m of queued) {
          const out = await outbound(m).catch(() => null);
          if (out) socket.emit('chat-message', out);
        }

        // A call that is still ringing for me
        const call = calls.get(userId);
        if (call && call.callee === userId && !call.answeredAt) socket.emit('incoming-call', { callerId: call.caller, video: call.video });

        db.recentCalls(userId, 20)
          .then((rows) => socket.emit('call-history', rows))
          .catch(() => {});
      } catch (e) {
        console.error('register-user failed', e);
        socket.emit('register-error', { code: 'server' });
      }
    });

    // ---- permanent pairing ----
    socket.on('pair-with-partner', async ({ targetPartnerId } = {}) => {
      const myId = me();
      if (!myId) return socket.emit('pair-error', { message: 'Not connected to the server yet.' });
      if (rateLimited(socket.id)) return socket.emit('pair-error', { message: 'Too many attempts. Please wait a minute and try again.' });
      const target = String(targetPartnerId || '').trim().toUpperCase();
      if (!ID_RE.test(target)) return socket.emit('pair-error', { message: 'That code is not in the right format.' });
      try {
        const res = await db.pair(myId, target);
        if (!res.ok) {
          const msg = {
            self: 'You cannot pair with your own code.',
            'not-found': 'No one has used that code yet. Check it with your partner (they need to open the app first).',
            'self-busy': 'You are already paired with someone. Unpair first.',
            'target-busy': 'That code is already paired with someone else.',
          }[res.reason];
          return socket.emit('pair-error', { message: msg || 'Pairing fail ho gayi.' });
        }
        socket.emit('pair-success', { partnerId: target, isPartnerOnline: online.has(target) });
        emitTo(target, 'pair-success', { partnerId: myId, isPartnerOnline: true });
      } catch (e) {
        console.error('pair failed', e);
        socket.emit('pair-error', { message: 'Server error. Please try again.' });
      }
    });

    socket.on('unpair', async () => {
      const myId = me();
      if (!myId) return;
      try {
        const call = calls.get(myId);
        if (call) await endCall(call, 'missed', [[call.caller === myId ? call.callee : call.caller, 'call-ended', {}]]);
        const res = await db.unpair(myId);
        const old = res && res.partner;
        if (res) cleanupMedia(res.removed);
        socket.emit('unpaired', { message: 'Unpaired.' });
        if (old) emitTo(old, 'unpaired', { message: 'Your partner has unpaired.' });
      } catch (e) {
        console.error('unpair failed', e);
      }
    });

    // ---- call signaling (media itself is P2P; started by caller after accept) ----
    socket.on('start-call', async ({ video } = {}) => {
      const myId = me();
      if (!myId) return;
      try {
        const partnerId = await db.getPartner(myId);
        if (!partnerId) return socket.emit('call-error', { message: 'Pair with a partner first.' });
        if (calls.has(myId) || calls.has(partnerId)) return socket.emit('call-error', { message: 'A call is already in progress.' });

        const id = await db.createCall(myId, partnerId);
        const call = { id, caller: myId, callee: partnerId, video: video !== false, answeredAt: null, done: false };
        calls.set(myId, call);
        calls.set(partnerId, call);

        const delivered = emitTo(partnerId, 'incoming-call', { callerId: myId, video: call.video });
        if (!delivered) push.notify(partnerId, { type: 'call', title: 'Web Browser', body: 'New notification' });

        call.timer = setTimeout(() => {
          endCall(call, 'missed', [
            [call.caller, 'call-missed', {}],
            [call.callee, 'call-ended', {}],
          ]);
        }, RING_TIMEOUT_MS);
      } catch (e) {
        console.error('start-call failed', e);
        socket.emit('call-error', { message: 'The call could not be started.' });
      }
    });

    // Heartbeat while a call screen is open: lets a client discover that the call already ended (missed signal).
    socket.on('call-ping', (_p, ack) => {
      if (typeof ack === 'function') ack({ active: calls.has(me()) });
    });

    socket.on('accept-call', async () => {
      const call = calls.get(me());
      if (!call || call.callee !== me() || call.answeredAt) return;
      clearTimeout(call.timer);
      call.answeredAt = Date.now();
      await db.markCallAnswered(call.id).catch(() => {});
      emitTo(call.caller, 'call-accepted', {});
    });

    socket.on('decline-call', async () => {
      const call = calls.get(me());
      if (!call || call.callee !== me() || call.answeredAt) return;
      await endCall(call, 'declined', [[call.caller, 'call-declined', {}]]);
    });

    socket.on('end-call', async () => {
      const call = calls.get(me());
      if (!call) return;
      const other = call.caller === me() ? call.callee : call.caller;
      await endCall(call, call.answeredAt ? 'completed' : 'missed', [[other, 'call-ended', {}]]);
    });

    // ---- chat relay (fallback when the P2P data channel is down) + offline queue ----
    socket.on('chat-message', async ({ message } = {}) => {
      const myId = me();
      if (!myId || !message || typeof message.id !== 'string') return;
      if (JSON.stringify(message).length > MAX_MSG_CHARS) return socket.emit('chat-error', { id: message.id, message: 'Message is too large.' });
      try {
        const partnerId = await db.getPartner(myId);
        if (!partnerId) return;
        const id = message.id.slice(0, 80);
        const timestamp = Number(message.timestamp) || Date.now();
        let clean;
        if (message.media) {
          const m = message.media;
          const fail = (msg) => socket.emit('chat-error', { id, message: msg });
          const kind = m.kind === 'image' ? 'image' : m.kind === 'video' ? 'video' : null;
          if (!media.enabled || !kind || typeof m.key !== 'string' || !m.key.startsWith(`${myId}/${partnerId}/`)) {
            return fail('Upload is not available.');
          }
          if (kind === 'video' && (await db.countPendingVideos(myId, partnerId)) >= MAX_UNSEEN_VIDEOS) {
            media.remove(m.key);
            return fail(`You can have at most ${MAX_UNSEEN_VIDEOS} unseen videos. Wait until your partner watches some.`);
          }
          const size = await media.head(m.key);
          if (size === null) return fail('Upload not found. Please try again.');
          if (size > (kind === 'video' ? VIDEO_MAX : IMAGE_MAX)) {
            media.remove(m.key);
            return fail(kind === 'video' ? 'Video is larger than 500 MB.' : 'Photo is larger than 500 MB.');
          }
          const okMime = (kind === 'video' ? VIDEO_MIME : IMAGE_MIME).test(String(m.mime));
          const mime = okMime ? String(m.mime) : kind === 'video' ? 'video/mp4' : 'image/jpeg';
          clean = { id, timestamp, replyTo: cleanReply(message.replyTo), media: { key: m.key, kind, mime, size } };
        } else {
          clean = {
            id,
            text: typeof message.text === 'string' ? message.text.slice(0, 4000) : undefined,
            imageUrl: typeof message.imageUrl === 'string' && message.imageUrl.startsWith('data:image/') ? message.imageUrl : undefined,
            replyTo: cleanReply(message.replyTo),
            timestamp,
          };
          if (!clean.text && !clean.imageUrl) return;
        }
        // Store first, then deliver live. It stays in Postgres until the partner has actually SEEN it.
        await db.queueMessage(clean.id, partnerId, myId, clean);
        if (online.has(partnerId)) {
          const out = await outbound(clean).catch(() => null);
          if (out) emitTo(partnerId, 'chat-message', out);
        } else {
          push.notify(partnerId, { type: 'message', title: 'Web Browser', body: 'New notification' });
        }
      } catch (e) {
        console.error('chat-message failed', e);
      }
    });

    // Emoji reaction on a message (null = removed). Pure relay: reactions are not stored.
    socket.on('reaction', async ({ msgId, emoji } = {}) => {
      const myId = me();
      if (!myId || typeof msgId !== 'string') return;
      const e = typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 8 ? emoji : null;
      const partnerId = await db.getPartner(myId).catch(() => null);
      if (partnerId) emitTo(partnerId, 'reaction', { msgId: msgId.slice(0, 80), emoji: e });
    });

    // "Delete for everyone": drop it from the queue (and cloud storage) if the partner has not received it, and tell them.
    socket.on('delete-message', async ({ id } = {}) => {
      const myId = me();
      if (!myId || typeof id !== 'string') return;
      try {
        const partnerId = await db.getPartner(myId);
        if (!partnerId) return;
        const clean = id.slice(0, 80);
        cleanupMedia(await db.deleteOwnPending(myId, partnerId, clean));
        emitTo(partnerId, 'message-deleted', { id: clean });
      } catch (e) {
        console.error('delete-message failed', e);
      }
    });

    // Receiver confirms messages are on screen → delete from DB and tell the sender ("Seen").
    socket.on('messages-seen', async ({ ids } = {}) => {
      const myId = me();
      if (!myId || !Array.isArray(ids)) return;
      const clean = ids.filter((x) => typeof x === 'string').slice(0, 200);
      try {
        const removed = await db.deleteMessages(myId, clean);
        cleanupMedia(removed);
        const partnerId = await db.getPartner(myId);
        if (partnerId) emitTo(partnerId, 'messages-seen', { ids: clean });

        // The sender is away (app closed): keep a receipt for them. When they come back they see their own message
        // with the green "seen" dot, and it disappears once they have seen that.
        if (partnerId && !online.has(partnerId)) {
          for (const p of removed) {
            if (!p || typeof p.id !== 'string' || p.fromId !== partnerId) continue;
            if (p.id.startsWith('call-') || p.id.startsWith('seen-')) continue;
            const kind = p.media ? (p.media.kind === 'video' ? 'video' : 'photo') : p.imageUrl ? 'photo' : 'text';
            const rid = `seen-${p.id}`;
            await db.queueMessage(rid, partnerId, myId, {
              id: rid,
              timestamp: p.timestamp || Date.now(),
              receipt: { kind, text: typeof p.text === 'string' ? p.text.slice(0, 120) : undefined },
            });
          }
        }
      } catch (e) {
        console.error('messages-seen failed', e);
      }
    });

    socket.on('photo-opened', async ({ msgId } = {}) => {
      const myId = me();
      if (!myId || typeof msgId !== 'string') return;
      const partnerId = await db.getPartner(myId).catch(() => null);
      if (partnerId) emitTo(partnerId, 'photo-opened', { msgId });
    });

    socket.on('media-toggle', async ({ mediaStatus } = {}) => {
      const myId = me();
      if (!myId) return;
      const partnerId = await db.getPartner(myId).catch(() => null);
      if (partnerId) emitTo(partnerId, 'media-toggle', { mediaStatus });
    });

    // Small notifications relayed to the partner (saved media, screenshot attempts)
    for (const ev of ['media-saved', 'screenshot-attempt']) {
      socket.on(ev, async ({ msgId, kind } = {}) => {
        const myId = me();
        if (!myId) return;
        const partnerId = await db.getPartner(myId).catch(() => null);
        if (partnerId) emitTo(partnerId, ev, { msgId: String(msgId || '').slice(0, 80), kind: kind === 'video' ? 'video' : 'photo' });
      });
    }

    // Presigned upload URL for a video that cannot go peer-to-peer
    socket.on('media-upload-url', async ({ kind, mime, size } = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const myId = me();
      if (!myId) return reply({ error: 'not-registered' });
      if (!media.enabled) return reply({ error: 'disabled' });
      const typeOk = kind === 'video' ? VIDEO_MIME.test(String(mime)) : kind === 'image' ? IMAGE_MIME.test(String(mime)) : false;
      if (!typeOk) return reply({ error: 'bad-type' });
      if (!Number.isFinite(size) || size <= 0 || size > (kind === 'video' ? VIDEO_MAX : IMAGE_MAX)) return reply({ error: 'too-large' });
      try {
        const partnerId = await db.getPartner(myId);
        if (!partnerId) return reply({ error: 'not-paired' });
        if (kind === 'video' && (await db.countPendingVideos(myId, partnerId)) >= MAX_UNSEEN_VIDEOS) return reply({ error: 'limit' });
        const key = `${myId}/${partnerId}/${randomUUID()}`;
        reply({ key, url: await media.uploadUrl(key, String(mime)) });
      } catch (e) {
        console.error('media-upload-url failed', e);
        reply({ error: 'server' });
      }
    });

    socket.on('push-subscribe', async ({ subscription } = {}) => {
      const myId = me();
      if (!myId || !subscription || typeof subscription.endpoint !== 'string') return;
      await db.savePushSubscription(myId, subscription).catch((e) => console.error('push-subscribe', e));
    });

    socket.on('disconnect', async () => {
      pairAttempts.delete(socket.id);
      const userId = socketUser.get(socket.id);
      socketUser.delete(socket.id);
      if (!userId || online.get(userId) !== socket.id) return;
      online.delete(userId);
      try {
        db.touch(userId).catch(() => {});
        const call = calls.get(userId);
        if (call) {
          const other = call.caller === userId ? call.callee : call.caller;
          if (call.answeredAt) {
            // Answered call: do NOT end it. Media is peer-to-peer and survives a dropped socket (screen lock, network switch).
            clearTimeout(call.dropTimer);
            call.dropTimer = setTimeout(() => {
              if (!online.has(userId)) endCall(call, 'completed', [[other, 'call-ended', {}]]);
            }, CALL_GRACE_MS);
          } else if (call.caller === userId) {
            // The caller vanished while it was still ringing. (A ringing callee may reopen the app from the push.)
            await endCall(call, 'missed', [[other, 'call-ended', {}]]);
          }
        }
        const partnerId = await db.getPartner(userId);
        if (partnerId) emitTo(partnerId, 'partner-status', { partnerId: userId, online: false });
      } catch (e) {
        console.error('disconnect cleanup failed', e);
      }
    });
  });

  // Snapchat-style: undelivered messages vanish after 24h.
  const sweep = () => db.purgeOldMessages(MSG_TTL_MS).then(cleanupMedia).catch((e) => console.error('purge', e));
  sweep();
  setInterval(sweep, 5 * 60 * 1000).unref();
}

module.exports = { attachRealtime };
