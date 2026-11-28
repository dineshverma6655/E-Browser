// Serverless realtime layer (runs inside Vercel API routes, so it keeps NO state in memory).
//
// The browser sends every action as an HTTP request:  { userId, secret, sessionId, event, payload }
// and gets back:                                        { ack, events: [[name, data], ...], more }
//   - `events` are what the old Socket.io server would have emitted to the SENDER of the request.
//   - Events for the OTHER person are published to their private Pusher channel (see services.js).
// Presence, calls and the notification window live in Postgres (see db.js), not in memory.
const { randomUUID } = require('crypto');
const { nextHeadline } = require('./headlines');

const RING_TIMEOUT_MS = 40_000;
// A locked phone / network switch stops the heartbeat while the P2P media keeps flowing. Give the user this long to come back.
const CALL_GRACE_MS = Number(process.env.CALL_GRACE_MS) || 120_000;
const VIDEO_MAX = 500 * 1024 * 1024; // 500 MB
const IMAGE_MAX = 500 * 1024 * 1024; // 500 MB
// Message notifications: at most ONE per recipient per window, however many messages arrive (1 or 100).
const NOTIFY_WINDOW_MS = (Number(process.env.NOTIFY_WINDOW_MIN) || 10) * 60 * 1000;
const MAX_UNSEEN_VIDEOS = 6; // a sender may have at most 6 videos the partner has not seen yet
const IMAGE_MIME = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;
const VIDEO_MIME = /^video\/[a-z0-9.+-]+$/i;
// Every message has its OWN timer, counted from the moment it was sent (default 24 h).
const MSG_TTL_MS = (Number(process.env.MESSAGE_TTL_HOURS) || 24) * 60 * 60 * 1000;
const MAX_MSG_CHARS = 4 * 1024 * 1024; // base64 photo upper bound
const ID_RE = /^P2P-[A-Z0-9]{6,12}$/;
// Vercel limits a response to 4.5 MB: redelivery is split into batches below this size.
const BATCH_BYTES = 3 * 1024 * 1024;
// Long polling (used when there is no Pusher): a heartbeat may wait this long for something to change before answering.
const WAIT_MS = 6_000;
const WAIT_STEP_MS = 1_000;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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

