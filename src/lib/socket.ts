// Realtime client for a serverless backend (Vercel).
//
// There is no long-lived server any more, so this object imitates the small part of the socket.io client API the app
// uses (on / off / emit / timeout().emit / connect / disconnect / connected):
//   - emit()  -> one HTTP request to /api/rt (the answer carries the events the old server would have sent back)
//   - events from the OTHER person arrive through Pusher Channels (a private channel only this device may join)
//   - a heartbeat keeps the user "online" and lets a device catch up on anything it missed (calls, messages, partner status)
// If the Pusher keys are not configured it still works, only slower: the heartbeat then runs every few seconds.
import Pusher from 'pusher-js';

type Handler = (...args: any[]) => void;
type Reply = { ack?: any; events?: Array<[string, any]>; more?: boolean } | null;

const PUSHER_KEY = process.env.NEXT_PUBLIC_PUSHER_KEY || '';
const PUSHER_CLUSTER = process.env.NEXT_PUBLIC_PUSHER_CLUSTER || '';
const HEARTBEAT_MS = PUSHER_KEY ? 20_000 : 5_000;
const CALL_HEARTBEAT_MS = 4_000; // ringing / in a call: notice a missed or ended call quickly
const NO_RETRY = new Set(['start-call', 'pair-with-partner']); // not safe to repeat blindly
const CALL_START = ['incoming-call', 'call-accepted'];
const CALL_END = ['call-ended', 'call-missed', 'call-declined'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trim = (s: Set<string>, max = 600) => {
  if (s.size > max) Array.from(s).slice(0, s.size - max).forEach((x) => s.delete(x));
};

class RtSocket {
  connected = false;
  private listeners = new Map<string, Set<Handler>>();
  private creds: { userId: string; secret: string } | null = null;
  private sessionId = `s-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  private pusher: Pusher | null = null;
  private channelName: string | null = null;
  private registered = false;
  private hbTimer: ReturnType<typeof setTimeout> | null = null;
  private hbFailures = 0;
  private callMode = false;
  private callGuard = 0; // until then, "no call on the server" may just mean the start-call request is still in flight
  private partnerId: string | null = null;
  private partnerOnline: boolean | null = null;
  private lastCallId: string | null = null;
  private delivered = new Set<string>(); // chat message ids already handed to the app
  private seenCall = new Set<string>(); // call events already handed to the app (Pusher and the heartbeat can both report one)

  constructor() {
    if (typeof window === 'undefined') return;
    // The page is going away: tell the server right now so the partner sees "offline" at once (best effort).
    window.addEventListener('pagehide', () => {
      if (!this.registered || !this.creds) return;
      try {
        navigator.sendBeacon('/api/rt', this.body('bye', {}));
      } catch {
        /* ignore */
      }
    });
    // Back in front (or network back): catch up immediately instead of waiting for the next heartbeat.
    const wake = () => {
      if (document.visibilityState === 'visible') this.kick();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('online', wake);
  }

  // ---- socket.io style API ----
  on(event: string, fn: Handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }

  off(event: string, fn?: Handler) {
    if (!fn) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(fn);
    return this;
  }

  emit(event: string, ...args: any[]) {
    const ack = typeof args[args.length - 1] === 'function' ? (args.pop() as Handler) : undefined;
    if (event === 'start-call') {
      this.callGuard = Date.now() + 8000;
      this.setCallMode(true); // watch the call closely: a missed call must show up within seconds
    }
    this.run(event, args[0]).then((res) => ack && ack(res ? res.ack : undefined));
    return this;
  }

  timeout(ms: number) {
    return {
      emit: (event: string, payload: any, cb: (err: Error | null, res?: any) => void) => {
        let done = false;
        const t = setTimeout(() => {
          if (!done) {
            done = true;
            cb(new Error('timeout'));
          }
        }, ms);
        this.run(event, payload).then((res) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          if (res) cb(null, res.ack);
          else cb(new Error('network'));
        });
      },
    };
  }

  connect() {
    if (!PUSHER_KEY) {
      // No Pusher: "connected" simply means the page can reach the server.
      setTimeout(() => this.setConnected(true), 0);
      return this;
    }
    if (!this.pusher) {
      this.pusher = new Pusher(PUSHER_KEY, {
        cluster: PUSHER_CLUSTER,
        channelAuthorization: {
          endpoint: '/api/rt/auth',
          transport: 'ajax',
          headersProvider: () => ({ 'x-uid': this.creds?.userId || '', 'x-secret': this.creds?.secret || '' }),
        },
      });
      this.pusher.connection.bind('state_change', ({ current }: { current: string }) => {
        if (current === 'connected') this.setConnected(true);
        else if (this.connected) this.setConnected(false);
      });
    } else {
      this.pusher.connect();
    }
    if (this.pusher.connection.state === 'connected') setTimeout(() => this.setConnected(true), 0);
    return this;
  }

  disconnect() {
    this.stopHeartbeat();
    this.registered = false;
    this.pusher?.disconnect();
    this.setConnected(false);
    return this;
  }

  // ---- internals ----
  private setConnected(v: boolean) {
    if (this.connected === v) return;
    this.connected = v;
    if (!v) {
      this.registered = false;
      this.stopHeartbeat();
    }
    this.dispatch(v ? 'connect' : 'disconnect');
  }

  private body(event: string, payload: any) {
    const c = this.creds!;
    return JSON.stringify({ userId: c.userId, secret: c.secret, sessionId: this.sessionId, event, payload });
  }

  private async request(event: string, payload: any): Promise<Reply> {
    if (event === 'register-user' && payload) this.creds = { userId: payload.userId, secret: payload.secret };
    if (!this.creds) return null;
    const body = this.body(event, payload);
    const tries = NO_RETRY.has(event) ? 1 : 3;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch('/api/rt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: body.length < 60_000,
          cache: 'no-store',
        });
        if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as Reply;
      } catch {
        if (i < tries - 1) await sleep(700 * (i + 1));
      }
    }
    return null;
  }

  // Send one action, hand back the events the server answered with, and keep going while it has more to deliver.
  private async run(event: string, payload: any): Promise<Reply> {
    const res = await this.request(event, payload);
    if (!res) return null;
    const ids: string[] = [];
    for (const [name, data] of res.events || []) {
      if (name === 'chat-message' && data && typeof data.id === 'string') ids.push(data.id);
      this.dispatch(name, data);
    }
    if (res.more) {
      const skip = [...(payload && Array.isArray(payload.skip) ? payload.skip : []), ...ids];
      this.run('sync-pending', { skip });
    }
    return res;
  }

  private dispatch(event: string, data?: any) {
    if (event === 'replaced' && data && data.sessionId && data.sessionId !== this.sessionId) return; // meant for an older tab

    if (event === 'chat-message' && data && typeof data.id === 'string') {
      this.delivered.add(data.id);
      trim(this.delivered);
    }
    if (CALL_START.includes(event) || CALL_END.includes(event)) {
      const id = data && data.id;
      if (id) {
        // Every call event is handed over once, whichever path (Pusher / reply / heartbeat) reported it first.
        const key = CALL_END.includes(event) ? `end:${id}` : `${event}:${id}`;
        if (this.seenCall.has(key)) return;
        this.seenCall.add(key);
        trim(this.seenCall);
        if (CALL_END.includes(event)) this.lastCallId = null;
        else this.lastCallId = id;
      }
      this.setCallMode(CALL_START.includes(event));
    }
    if (event === 'registered' && data) {
      this.partnerId = data.partnerId || null;
      this.partnerOnline = Boolean(data.isPartnerOnline);
      this.registered = true;
      this.hbFailures = 0;
      this.subscribe();
      this.scheduleHeartbeat();
    }
    if (event === 'partner-status' && data) this.partnerOnline = Boolean(data.online);
    if (event === 'pair-success' && data) {
      this.partnerId = data.partnerId || null;
      this.partnerOnline = Boolean(data.isPartnerOnline);
    }
    if (event === 'unpaired') {
      this.partnerId = null;
      this.partnerOnline = null;
    }
    if (event === 'replaced') {
      this.stopHeartbeat();
      this.registered = false;
    }

    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(data);
      } catch (e) {
        console.error(`handler for "${event}" failed`, e);
      }
    }
  }

  // Listen for events sent by the partner (new message, incoming call, ...).
  private subscribe() {
    if (!this.pusher || !this.creds) return;
    const name = `private-u-${this.creds.userId}`;
    if (this.channelName === name) return;
    this.channelName = name;
    const channel = this.pusher.subscribe(name);
    channel.bind_global((event: string, data: any) => {
      if (event.startsWith('pusher')) return;
      if (event === 'poke') this.run('sync-pending', {}); // the message was too big for Pusher: fetch it over HTTP
      else this.dispatch(event, data);
    });
  }

  private setCallMode(v: boolean) {
    if (this.callMode === v) return;
    this.callMode = v;
    this.scheduleHeartbeat();
  }

  private stopHeartbeat() {
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.hbTimer = null;
  }

  private scheduleHeartbeat() {
    this.stopHeartbeat();
    if (!this.registered) return;
    this.hbTimer = setTimeout(async () => {
      await this.beat();
      this.scheduleHeartbeat();
    }, this.callMode ? CALL_HEARTBEAT_MS : HEARTBEAT_MS);
  }

  private kick() {
    if (!this.registered) return;
    this.stopHeartbeat();
    this.beat().then(() => this.scheduleHeartbeat());
  }

  private async beat() {
    const res = await this.request('heartbeat', {});
    if (!res) {
      // Without Pusher this is also how a lost connection is noticed.
      if (!PUSHER_KEY && ++this.hbFailures >= 3) this.setConnected(false);
      return;
    }
    this.hbFailures = 0;
    if (!PUSHER_KEY && !this.connected) {
      this.setConnected(true);
      return;
    }
    for (const [name, data] of res.events || []) this.dispatch(name, data);
    if (res.ack) this.applyState(res.ack);
  }

  // Compare the server's truth with what this device knows, and raise whatever was missed.
  private applyState(st: any) {
    const me = this.creds?.userId;
    if (!me) return;

    if (this.partnerId && !st.partnerId) {
      this.dispatch('unpaired', { message: 'Your partner has unpaired.' });
    } else if (!this.partnerId && st.partnerId) {
      this.dispatch('pair-success', { partnerId: st.partnerId, isPartnerOnline: Boolean(st.partner && st.partner.online) });
    } else if (st.partner && this.partnerOnline !== null && st.partner.online !== this.partnerOnline) {
      this.dispatch('partner-status', { partnerId: st.partnerId, online: st.partner.online, lastSeen: st.partner.lastSeen });
    }

    const call = st.call;
    if (call) {
      if (call.status === 'ringing' && call.callee === me) this.dispatch('incoming-call', { callerId: call.caller, video: call.video, id: call.id });
      if (call.status === 'answered' && call.caller === me) this.dispatch('call-accepted', { id: call.id });
      this.lastCallId = call.id;
      this.setCallMode(true);
    } else if (this.lastCallId) {
      this.dispatch('call-ended', { id: this.lastCallId });
    } else if (Date.now() > this.callGuard) {
      this.setCallMode(false);
    }

    // Messages waiting on the server that never reached this device (a realtime event was lost)
    const missing: string[] = (st.pending || []).filter((id: string) => !this.delivered.has(id));
    if (missing.length) {
      this.run('sync-pending', {}).then((r) => {
        if (r) missing.forEach((id) => this.delivered.add(id));
      });
    }
  }
}

let socket: RtSocket | null = null;

export const getSocket = (): RtSocket => {
  if (!socket) socket = new RtSocket();
  return socket;
};
