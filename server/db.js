// PostgreSQL layer: users, permanent pairings, offline message queue, call logs, push subscriptions.
const crypto = require('crypto');
const { Pool } = require('pg');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pairings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pending_messages (
  id         TEXT PRIMARY KEY,
  to_id      TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_messages_to_idx ON pending_messages(to_id);
CREATE TABLE IF NOT EXISTS call_logs (
  id          BIGSERIAL PRIMARY KEY,
  caller_id   TEXT NOT NULL,
  callee_id   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ringing',
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  duration_s  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);
`;

// A user counts as online while their last heartbeat is younger than this.
const ONLINE_WINDOW_S = 45;

const hash = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function createPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Add DATABASE_URL=postgresql://user:pass@host:5432/dbname to .env.'
    );
  }
  const useSsl = process.env.DATABASE_SSL === 'true';
  // Serverless: every function instance keeps only a couple of connections (the pooler hands them out).
  return new Pool({
    connectionString: url,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.DB_POOL_MAX) || 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
}

// `pool` can be injected (tests); otherwise built from env.
function createDb(pool = createPool()) {
  const q = (text, params) => pool.query(text, params);

  return {
    pool,

    // Tables are created by Prisma migrations (`npm run db:deploy`), not here.
    async init() {
      const { rows } = await q("SELECT 1 FROM information_schema.tables WHERE table_name = 'users'");
      if (rows.length === 0) {
        throw new Error('Database tables not found. Run `npm run db:deploy` first.');
      }
    },

    // Returns 'created' | 'ok' | 'denied'
    async authenticate(userId, secret) {
      const h = hash(secret);
      const { rows } = await q('SELECT secret_hash FROM users WHERE id = $1', [userId]);
      if (rows.length === 0) {
        const ins = await q(
          'INSERT INTO users (id, secret_hash) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [userId, h]
        );
        if (ins.rowCount === 0) return 'denied'; // lost a race with another registration
        return 'created';
      }
      if (!safeEqual(rows[0].secret_hash, h)) return 'denied';
      await q('UPDATE users SET last_seen = now() WHERE id = $1', [userId]);
      return 'ok';
    },

    async touch(userId) {
      await q('UPDATE users SET last_seen = now() WHERE id = $1', [userId]);
    },

    // ---- presence (heartbeat based; there are no long-lived sockets on Vercel) ----
    // The stored credentials of a user (no side effects): { secret_hash, session_id } or null.
    async getAuth(userId) {
      const { rows } = await q('SELECT secret_hash, session_id FROM users WHERE id = $1', [userId]);
      return rows[0] || null;
    },

    // { sessionId } when userId + secret match, otherwise null.
    async verify(userId, secret) {
      const row = await this.getAuth(userId);
      if (!row || typeof secret !== 'string' || !safeEqual(row.secret_hash, hash(secret))) return null;
      return { sessionId: row.session_id };
    },

    // A device (session) took over this account. Returns the previous { sessionId, online }.
    async startSession(userId, sessionId) {
      const before = await q(
        'SELECT session_id, (online_at > now() - make_interval(secs => $2) AND NOT offline) AS online FROM users WHERE id = $1',
        [userId, ONLINE_WINDOW_S]
      );
      await q('UPDATE users SET session_id = $2, online_at = now(), offline = false, visible = true, last_seen = now() WHERE id = $1', [userId, sessionId]);
      const r = before.rows[0] || {};
      return { sessionId: r.session_id || null, online: Boolean(r.online) };
    },

    // Returns true if the user was already online before this beat (false = they just came back).
    async heartbeat(userId) {
      const before = await q('SELECT (online_at > now() - make_interval(secs => $2) AND NOT offline) AS online FROM users WHERE id = $1', [userId, ONLINE_WINDOW_S]);
      await q('UPDATE users SET online_at = now(), offline = false, last_seen = now() WHERE id = $1', [userId]);
      return Boolean(before.rows[0] && before.rows[0].online);
    },

    async markOffline(userId) {
      await q('UPDATE users SET offline = true, last_seen = now() WHERE id = $1', [userId]);
    },

    // { online, lastSeen (ms), visible } for any user, or null.
    async getPresence(userId) {
      const { rows } = await q(
        `SELECT (online_at > now() - make_interval(secs => $2) AND NOT offline) AS online, GREATEST(last_seen, online_at) AS seen, visible
         FROM users WHERE id = $1`,
        [userId, ONLINE_WINDOW_S]
      );
      if (!rows[0]) return null;
      return { online: Boolean(rows[0].online), lastSeen: rows[0].seen ? new Date(rows[0].seen).getTime() : null, visible: rows[0].visible };
    },

    // The app is on screen (true) or not (false). Coming back restarts the notification window.
    async setVisible(userId, visible) {
      await q('UPDATE users SET visible = $2::boolean, notified_at = CASE WHEN $2::boolean THEN NULL ELSE notified_at END WHERE id = $1', [userId, Boolean(visible)]);
    },

    async clearNotified(userId) {
      await q('UPDATE users SET notified_at = NULL WHERE id = $1', [userId]);
    },

    // Atomically claim the right to send ONE notification per window. true = you may send it now.
    async claimNotify(userId, windowMs) {
      const r = await q(
        `UPDATE users SET notified_at = now()
         WHERE id = $1 AND (notified_at IS NULL OR notified_at < now() - make_interval(secs => $2)) RETURNING 1`,
        [userId, windowMs / 1000]
      );
      return r.rowCount > 0;
    },

    // True when this user has not sent a heartbeat for `graceMs`.
    async isStale(userId, graceMs) {
      const { rows } = await q('SELECT (online_at IS NULL OR online_at < now() - make_interval(secs => $2)) AS stale FROM users WHERE id = $1', [
        userId,
        graceMs / 1000,
      ]);
      return rows[0] ? Boolean(rows[0].stale) : true;
    },

    // When this user was last connected (ms since epoch), or null.
    async getLastSeen(userId) {
      const { rows } = await q('SELECT last_seen FROM users WHERE id = $1', [userId]);
      return rows[0] ? new Date(rows[0].last_seen).getTime() : null;
    },

    async userExists(userId) {
      const { rows } = await q('SELECT 1 FROM users WHERE id = $1', [userId]);
      return rows.length > 0;
    },

    async getPartner(userId) {
      const { rows } = await q('SELECT partner_id FROM pairings WHERE user_id = $1', [userId]);
      return rows[0] ? rows[0].partner_id : null;
    },

    // Mutual 1-to-1 pairing. Returns { ok:true } or { ok:false, reason }.
    async pair(a, b) {
      if (a === b) return { ok: false, reason: 'self' };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const users = await client.query('SELECT id FROM users WHERE id IN ($1, $2)', [a, b]);
        if (users.rows.length < 2) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'not-found' };
        }
        const existing = await client.query(
          'SELECT user_id, partner_id FROM pairings WHERE user_id IN ($1, $2)',
          [a, b]
        );
        for (const row of existing.rows) {
          if (!((row.user_id === a && row.partner_id === b) || (row.user_id === b && row.partner_id === a))) {
            await client.query('ROLLBACK');
            return { ok: false, reason: row.user_id === a ? 'self-busy' : 'target-busy' };
          }
        }
        await client.query(
          'INSERT INTO pairings (user_id, partner_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
          [a, b]
        );
        await client.query(
          'INSERT INTO pairings (user_id, partner_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
          [b, a]
        );
        await client.query('COMMIT');
        return { ok: true };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e && e.code === '23505') return { ok: false, reason: 'target-busy' };
        throw e;
      } finally {
        client.release();
      }
    },

    // Removes the pairing (both directions) and queued data between the two. Returns former partner id.
    async unpair(userId) {
      const partner = await this.getPartner(userId);
      if (!partner) return null;
      await q('DELETE FROM pairings WHERE user_id IN ($1, $2)', [userId, partner]);
      const r = await q(
        'DELETE FROM pending_messages WHERE (to_id = $1 AND from_id = $2) OR (to_id = $2 AND from_id = $1) RETURNING payload',
        [userId, partner]
      );
      return { partner, removed: r.rows.map((x) => x.payload) };
    },

    // ---- offline message queue (deleted the moment it is delivered) ----
    async queueMessage(id, toId, fromId, payload) {
      await q(
        'INSERT INTO pending_messages (id, to_id, from_id, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
        [id, toId, fromId, JSON.stringify(payload)]
      );
    },

    // Unseen messages stay in the DB until the receiver confirms it SAW them (see deleteMessages).
    async peekMessages(toId, maxAgeMs) {
      const { rows } = await q('SELECT payload, created_at FROM pending_messages WHERE to_id = $1', [toId]);
      const cutoff = maxAgeMs ? Date.now() - maxAgeMs : 0;
      return rows
        .filter((r) => new Date(r.created_at).getTime() >= cutoff)
        .sort((x, y) => new Date(x.created_at) - new Date(y.created_at))
        .map((r) => r.payload);
    },

    async pendingIds(toId) {
      const { rows } = await q('SELECT id FROM pending_messages WHERE to_id = $1 ORDER BY created_at LIMIT 100', [toId]);
      return rows.map((r) => r.id);
    },

    // How many videos from `fromId` are still waiting (unseen) for `toId` in cloud storage.
    async countPendingVideos(fromId, toId) {
      const { rows } = await q('SELECT payload FROM pending_messages WHERE from_id = $1 AND to_id = $2', [fromId, toId]);
      return rows.filter((r) => r.payload && r.payload.media && r.payload.media.kind === 'video').length;
    },

    // "Delete for everyone": remove a still-undelivered message the sender wrote.
    async deleteOwnPending(fromId, toId, id) {
      const r = await q('DELETE FROM pending_messages WHERE id = $1 AND from_id = $2 AND to_id = $3 RETURNING payload', [id, fromId, toId]);
      return r.rows.map((x) => x.payload);
    },

    async deleteMessages(toId, ids) {
      const list = (ids || []).filter((x) => typeof x === 'string').slice(0, 200);
      if (!list.length) return 0;
      const marks = list.map((_, i) => `$${i + 2}`).join(', ');
      const r = await q(`DELETE FROM pending_messages WHERE to_id = $1 AND id IN (${marks}) RETURNING payload, from_id`, [toId, ...list]);
      return r.rows.map((x) => ({ ...x.payload, fromId: x.from_id }));
    },

    async purgeOldMessages(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs);
      const r = await q('DELETE FROM pending_messages WHERE created_at < $1 RETURNING payload', [cutoff]);
      return r.rows.map((x) => x.payload);
    },

    // ---- call logs (also the live call state: a call is active while ended_at IS NULL) ----
    async createCall(callerId, calleeId, video = true) {
      const { rows } = await q(
        "INSERT INTO call_logs (caller_id, callee_id, status, video) VALUES ($1, $2, 'ringing', $3) RETURNING id",
        [callerId, calleeId, video !== false]
      );
      return String(rows[0].id);
    },

    // The unfinished call this user takes part in, or null.
    async getActiveCall(userId) {
      const { rows } = await q(
        `SELECT id, caller_id, callee_id, video, status, started_at, answered_at FROM call_logs
         WHERE ended_at IS NULL AND status IN ('ringing', 'answered') AND (caller_id = $1 OR callee_id = $1)
         ORDER BY id DESC LIMIT 1`,
        [userId]
      );
      const r = rows[0];
      if (!r) return null;
      return {
        id: String(r.id),
        caller: r.caller_id,
        callee: r.callee_id,
        video: r.video,
        status: r.status,
        startedAt: new Date(r.started_at).getTime(),
        answeredAt: r.answered_at ? new Date(r.answered_at).getTime() : null,
      };
    },

    async markCallAnswered(id) {
      const r = await q("UPDATE call_logs SET status = 'answered', answered_at = now() WHERE id = $1 AND status = 'ringing' AND ended_at IS NULL RETURNING 1", [id]);
      return r.rowCount > 0;
    },

    // status: 'missed' | 'declined' | 'completed'. Returns the talk time in seconds, or null if the call was already finished
    // (so a call is ended exactly once, even when two requests race).
    async finishCall(id, status) {
      const r = await q(
        `UPDATE call_logs SET status = $2, ended_at = now(),
           duration_s = CASE WHEN answered_at IS NULL THEN 0 ELSE GREATEST(0, round(extract(epoch FROM (now() - answered_at)))::int) END
         WHERE id = $1 AND ended_at IS NULL RETURNING duration_s`,
        [id, status]
      );
      return r.rowCount ? r.rows[0].duration_s : null;
    },

    async recentCalls(userId, limit = 20) {
      const { rows } = await q(
        'SELECT id, caller_id, callee_id, status, started_at, duration_s FROM call_logs WHERE caller_id = $1 OR callee_id = $1 ORDER BY id DESC LIMIT $2',
        [userId, limit]
      );
      return rows;
    },

    // ---- web push ----
    async savePushSubscription(userId, sub) {
      await q(
        `INSERT INTO push_subscriptions (endpoint, user_id, keys) VALUES ($1, $2, $3)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys`,
        [sub.endpoint, userId, JSON.stringify(sub.keys || {})]
      );
    },

    async getPushSubscriptions(userId) {
      const { rows } = await q('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = $1', [userId]);
      return rows.map((r) => ({ endpoint: r.endpoint, keys: r.keys }));
    },

    async deletePushSubscription(endpoint) {
      await q('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createDb, SCHEMA, ONLINE_WINDOW_S };