function createRt({ db, push, media = { enabled: false }, publisher }) {
  const pairAttempts = new Map(); // userId -> [timestamps] (best effort, per warm instance)

  const rateLimited = (userId) => {
    const now = Date.now();
    const list = (pairAttempts.get(userId) || []).filter((t) => now - t < 60_000);
    list.push(now);
    pairAttempts.set(userId, list);
    return list.length > 6;
  };

  // ---- per-request context ----
  // send(): to the requester -> goes into the HTTP response; to anyone else -> published on their channel.
  const send = (ctx, userId, event, data) => {
    if (userId === ctx.me) ctx.out.push([event, data]);
    else ctx.jobs.push(publisher.publish(userId, event, data));
  };
  const background = (ctx, promise) => ctx.jobs.push(promise.catch((e) => console.warn('> background task failed:', e && e.message)));

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

  // Send every message this user has not SEEN yet (up to ~3 MB per response; `more` tells the client to ask again).
  const redeliver = async (ctx, userId, skip = []) => {
    const skipSet = new Set(skip);
    const queued = (await db.peekMessages(userId, MSG_TTL_MS)).filter((m) => !skipSet.has(m.id));
    let bytes = 0;
    for (let i = 0; i < queued.length; i++) {
      const out = await outbound(queued[i]).catch(() => null);
      if (!out) continue;
      const size = JSON.stringify(out).length;
      if (bytes > 0 && bytes + size > BATCH_BYTES) {
        ctx.more = true;
        return;
      }
      bytes += size;
      send(ctx, userId, 'chat-message', out);
    }
  };

  const notifyNewMessage = async (ctx, userId) => {
    const pres = await db.getPresence(userId);
    if (pres && pres.online && pres.visible !== false) return; // looking at the app right now: no notification needed
    if (!(await db.claimNotify(userId, NOTIFY_WINDOW_MS))) return;
    // Looks like a news alert (a real headline). Nothing about the chat: no text, no count, no sender.
    background(
      ctx,
      nextHeadline()
        .then((body) => push.notify(userId, { type: 'message', title: 'Top stories', body }))
        .then((r) => console.log(`> message push for ${userId}: devices=${r.total} sent=${r.sent} failed=${r.failed}`))
    );
  };

  // ---- call lifecycle ----
  async function endCall(ctx, call, status, notify) {
    const secs = await db.finishCall(call.id, status);
    if (secs === null) return; // somebody else already ended it
    for (const [userId, event, data] of notify) send(ctx, userId, event, { ...data, id: call.id });

    // A record of the call appears in BOTH chats (missed calls too, even if the person is offline).
    // It is stored like a message, so it waits until it has been seen, then it is deleted.
    for (const [userId, other] of [
      [call.caller, call.callee],
      [call.callee, call.caller],
    ]) {
      try {
        const entry = {
          id: `call-${call.id}-${userId}`,
          timestamp: Date.now(),
          call: { video: call.video, status, duration: secs, outgoing: call.caller === userId },
        };
        await db.queueMessage(entry.id, userId, other, entry);
        send(ctx, userId, 'chat-message', entry);
      } catch (e) {
        console.error('call entry failed', e);
      }
    }
  }

  // The live call of this user. A call that rang too long, or whose people have vanished, is closed here (nothing runs timers).
  async function activeCall(ctx, userId) {
    const call = await db.getActiveCall(userId);
    if (!call) return null;
    if (call.status === 'ringing' && Date.now() - call.startedAt > RING_TIMEOUT_MS) {
      await endCall(ctx, call, 'missed', [
        [call.caller, 'call-missed', {}],
        [call.callee, 'call-ended', {}],
      ]);
      return null;
    }
    if (call.status === 'answered') {
      const [a, b] = await Promise.all([db.isStale(call.caller, CALL_GRACE_MS), db.isStale(call.callee, CALL_GRACE_MS)]);
      if (a || b) {
        await endCall(ctx, call, 'completed', [
          [call.caller, 'call-ended', {}],
          [call.callee, 'call-ended', {}],
        ]);
        return null;
      }
    }
    return call;
  }

  // Everything a device needs to catch up if it missed a realtime event.
  async function stateFor(ctx, me) {
    const partnerId = await db.getPartner(me);
    const [pres, call, pending] = await Promise.all([partnerId ? db.getPresence(partnerId) : null, activeCall(ctx, me), db.pendingIds(me)]);
    const st = {
      partnerId,
      partner: pres ? { online: pres.online, lastSeen: pres.lastSeen } : null,
      call: call ? { id: call.id, caller: call.caller, callee: call.callee, status: call.status, video: call.video } : null,
      pending,
    };
    // Fingerprint of everything above: a device that already knows it can ask to be told only when it changes.
    st.stamp = JSON.stringify([st.partnerId, st.partner && st.partner.online, st.call && [st.call.id, st.call.status], pending]);
    return st;
  }

  // ---- event handlers: (ctx, me, payload) -> optional ack value ----
  const handlers = {
    async 'register-user'(ctx, me, _p, req) {
      const prev = await db.startSession(me, req.sessionId);
      if (prev.sessionId && prev.sessionId !== req.sessionId && prev.online) {
        background(ctx, publisher.publish(me, 'replaced', { sessionId: prev.sessionId }));
      }

      const partnerId = await db.getPartner(me);
      const pres = partnerId ? await db.getPresence(partnerId) : null;
      const partnerOnline = Boolean(pres && pres.online);
      if (partnerOnline) send(ctx, partnerId, 'partner-status', { partnerId: me, online: true });

      const call = await activeCall(ctx, me);
      send(ctx, me, 'registered', {
        userId: me,
        partnerId,
        isPartnerOnline: partnerOnline,
        partnerLastSeen: partnerId && !partnerOnline && pres ? pres.lastSeen : null,
        isNew: ctx.isNew,
        inCall: Boolean(call),
      });

      // Re-deliver everything not yet SEEN. Rows are deleted only when the client confirms (messages-seen).
      await redeliver(ctx, me);

      // A call that is still ringing for me
      if (call && call.callee === me && call.status === 'ringing') send(ctx, me, 'incoming-call', { callerId: call.caller, video: call.video, id: call.id });

      send(ctx, me, 'call-history', await db.recentCalls(me, 20).catch(() => []));

      // Housekeeping: unseen messages vanish after 24 h (nothing runs in the background any more).
      background(ctx, db.purgeOldMessages(MSG_TTL_MS).then(cleanupMedia));
    },

    // Called every few seconds by the open app. Keeps the user "online" and lets a device catch up on anything it missed.
    async heartbeat(ctx, me, p = {}) {
      const wasOnline = await db.heartbeat(me);
      let st = await stateFor(ctx, me);
      // Back after a pause (phone woke up): the partner should see "online" again right away.
      if (!wasOnline && st.partnerId) send(ctx, st.partnerId, 'partner-status', { partnerId: me, online: true });

      // Long poll: hold the request until something changes (a message, a call, the partner coming or going) or the time
      // is up. This gives near-instant delivery without any extra realtime service.
      if (p.wait && typeof p.stamp === 'string' && p.stamp === st.stamp) {
        const until = Date.now() + WAIT_MS;
        while (Date.now() < until && ctx.out.length === 0) {
          await sleep(WAIT_STEP_MS);
          const next = await stateFor(ctx, me);
          if (next.stamp !== st.stamp) {
            st = next;
            break;
          }
        }
      }
      return st;
    },

    // The page is going away (best effort, sent with sendBeacon).
    async bye(ctx, me) {
      await db.markOffline(me);
      const partnerId = await db.getPartner(me);
      const call = await db.getActiveCall(me);
      // The caller vanished while it was still ringing. (A ringing callee may reopen the app from the push.)
      if (call && call.status === 'ringing' && call.caller === me) {
        await endCall(ctx, call, 'missed', [[call.callee, 'call-ended', {}]]);
      }
      if (partnerId) send(ctx, partnerId, 'partner-status', { partnerId: me, online: false, lastSeen: Date.now() });
    },

    // ---- permanent pairing ----
    async 'pair-with-partner'(ctx, me, { targetPartnerId } = {}) {
      if (rateLimited(me)) return send(ctx, me, 'pair-error', { message: 'Too many attempts. Please wait a minute and try again.' });
      const target = String(targetPartnerId || '').trim().toUpperCase();
      if (!ID_RE.test(target)) return send(ctx, me, 'pair-error', { message: 'That code is not in the right format.' });
      const res = await db.pair(me, target);
      if (!res.ok) {
        const msg = {
          self: 'You cannot pair with your own code.',
          'not-found': 'No one has used that code yet. Check it with your partner (they need to open the app first).',
          'self-busy': 'You are already paired with someone. Unpair first.',
          'target-busy': 'That code is already paired with someone else.',
        }[res.reason];
        return send(ctx, me, 'pair-error', { message: msg || 'Pairing fail ho gayi.' });
      }
      const pres = await db.getPresence(target);
      const targetOnline = Boolean(pres && pres.online);
      send(ctx, me, 'pair-success', { partnerId: target, isPartnerOnline: targetOnline, partnerLastSeen: targetOnline ? null : pres && pres.lastSeen });
      send(ctx, target, 'pair-success', { partnerId: me, isPartnerOnline: true });
    },

    async unpair(ctx, me) {
      const call = await activeCall(ctx, me);
      if (call) await endCall(ctx, call, 'missed', [[call.caller === me ? call.callee : call.caller, 'call-ended', {}]]);
      const res = await db.unpair(me);
      const old = res && res.partner;
      if (res) cleanupMedia(res.removed);
      send(ctx, me, 'unpaired', { message: 'Unpaired.' });
      if (old) send(ctx, old, 'unpaired', { message: 'Your partner has unpaired.' });
    },

    // ---- call signaling (media itself is P2P; started by caller after accept) ----
    async 'start-call'(ctx, me, { video } = {}) {
      const partnerId = await db.getPartner(me);
      if (!partnerId) return send(ctx, me, 'call-error', { message: 'Pair with a partner first.' });
      if ((await activeCall(ctx, me)) || (await activeCall(ctx, partnerId))) {
        return send(ctx, me, 'call-error', { message: 'A call is already in progress.' });
      }
      const wantVideo = video !== false;
      const id = await db.createCall(me, partnerId, wantVideo);
      const pres = await db.getPresence(partnerId);
      send(ctx, partnerId, 'incoming-call', { callerId: me, video: wantVideo, id });
      // Not looking at the app (closed, locked, or another tab): wake the phone.
      if (!pres || !pres.online || pres.visible === false) {
        background(ctx, nextHeadline().then((body) => push.notify(partnerId, { type: 'call', title: 'Top stories', body })));
      }
      return { id };
    },

    // Quick check from a call screen: is the call still alive?
    async 'call-ping'(ctx, me) {
      return { active: Boolean(await activeCall(ctx, me)) };
    },

    async 'accept-call'(ctx, me) {
      const call = await activeCall(ctx, me);
      if (!call || call.callee !== me || call.status !== 'ringing') return;
      if (await db.markCallAnswered(call.id)) send(ctx, call.caller, 'call-accepted', { id: call.id });
    },

    async 'decline-call'(ctx, me) {
      const call = await activeCall(ctx, me);
      if (!call || call.callee !== me || call.status !== 'ringing') return;
      await endCall(ctx, call, 'declined', [[call.caller, 'call-declined', {}]]);
    },

    async 'end-call'(ctx, me) {
      const call = await activeCall(ctx, me);
      if (!call) return;
      const other = call.caller === me ? call.callee : call.caller;
      await endCall(ctx, call, call.status === 'answered' ? 'completed' : 'missed', [[other, 'call-ended', {}]]);
    },

    // ---- chat relay (fallback when the P2P data channel is down) + offline queue ----
    async 'chat-message'(ctx, me, { message } = {}) {
      if (!message || typeof message.id !== 'string') return;
      if (JSON.stringify(message).length > MAX_MSG_CHARS) return send(ctx, me, 'chat-error', { id: message.id, message: 'Message is too large.' });
      const partnerId = await db.getPartner(me);
      if (!partnerId) {
        // The pairing no longer exists (the partner paired with someone else / unpaired). Tell the sender instead of
        // silently dropping the message, so the app can go back to the pairing screen.
        return send(ctx, me, 'unpaired', { message: 'You are not paired with anyone any more. Enter a new partner code to pair again.' });
      }
      const id = message.id.slice(0, 80);
      const timestamp = Number(message.timestamp) || Date.now();
      let clean;
      if (message.media) {
        const m = message.media;
        const fail = (msg) => send(ctx, me, 'chat-error', { id, message: msg });
        const kind = m.kind === 'image' ? 'image' : m.kind === 'video' ? 'video' : null;
        if (!media.enabled || !kind || typeof m.key !== 'string' || !m.key.startsWith(`${me}/${partnerId}/`)) return fail('Upload is not available.');
        if (kind === 'video' && (await db.countPendingVideos(me, partnerId)) >= MAX_UNSEEN_VIDEOS) {
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
      await db.queueMessage(clean.id, partnerId, me, clean);
      const out = await outbound(clean).catch(() => null);
      if (out) send(ctx, partnerId, 'chat-message', out);
      await notifyNewMessage(ctx, partnerId); // no-op while the partner is online and looking at the app
    },

    // Emoji reaction on a message (null = removed). Pure relay: reactions are not stored.
    async reaction(ctx, me, { msgId, emoji } = {}) {
      if (typeof msgId !== 'string') return;
      const e = typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 8 ? emoji : null;
      const partnerId = await db.getPartner(me);
      if (partnerId) send(ctx, partnerId, 'reaction', { msgId: msgId.slice(0, 80), emoji: e });
    },

    // "Delete for everyone": drop it from the queue (and cloud storage) if the partner has not received it, and tell them.
    async 'delete-message'(ctx, me, { id } = {}) {
      if (typeof id !== 'string') return;
      const partnerId = await db.getPartner(me);
      if (!partnerId) return;
      const clean = id.slice(0, 80);
      cleanupMedia(await db.deleteOwnPending(me, partnerId, clean));
      send(ctx, partnerId, 'message-deleted', { id: clean });
    },

    // The chat was opened again (it is wiped from memory whenever it is closed): send everything still unseen.
    async 'sync-pending'(ctx, me, p = {}) {
      await redeliver(ctx, me, Array.isArray(p.skip) ? p.skip.filter((x) => typeof x === 'string').slice(0, 500) : []);
    },

    // The client tells us whether the app is on screen. Coming back restarts the notification window.
    async visibility(ctx, me, { visible } = {}) {
      await db.setVisible(me, Boolean(visible));
    },

    // Receiver confirms messages are on screen -> delete from DB and tell the sender ("Seen").
    async 'messages-seen'(ctx, me, { ids } = {}) {
      if (!Array.isArray(ids)) return;
      await db.clearNotified(me); // seen -> if they leave again, the next message notifies immediately
      const clean = ids.filter((x) => typeof x === 'string').slice(0, 200);
      const removed = await db.deleteMessages(me, clean);
      cleanupMedia(removed);
      const partnerId = await db.getPartner(me);
      if (!partnerId) return;
      send(ctx, partnerId, 'messages-seen', { ids: clean });

      // The sender is away (app closed): keep a receipt for them. When they come back they see their own message
      // with the green "seen" dot, and it disappears once they have seen that.
      const pres = await db.getPresence(partnerId);
      if (!pres || !pres.online) {
        for (const p of removed) {
          if (!p || typeof p.id !== 'string' || p.fromId !== partnerId) continue;
          if (p.id.startsWith('call-') || p.id.startsWith('seen-')) continue;
          const kind = p.media ? (p.media.kind === 'video' ? 'video' : 'photo') : p.imageUrl ? 'photo' : 'text';
          const rid = `seen-${p.id}`;
          await db.queueMessage(rid, partnerId, me, {
            id: rid,
            timestamp: p.timestamp || Date.now(),
            receipt: { kind, text: typeof p.text === 'string' ? p.text.slice(0, 120) : undefined },
          });
        }
      }
    },

    async 'photo-opened'(ctx, me, { msgId } = {}) {
      if (typeof msgId !== 'string') return;
      const partnerId = await db.getPartner(me);
      if (partnerId) send(ctx, partnerId, 'photo-opened', { msgId });
    },

    async 'media-toggle'(ctx, me, { mediaStatus } = {}) {
      const partnerId = await db.getPartner(me);
      if (partnerId) send(ctx, partnerId, 'media-toggle', { mediaStatus });
    },

    // Presigned upload URL for a photo/video that cannot go peer-to-peer
    async 'media-upload-url'(ctx, me, { kind, mime, size } = {}) {
      if (!media.enabled) return { error: 'disabled' };
      const typeOk = kind === 'video' ? VIDEO_MIME.test(String(mime)) : kind === 'image' ? IMAGE_MIME.test(String(mime)) : false;
      if (!typeOk) return { error: 'bad-type' };
      if (!Number.isFinite(size) || size <= 0 || size > (kind === 'video' ? VIDEO_MAX : IMAGE_MAX)) return { error: 'too-large' };
      const partnerId = await db.getPartner(me);
      if (!partnerId) return { error: 'not-paired' };
      if (kind === 'video' && (await db.countPendingVideos(me, partnerId)) >= MAX_UNSEEN_VIDEOS) return { error: 'limit' };
      const key = `${me}/${partnerId}/${randomUUID()}`;
      return { key, url: await media.uploadUrl(key, String(mime)) };
    },

    async 'push-subscribe'(ctx, me, { subscription } = {}) {
      if (!subscription || typeof subscription.endpoint !== 'string') return { ok: false };
      await db.savePushSubscription(me, subscription);
      return { ok: true };
    },

    // "Send test notification" button in settings: pushes to this user's own devices right now.
    async 'push-test'(ctx, me) {
      if (!push.enabled) return { ok: false, reason: 'server-off' };
      const r = await push.notify(me, { type: 'test', title: 'Top stories', body: await nextHeadline() });
      return { ok: true, ...r };
    },
  };
  // Small notifications relayed to the partner (saved media, screenshot attempts)
  for (const ev of ['media-saved', 'screenshot-attempt']) {
    handlers[ev] = async (ctx, me, { msgId, kind } = {}) => {
      const partnerId = await db.getPartner(me);
      if (partnerId) send(ctx, partnerId, ev, { msgId: String(msgId || '').slice(0, 80), kind: kind === 'video' ? 'video' : 'photo' });
    };
  }

  // One request from one device.
  async function handle(req) {
    const { userId, secret, sessionId, event, payload } = req || {};
    const ctx = { me: userId, out: [], jobs: [], more: false, isNew: false };
    const reply = (extra = {}) => ({ events: ctx.out, more: ctx.more, ...extra });
    try {
      if (typeof userId !== 'string' || !ID_RE.test(userId) || typeof secret !== 'string' || secret.length < 16 || typeof event !== 'string') {
        return { events: [['register-error', { code: 'bad-request' }]], more: false };
      }
      const handler = handlers[event];
      if (!handler) return reply();

      if (event === 'register-user') {
        const auth = await db.authenticate(userId, secret);
        if (auth === 'denied') return { events: [['register-error', { code: 'id-taken' }]], more: false };
        ctx.isNew = auth === 'created';
      } else {
        const who = await db.verify(userId, secret);
        if (!who) return { events: [['register-error', { code: 'id-taken' }]], more: false };
        // Another device took this account over: this one must stop.
        if (who.sessionId && sessionId && who.sessionId !== sessionId) return { events: [['replaced', { sessionId }]], more: false };
      }

      const ack = await handler(ctx, userId, payload && typeof payload === 'object' ? payload : {}, { sessionId });
      await Promise.all(ctx.jobs);
      return reply({ ack: ack === undefined ? null : ack });
    } catch (e) {
      console.error(`rt ${event} failed:`, e);
      await Promise.allSettled(ctx.jobs);
      if (event === 'register-user') ctx.out.push(['register-error', { code: 'server' }]);
      else if (event === 'pair-with-partner') ctx.out.push(['pair-error', { message: 'Server error. Please try again.' }]);
      else if (event === 'start-call') ctx.out.push(['call-error', { message: 'The call could not be started.' }]);
      return reply({ ack: null, error: true });
    }
  }

  return { handle, ID_RE };
}

module.exports = { createRt };
