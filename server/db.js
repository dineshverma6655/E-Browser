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
  return new Pool({
    connectionString: url,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
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

    // ---- call logs ----
    async createCall(callerId, calleeId) {
      const { rows } = await q(
        "INSERT INTO call_logs (caller_id, callee_id, status) VALUES ($1, $2, 'ringing') RETURNING id",
        [callerId, calleeId]
      );
      return rows[0].id;
    },

    async markCallAnswered(id) {
      await q("UPDATE call_logs SET status = 'answered', answered_at = $2 WHERE id = $1", [id, new Date()]);
    },

    // status: 'missed' | 'declined' | 'completed'
    async finishCall(id, status, durationS = 0) {
      await q(
        'UPDATE call_logs SET status = $2, ended_at = $3, duration_s = $4 WHERE id = $1',
        [id, status, new Date(), Math.max(0, Math.round(durationS))]
      );
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

module.exports = { createDb, SCHEMA };
