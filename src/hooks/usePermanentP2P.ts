'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { DataConnection, MediaConnection } from 'peerjs';
import { getSocket } from '@/lib/socket';
import { backendUrl, peerEndpoint } from '@/lib/backend';
import { ChatMessage, PeerMediaStatus, CallLogEntry, ReplyRef } from '@/types';

type CallState = 'idle' | 'calling' | 'incoming' | 'connected';
type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
const MAX_UNSEEN_VIDEOS = 6;
const P2P_MAX_BYTES = 150 * 1024 * 1024; // bigger files always go through cloud storage (P2P is fragile at that size)
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const VIDEO_CHUNK = 256 * 1024;

function uploadWithProgress(url: string, file: Blob, onProgress: (p: number) => void, mime?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', mime || file.type || 'video/mp4');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('upload ' + xhr.status)));
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(file);
  });
}

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// A black placeholder video track. Voice calls (and calls where the camera is unavailable) still negotiate a video
// sender with it, so the camera can be switched on mid-call by replacing this track.
function createBlankVideoTrack(): MediaStreamTrack | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const stream = (canvas as any).captureStream?.(1) as MediaStream | undefined;
    return stream?.getVideoTracks()[0] || null;
  } catch {
    return null;
  }
}

function cameraErrorMessage(e: any): string {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission is blocked. Allow the camera for this site (lock icon in the address bar), then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is being used by another app or browser tab. Close it there and try again.';
    default:
      return 'Could not turn the camera on. Please try again.';
  }
}

function buildReply(m: ChatMessage): ReplyRef {
  return {
    id: m.id,
    text: m.text ? m.text.slice(0, 120) : undefined,
    kind: m.videoUrl || m.mediaKind === 'video' ? 'video' : m.imageUrl || m.mediaKind === 'image' ? 'photo' : 'text',
    mine: m.sender === 'me',
  };
}

// A reply arrives from the sender's point of view; for the receiver "mine" is the opposite.
const flipReply = (r: any): ReplyRef | undefined => (r && r.id ? { id: r.id, text: r.text, kind: r.kind, mine: !r.mine } : undefined);

function randomString(len: number, alphabet: string) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function createIdentity() {
  const id = `P2P-${randomString(6, ID_ALPHABET)}`;
  const secret = randomString(40, 'abcdefghijklmnopqrstuvwxyz0123456789');
  localStorage.setItem('p2p_my_permanent_id', id);
  localStorage.setItem('p2p_my_secret', secret);
  localStorage.removeItem('p2p_my_partner_id');
  return { id, secret };
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function usePermanentP2P() {
  const [myId, setMyId] = useState<string>('');
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [isPartnerOnline, setIsPartnerOnline] = useState<boolean>(false);
  const [isReady, setIsReady] = useState<boolean>(false);
  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [callHistory, setCallHistory] = useState<CallLogEntry[]>([]);
  const [notificationState, setNotificationState] = useState<NotificationState>('unsupported');

  const [callState, setCallState] = useState<CallState>('idle');
  const [callDuration, setCallDuration] = useState<number>(0);
  const [isVideoCall, setIsVideoCall] = useState<boolean>(true);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [partnerMediaStatus, setPartnerMediaStatus] = useState<PeerMediaStatus>({ audio: true, video: true });

  // Ephemeral in-memory chat (never written to disk). Only undelivered messages wait in DB (max 24h) until delivered.
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const replyTargetRef = useRef<ChatMessage | null>(null);
  replyTargetRef.current = replyTarget;
  const secretRef = useRef<string>('');
  const peerRef = useRef<any>(null);
  const peerOpenRef = useRef(false);
  const iceRef = useRef<RTCIceServer[]>(DEFAULT_ICE);
  const vapidRef = useRef<string | null>(null);
  const dataConnRef = useRef<DataConnection | null>(null);
  const activeMediaCallRef = useRef<MediaConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const partnerRef = useRef<string | null>(null);
  const partnerOnlineRef = useRef(false);
  const callStateRef = useRef<CallState>('idle');
  const callAcceptedRef = useRef(false);
  const callVideoRef = useRef(true);
  const hasRealVideoRef = useRef(false); // true when the local video track is a real camera (not the black placeholder)
  const incomingVideosRef = useRef<Record<string, { parts: Blob[]; buf: ArrayBuffer[]; got: number; total: number; mime: string }>>({});
  const downloadingRef = useRef<Set<string>>(new Set());
  const knownIdsRef = useRef<Set<string>>(new Set()); // message ids already on screen (avoids duplicates P2P + cloud)
  const unseenRef = useRef<Set<string>>(new Set()); // partner messages on screen but not yet confirmed as seen
  const seenIdsRef = useRef<Set<string>>(new Set()); // my messages the partner has seen
  const isFrontRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateCallState = useCallback((s: CallState) => {
    callStateRef.current = s;
    setCallState(s);
  }, []);

  const updatePartner = useCallback((id: string | null) => {
    partnerRef.current = id;
    setPartnerId(id);
    if (id) localStorage.setItem('p2p_my_partner_id', id);
    else localStorage.removeItem('p2p_my_partner_id');
  }, []);

  const updatePartnerOnline = useCallback((online: boolean) => {
    partnerOnlineRef.current = online;
    setIsPartnerOnline(online);
  }, []);

  // 1. Permanent identity (ID + secret) lives in this device's storage
  useEffect(() => {
    let id = localStorage.getItem('p2p_my_permanent_id');
    let secret = localStorage.getItem('p2p_my_secret');
    if (!id || !secret) {
      ({ id, secret } = createIdentity());
    }
    secretRef.current = secret;
    setMyId(id);
    const storedPartner = localStorage.getItem('p2p_my_partner_id');
    partnerRef.current = storedPartner;
    setPartnerId(storedPartner);
    setIsReady(true);
  }, []);

  const appendMessage = useCallback((msg: ChatMessage) => {
    knownIdsRef.current.add(msg.id);
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);

  // Closing the chat wipes every message/photo/video from memory. The pairing & connection stay untouched.
  const clearChat = useCallback(() => {
    setReplyTarget(null);
    setMessages((prev) => {
      prev.forEach((m) => {
        if (m.videoUrl && m.videoUrl.startsWith('blob:')) URL.revokeObjectURL(m.videoUrl);
        if (m.imageUrl && m.imageUrl.startsWith('blob:')) URL.revokeObjectURL(m.imageUrl);
      });
      knownIdsRef.current.clear();
      return [];
    });
  }, []);

  const updateMsg = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const removeMsg = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const addSystemMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: 'sys-' + Date.now() + Math.random().toString(36).slice(2, 6), sender: 'system', text, timestamp: Date.now() },
    ]);
  }, []);

  const stopLocalStream = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
  }, []);

  const sendToPartner = useCallback((dataMsg: any, socketEvent: string, socketPayload: any) => {
    const conn = dataConnRef.current;
    if (conn && conn.open) {
      try {
        conn.send(dataMsg);
        return;
      } catch (e) {
        console.warn('P2P send failed, using relay:', e);
      }
    }
    getSocket().emit(socketEvent, socketPayload);
  }, []);

  const markSeen = useCallback((ids: string[]) => {
    ids.forEach((id) => seenIdsRef.current.add(id));
    setMessages((prev) => prev.map((m) => (ids.includes(m.id) ? { ...m, status: 'seen' } : m)));
  }, []);

  // Tell the server (→ deletes from DB) and the sender that these messages were actually seen. Only while the app is visible.
  const flushSeen = useCallback(() => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    if (unseenRef.current.size === 0) return;
    const ids = Array.from(unseenRef.current);
    unseenRef.current.clear();
    getSocket().emit('messages-seen', { ids });
    // Call records are shown once: they disappear a few seconds after they have been seen.
    ids.filter((id) => id.startsWith('call-') || id.startsWith('seen-')).forEach((id) => setTimeout(() => removeMsg(id), 10000));
    const conn = dataConnRef.current;
    if (conn && conn.open) {
      try {
        conn.send({ type: 'ack', ids });
      } catch {
        /* server relay already told the sender */
      }
    }
  }, [removeMsg]);

  const noteUnseen = useCallback(
    (id: string) => {
      unseenRef.current.add(id);
      flushSeen();
    },
    [flushSeen]
  );

  // A deleted message stays as a small "This message was deleted" line; its content and any local files are dropped.
  const tombstone = useCallback((id: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        if (m.videoUrl && m.videoUrl.startsWith('blob:')) URL.revokeObjectURL(m.videoUrl);
        if (m.imageUrl && m.imageUrl.startsWith('blob:')) URL.revokeObjectURL(m.imageUrl);
        return { id: m.id, sender: m.sender, timestamp: m.timestamp, deleted: true };
      })
    );
  }, []);

  // The reply being composed is attached to the next message that is sent, then cleared.
  const takeReply = useCallback((): ReplyRef | undefined => {
    const target = replyTargetRef.current;
    if (!target) return undefined;
    setReplyTarget(null);
    return buildReply(target);
  }, []);

  const reactToMessage = useCallback((msgId: string, emoji: string) => {
    const current = messagesRef.current.find((m) => m.id === msgId)?.reactions?.me;
    const next = current === emoji ? null : emoji; // tapping the same emoji again removes it
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, reactions: { ...m.reactions, me: next || undefined } } : m)));
    getSocket().emit('reaction', { msgId, emoji: next });
  }, []);

  const deleteForMe = useCallback((id: string) => {
    setMessages((prev) => {
      const m = prev.find((x) => x.id === id);
      if (m?.videoUrl && m.videoUrl.startsWith('blob:')) URL.revokeObjectURL(m.videoUrl);
      if (m?.imageUrl && m.imageUrl.startsWith('blob:')) URL.revokeObjectURL(m.imageUrl);
      return prev.filter((x) => x.id !== id);
    });
    setReplyTarget((t) => (t && t.id === id ? null : t));
  }, []);

  const deleteForEveryone = useCallback(
    (id: string) => {
      const m = messagesRef.current.find((x) => x.id === id);
      if (!m || m.sender !== 'me') return;
      tombstone(id);
      setReplyTarget((t) => (t && t.id === id ? null : t));
      getSocket().emit('delete-message', { id });
    },
    [tombstone]
  );

  // Text/photo: fast P2P path, but if no "seen" arrives within 4s the server stores it until the partner sees it.
  const sendChat = useCallback((dataMsg: any, message: ChatMessage) => {
    const conn = dataConnRef.current;
    let viaP2P = false;
    if (conn && conn.open) {
      try {
        conn.send(dataMsg);
        viaP2P = true;
      } catch (e) {
        console.warn('P2P send failed, using relay:', e);
      }
    }
    const relay = () => getSocket().emit('chat-message', { message });
    if (!viaP2P) relay();
    else setTimeout(() => !seenIdsRef.current.has(message.id) && relay(), 4000);
  }, []);

  // Partner was offline: the video waits in cloud storage. Download it, keep it locally, then confirm "seen" (which deletes it from the cloud).
  const downloadCloudMedia = useCallback(
    async (msg: any, attempt = 0) => {
      if (attempt === 0) {
        if (downloadingRef.current.has(msg.id)) return;
        if (knownIdsRef.current.has(msg.id)) {
          // Already arrived peer-to-peer; just confirm so the cloud copy is deleted.
          noteUnseen(msg.id);
          return;
        }
        downloadingRef.current.add(msg.id);
        appendMessage({ id: msg.id, sender: 'peer', timestamp: msg.timestamp || Date.now(), transfer: 'receiving', mediaKind: msg.media.kind, progress: 0, replyTo: flipReply(msg.replyTo) });
      }
      try {
        const res = await fetch(msg.media.url);
        if (!res.ok || !res.body) throw new Error('http ' + res.status);
        const total = Number(res.headers.get('content-length')) || msg.media.size || 1;
        const reader = res.body.getReader();
        const parts: Blob[] = [];
        let received = 0;
        let lastUpdate = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(new Blob([value]));
          received += value.length;
          if (Date.now() - lastUpdate > 150) {
            lastUpdate = Date.now();
            updateMsg(msg.id, { progress: received / total });
          }
        }
        const url = URL.createObjectURL(new Blob(parts, { type: msg.media.mime || (msg.media.kind === 'image' ? 'image/jpeg' : 'video/mp4') }));
        updateMsg(
          msg.id,
          msg.media.kind === 'image'
            ? { imageUrl: url, transfer: undefined, progress: undefined, mediaKind: undefined }
            : { videoUrl: url, transfer: undefined, progress: undefined, mediaKind: undefined }
        );
        downloadingRef.current.delete(msg.id);
        noteUnseen(msg.id);
      } catch (e) {
        console.warn('video download failed', e);
        if (attempt < 2) {
          setTimeout(() => downloadCloudMedia(msg, attempt + 1), 4000);
        } else {
          downloadingRef.current.delete(msg.id);
          removeMsg(msg.id); // it will be offered again on the next reconnect
          setNotice('A file could not be downloaded. It will retry when you reconnect.');
        }
      }
    },
    [appendMessage, updateMsg, removeMsg, noteUnseen]
  );

  const initLocalStream = useCallback(async (facing: boolean = true, wantVideo: boolean = true) => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    if (!wantVideo) {
      try {
        const a = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const blank = createBlankVideoTrack();
        if (blank) a.addTrack(blank);
        hasRealVideoRef.current = false;
        localStreamRef.current = a;
        setLocalStream(a);
        setIsVideoMuted(true);
        setIsAudioMuted(false);
        return a;
      } catch {
        setNotice('Microphone access was denied. Allow it in your browser settings.');
        return null;
      }
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { facingMode: facing ? 'user' : 'environment', width: { ideal: 720 }, height: { ideal: 1280 } },
      });
      hasRealVideoRef.current = true;
      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsVideoMuted(false);
      setIsAudioMuted(false);
      return stream;
    } catch (err) {
      console.warn('Camera unavailable, trying audio only:', err);
      const camReason = cameraErrorMessage(err);
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const blank = createBlankVideoTrack();
        if (blank) audioStream.addTrack(blank);
        hasRealVideoRef.current = false;
        localStreamRef.current = audioStream;
        setLocalStream(audioStream);
        setIsVideoMuted(true);
        setIsAudioMuted(false);
        setNotice(camReason + ' Continuing with audio only.');
        return audioStream;
      } catch (audioErr) {
        console.error('Mic also failed:', audioErr);
        setNotice('Camera and microphone access was denied. Allow them in your browser settings.');
        return null;
      }
    }
  }, []);

  const resetCall = useCallback(() => {
    callAcceptedRef.current = false;
    hasRealVideoRef.current = false;
    if (activeMediaCallRef.current) {
      const c = activeMediaCallRef.current;
      activeMediaCallRef.current = null;
      c.close();
    }
    stopLocalStream();
    setRemoteStream(null);
    setPartnerMediaStatus({ audio: true, video: true });
    updateCallState('idle');
  }, [stopLocalStream, updateCallState]);

  const attachMediaCall = useCallback(
    (call: MediaConnection) => {
      activeMediaCallRef.current = call;
      call.on('stream', (s: MediaStream) => {
        setRemoteStream(s);
        updateCallState('connected');
        // Voice call: the partner's video is just a placeholder until they switch their camera on.
        if (!callVideoRef.current) setPartnerMediaStatus((p) => ({ ...p, video: false }));

        // Watchdog: if the media link itself dies (partner hung up without a signal, network gone) end the call here too.
        const pc = call.peerConnection;
        if (pc) {
          let dropTimer: ReturnType<typeof setTimeout> | null = null;
          const endBecauseDead = () => {
            if (activeMediaCallRef.current === call && callStateRef.current !== 'idle') {
              getSocket().emit('end-call');
              resetCall();
            }
          };
          pc.addEventListener('iceconnectionstatechange', () => {
            const st = pc.iceConnectionState;
            if (dropTimer) clearTimeout(dropTimer);
            if (st === 'failed' || st === 'closed') endBecauseDead();
            else if (st === 'disconnected') {
              dropTimer = setTimeout(() => {
                if (pc.iceConnectionState === 'disconnected') endBecauseDead();
              }, 20000);
            }
          });
        }
      });
      call.on('close', () => {
        if (activeMediaCallRef.current === call) {
          activeMediaCallRef.current = null;
          if (callStateRef.current === 'connected') {
            resetCall();
          }
        }
      });
      call.on('error', (e) => console.warn('Media call error:', e));
    },
    [resetCall, updateCallState]
  );

  const setupDataConnection = useCallback(
    (conn: DataConnection) => {
      if (partnerRef.current && conn.peer !== partnerRef.current) {
        conn.close();
        return;
      }
      dataConnRef.current = conn;

      conn.on('data', (data: any) => {
        if (!data) return;
        if (data.type === 'chat') {
          const id = data.id || String(Date.now());
          appendMessage({
            id,
            sender: 'peer',
            text: data.text,
            imageUrl: data.imageUrl,
            replyTo: flipReply(data.replyTo),
            timestamp: data.timestamp || Date.now(),
          });
          noteUnseen(id);
        } else if (data.type === 'vid-start') {
          incomingVideosRef.current[data.id] = { parts: [], buf: [], got: 0, total: data.total, mime: data.mime || 'video/mp4' };
          appendMessage({ id: data.id, sender: 'peer', timestamp: data.timestamp || Date.now(), transfer: 'receiving', progress: 0, replyTo: flipReply(data.replyTo) });
        } else if (data.type === 'vid-chunk') {
          const v = incomingVideosRef.current[data.id];
          if (!v) return;
          v.buf.push(data.data);
          v.got++;
          if (v.buf.length >= 16) {
            v.parts.push(new Blob(v.buf)); // move chunks out of JS memory into Blob storage
            v.buf = [];
          }
          if (v.got % 8 === 0) updateMsg(data.id, { progress: v.got / v.total });
        } else if (data.type === 'vid-end') {
          const v = incomingVideosRef.current[data.id];
          if (!v) return;
          delete incomingVideosRef.current[data.id];
          if (v.got !== v.total) {
            removeMsg(data.id);
            setNotice('A video transfer was interrupted.');
            return;
          }
          if (v.buf.length) v.parts.push(new Blob(v.buf));
          updateMsg(data.id, { videoUrl: URL.createObjectURL(new Blob(v.parts, { type: v.mime })), transfer: undefined, progress: undefined });
          noteUnseen(data.id);
        } else if (data.type === 'hangup') {
          // Instant, server-independent hang-up from the partner
          if (callStateRef.current !== 'idle') {
            getSocket().emit('end-call');
            resetCall();
          }
        } else if (data.type === 'ack') {
          if (Array.isArray(data.ids)) markSeen(data.ids);
        } else if (data.type === 'media-saved') {
          addSystemMessage(`📥 Your partner saved your ${data.kind === 'video' ? 'video' : 'photo'}`);
        } else if (data.type === 'screenshot-attempt') {
          addSystemMessage('📸 Your partner attempted a screenshot');
        } else if (data.type === 'media-toggle') {
          setPartnerMediaStatus(data.mediaStatus);
        }
      });

      conn.on('close', () => {
        if (dataConnRef.current === conn) dataConnRef.current = null;
        // A half-received video can never complete: drop it so the sender's cloud fallback can deliver it
        Object.keys(incomingVideosRef.current).forEach((id) => removeMsg(id));
        incomingVideosRef.current = {};
        // Partner still online → quietly re-establish the direct channel
        if (partnerOnlineRef.current) {
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => connectToPartner(), 2000);
        }
      });
      conn.on('error', (e) => console.warn('Data connection error:', e));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appendMessage, addSystemMessage, noteUnseen, markSeen, updateMsg, removeMsg, resetCall]
  );

  // Open the direct P2P data channel. Smaller ID dials first; the other side dials after a short grace period.
  const connectToPartner = useCallback(() => {
    const peer = peerRef.current;
    const target = partnerRef.current;
    if (!peer || !peerOpenRef.current || !target || !partnerOnlineRef.current) return;
    if (dataConnRef.current?.open) return;

    const dial = () => {
      if (dataConnRef.current?.open || !partnerOnlineRef.current || partnerRef.current !== target) return;
      try {
        setupDataConnection(peer.connect(target, { reliable: true }));
      } catch (e) {
        console.warn('connect failed', e);
      }
    };
    const iAmInitiator = (peer.id as string) < target;
    if (iAmInitiator) dial();
    else setTimeout(dial, 2500);
  }, [setupDataConnection]);

  const initPeerJS = useCallback(
    async (currentMyId: string) => {
      if (peerRef.current) return peerRef.current;
      try {
        const { default: Peer } = await import('peerjs');
        const ep = peerEndpoint();

        const peer = new Peer(currentMyId, {
          host: ep.host,
          port: ep.port,
          path: '/peerjs',
          secure: ep.secure,
          config: { iceServers: iceRef.current },
        });
        peerRef.current = peer;

        peer.on('open', () => {
          peerOpenRef.current = true;
          connectToPartner();
        });
        peer.on('connection', (conn) => setupDataConnection(conn));

        // Caller dials only AFTER the callee accepted, so the callee always has its camera ready.
        peer.on('call', async (incoming) => {
          if (incoming.peer !== partnerRef.current || !callAcceptedRef.current || callStateRef.current === 'idle') {
            incoming.close();
            return;
          }
          const stream = localStreamRef.current || (await initLocalStream(isFrontRef.current, callVideoRef.current));
          incoming.answer(stream || undefined);
          attachMediaCall(incoming);
        });

        peer.on('disconnected', () => {
          peerOpenRef.current = false;
          if (!peer.destroyed) peer.reconnect();
        });
        peer.on('error', (err: any) => {
          if (err?.type === 'unavailable-id') {
            // Old tab/session still holds this peer ID on the server — retry shortly.
            peerRef.current = null;
            peer.destroy();
            setTimeout(() => initPeerJS(currentMyId), 3000);
          } else if (err?.type !== 'peer-unavailable') {
            console.warn('PeerJS notice:', err);
          }
        });
        return peer;
      } catch (e) {
        console.error('PeerJS init failed:', e);
        return null;
      }
    },
    [attachMediaCall, connectToPartner, initLocalStream, setupDataConnection]
  );

  const subscribePush = useCallback(async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !vapidRef.current) return;
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidRef.current),
        });
      }
      getSocket().emit('push-subscribe', { subscription: sub.toJSON() });
    } catch (e) {
      console.warn('Push subscribe failed:', e);
    }
  }, []);

  const enableNotifications = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    const perm = await Notification.requestPermission();
    setNotificationState(perm as NotificationState);
    if (perm === 'granted') subscribePush();
  }, [subscribePush]);

  // 2. Socket + PeerJS lifecycle
  useEffect(() => {
    if (!isReady || !myId) return;
    let cancelled = false;
    const socket = getSocket();

    if (typeof Notification !== 'undefined' && 'serviceWorker' in navigator) {
      setNotificationState(Notification.permission as NotificationState);
    }

    const onConnect = () => {
      setSocketConnected(true);
      socket.emit('register-user', { userId: myId, secret: secretRef.current });
    };
    const onDisconnect = () => {
      setSocketConnected(false);
      updatePartnerOnline(false);
    };

    // Tell the server whether the app is on screen: no notification is sent while it is, one is sent when it is not.
    const reportVisibility = () => {
      if (socket.connected) socket.emit('visibility', { visible: document.visibilityState === 'visible' });
    };

    const onRegistered = ({ partnerId: serverPartner, isPartnerOnline: online, inCall }: any) => {
      reportVisibility();
      // The call may have ended while we were disconnected (we missed the 'call-ended' signal): drop the stale call screen.
      if (!inCall && callStateRef.current !== 'idle') resetCall();
      // Server (Postgres) is the source of truth: if partner unpaired while we were away, this clears it.
      updatePartner(serverPartner || null);
      updatePartnerOnline(Boolean(online));
      if (online) connectToPartner();
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') subscribePush();
    };

    const onRegisterError = ({ code }: any) => {
      if (code === 'id-taken') {
        // Extremely rare ID collision → mint a fresh identity.
        const { id, secret } = createIdentity();
        secretRef.current = secret;
        partnerRef.current = null;
        setPartnerId(null);
        setMyId(id);
      } else {
        setNotice('Could not reach the server. Please try again shortly.');
      }
    };

    const onPartnerStatus = ({ online }: any) => {
      updatePartnerOnline(Boolean(online));
      if (online) connectToPartner();
      else if (callStateRef.current !== 'idle' && callStateRef.current !== 'incoming') {
        // Server also ends the call; this keeps the UI snappy.
      }
    };

    const onPairSuccess = ({ partnerId: p, isPartnerOnline: online }: any) => {
      updatePartner(p);
      updatePartnerOnline(Boolean(online));
      setNotice(null);
      if (online) connectToPartner();
    };

    const onUnpaired = () => {
      resetCall();
      updatePartner(null);
      updatePartnerOnline(false);
      dataConnRef.current?.close();
      dataConnRef.current = null;
      clearChat();
      setCallHistory([]);
    };

    const onIncomingCall = ({ video }: any = {}) => {
      if (callStateRef.current !== 'idle') return;
      callVideoRef.current = video !== false;
      setIsVideoCall(video !== false);
      updateCallState('incoming');
      if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
    };

    const onCallAccepted = async () => {
      // Caller side: now start the media connection to the partner.
      const target = partnerRef.current;
      const stream = localStreamRef.current;
      if (!target || !peerRef.current || callStateRef.current !== 'calling') return;
      callAcceptedRef.current = true;
      const call = peerRef.current.call(target, stream || new MediaStream());
      attachMediaCall(call);
    };

    const onCallDeclined = () => {
      resetCall();
      setNotice('Your partner declined the call.');
    };
    const onCallMissed = () => {
      resetCall();
      setNotice('Your partner did not answer.');
    };
    const onCallEnded = () => resetCall();
    const onCallError = ({ message }: any) => {
      resetCall();
      setNotice(message || 'The call could not be started.');
    };

    const onChat = (msg: any) => {
      // Receipt: a message I sent while I was away has been seen. Show it as mine, with the green dot.
      if (msg.receipt) {
        const k = msg.receipt.kind;
        appendMessage({
          id: msg.id,
          sender: 'me',
          text: k === 'photo' ? '📷 Photo' : k === 'video' ? '🎥 Video' : msg.receipt.text || 'Message',
          timestamp: msg.timestamp || Date.now(),
          status: 'seen',
        });
        noteUnseen(msg.id);
        return;
      }
      if (msg.call) {
        appendMessage({ id: msg.id, sender: 'system', timestamp: msg.timestamp || Date.now(), call: msg.call });
        noteUnseen(msg.id);
        return;
      }
      if (msg.media && msg.media.url) {
        downloadCloudMedia(msg);
        return;
      }
      appendMessage({ ...msg, sender: 'peer', replyTo: flipReply(msg.replyTo) });
      noteUnseen(msg.id);
    };
    const onChatError = ({ id, message }: any) => {
      if (id) updateMsg(id, { transfer: undefined, progress: undefined });
      setNotice(message || 'Message could not be sent.');
    };
    const onReaction = ({ msgId, emoji }: any) =>
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, reactions: { ...m.reactions, peer: emoji || undefined } } : m))
      );
    const onMessageDeleted = ({ id }: any) => tombstone(id);
    const onMessagesSeen = ({ ids }: any) => {
      if (Array.isArray(ids)) markSeen(ids);
    };
    const onMediaSaved = ({ kind }: any) => addSystemMessage(`📥 Your partner saved your ${kind === 'video' ? 'video' : 'photo'}`);
    const onScreenshot = () => addSystemMessage('📸 Your partner attempted a screenshot');
    const onMediaToggle = ({ mediaStatus }: any) => setPartnerMediaStatus(mediaStatus);
    const onHistory = (rows: CallLogEntry[]) => setCallHistory(rows);
    const onReplaced = () => {
      setSocketConnected(false);
      setNotice('This account was opened on another tab or device.');
      socket.disconnect();
    };
    const onPairError = ({ message }: any) => setNotice(message || 'Pairing failed.');

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('registered', onRegistered);
    socket.on('register-error', onRegisterError);
    socket.on('partner-status', onPartnerStatus);
    socket.on('pair-success', onPairSuccess);
    socket.on('pair-error', onPairError);
    socket.on('unpaired', onUnpaired);
    socket.on('incoming-call', onIncomingCall);
    socket.on('call-accepted', onCallAccepted);
    socket.on('call-declined', onCallDeclined);
    socket.on('call-missed', onCallMissed);
    socket.on('call-ended', onCallEnded);
    socket.on('call-error', onCallError);
    socket.on('chat-message', onChat);
    socket.on('chat-error', onChatError);
    socket.on('messages-seen', onMessagesSeen);
    socket.on('reaction', onReaction);
    socket.on('message-deleted', onMessageDeleted);
    socket.on('media-saved', onMediaSaved);
    socket.on('screenshot-attempt', onScreenshot);
    socket.on('media-toggle', onMediaToggle);
    socket.on('call-history', onHistory);
    socket.on('replaced', onReplaced);

    const onVisible = () => {
      reportVisibility();
      if (document.visibilityState === 'visible') {
        if (!socket.connected) socket.connect();
        flushSeen();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', reportVisibility);

    (async () => {
      try {
        const cfg = await fetch(backendUrl('/api/config')).then((r) => r.json());
        if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) iceRef.current = cfg.iceServers;
        vapidRef.current = cfg.vapidPublicKey || null;
      } catch {
        /* defaults are fine */
      }
      if (cancelled) return;
      initPeerJS(myId);
      if (!socket.connected) socket.connect();
      else onConnect();
    })();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', reportVisibility);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('registered', onRegistered);
      socket.off('register-error', onRegisterError);
      socket.off('partner-status', onPartnerStatus);
      socket.off('pair-success', onPairSuccess);
      socket.off('pair-error', onPairError);
      socket.off('unpaired', onUnpaired);
      socket.off('incoming-call', onIncomingCall);
      socket.off('call-accepted', onCallAccepted);
      socket.off('call-declined', onCallDeclined);
      socket.off('call-missed', onCallMissed);
      socket.off('call-ended', onCallEnded);
      socket.off('call-error', onCallError);
      socket.off('chat-message', onChat);
      socket.off('chat-error', onChatError);
      socket.off('messages-seen', onMessagesSeen);
      socket.off('reaction', onReaction);
      socket.off('message-deleted', onMessageDeleted);
      socket.off('media-saved', onMediaSaved);
      socket.off('screenshot-attempt', onScreenshot);
      socket.off('media-toggle', onMediaToggle);
      socket.off('call-history', onHistory);
      socket.off('replaced', onReplaced);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
        peerOpenRef.current = false;
      }
      dataConnRef.current = null;
    };
  }, [
    isReady,
    myId,
    initPeerJS,
    connectToPartner,
    appendMessage,
    addSystemMessage,
    noteUnseen,
    markSeen,
    flushSeen,
    downloadCloudMedia,
    updateMsg,
    attachMediaCall,
    resetCall,
    subscribePush,
    updateCallState,
    updatePartner,
    updatePartnerOnline,
    clearChat,
  ]);

  // Each message disappears from the screen 24 h after it was sent, even if the app stays open.
  useEffect(() => {
    const sweep = () =>
      setMessages((prev) => {
        const now = Date.now();
        const expired = prev.filter((m) => now - Math.min(m.timestamp, now) > MESSAGE_TTL_MS);
        if (!expired.length) return prev;
        expired.forEach((m) => {
          if (m.videoUrl && m.videoUrl.startsWith('blob:')) URL.revokeObjectURL(m.videoUrl);
          if (m.imageUrl && m.imageUrl.startsWith('blob:')) URL.revokeObjectURL(m.imageUrl);
          knownIdsRef.current.delete(m.id);
        });
        return prev.filter((m) => !expired.includes(m));
      });
    const t = setInterval(sweep, 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Call duration counter
  useEffect(() => {
    if (callState === 'connected') {
      timerRef.current = setInterval(() => setCallDuration((p) => p + 1), 1000);
    } else {
      setCallDuration(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [callState]);

  // Auto-dismiss notices
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const pairWithPartner = useCallback(
    (targetCode: string) => {
      const formatted = targetCode.trim().toUpperCase();
      if (!formatted) return;
      if (formatted === myId) {
        setNotice('You cannot pair with your own code. Enter your partner\'s code.');
        return;
      }
      const socket = getSocket();
      if (!socket.connected) {
        setNotice('Connecting to the server. Please try again in a moment.');
        return;
      }
      // UI switches only when the server confirms (pair-success) — no more fake "paired" state.
      socket.emit('pair-with-partner', { targetPartnerId: formatted });
    },
    [myId]
  );

  const unpair = useCallback(() => {
    getSocket().emit('unpair');
  }, []);

  const startCall = useCallback(async (video: boolean = true) => {
    if (!partnerRef.current || callStateRef.current !== 'idle') return;
    callVideoRef.current = video;
    setIsVideoCall(video);
    updateCallState('calling');
    callAcceptedRef.current = false;
    const stream = await initLocalStream(isFrontRef.current, video);
    if (!stream) {
      updateCallState('idle');
      return;
    }
    getSocket().emit('start-call', { video });
  }, [initLocalStream, updateCallState]);

  const acceptCall = useCallback(async () => {
    const stream = await initLocalStream(isFrontRef.current, callVideoRef.current);
    if (!stream) {
      getSocket().emit('decline-call');
      resetCall();
      return;
    }
    callAcceptedRef.current = true;
    updateCallState('connected'); // shows "Connecting…" until the caller's media arrives
    getSocket().emit('accept-call');
  }, [initLocalStream, resetCall, updateCallState]);

  const declineCall = useCallback(() => {
    getSocket().emit('decline-call');
    resetCall();
  }, [resetCall]);

  const endCall = useCallback(() => {
    const conn = dataConnRef.current;
    if (conn && conn.open) {
      try {
        conn.send({ type: 'hangup' });
      } catch {
        /* the server signal below still goes out */
      }
    }
    getSocket().emit('end-call');
    resetCall();
  }, [resetCall]);

  const switchCamera = useCallback(async () => {
    const nextFacing = !isFrontRef.current;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: nextFacing ? 'user' : 'environment', width: { ideal: 720 }, height: { ideal: 1280 } },
      });
      const newTrack = newStream.getVideoTracks()[0];
      const local = localStreamRef.current;
      if (local) {
        const old = local.getVideoTracks()[0];
        if (old) {
          old.stop();
          local.removeTrack(old);
        }
        local.addTrack(newTrack);
        setLocalStream(new MediaStream(local.getTracks()));
      }
      const pc = activeMediaCallRef.current?.peerConnection;
      const sender = pc?.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      hasRealVideoRef.current = true;
      setIsVideoMuted(false);
      isFrontRef.current = nextFacing;
      setIsFrontCamera(nextFacing);
    } catch (err) {
      console.error('Camera switch error:', err);
      setNotice('Could not switch the camera.');
    }
  }, []);

  const toggleAudio = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    setIsAudioMuted(muted);
    const status = { audio: !muted, video: !isVideoMuted };
    sendToPartner({ type: 'media-toggle', mediaStatus: status }, 'media-toggle', { mediaStatus: status });
  }, [isVideoMuted, sendToPartner]);

  const toggleVideo = useCallback(async () => {
    const local = localStreamRef.current;
    if (!local) return;

    // No real camera yet (voice call, or the camera was busy): switch it on now, mid-call.
    if (!hasRealVideoRef.current) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: isFrontRef.current ? 'user' : 'environment', width: { ideal: 720 }, height: { ideal: 1280 } },
        });
        const track = cam.getVideoTracks()[0];
        const old = local.getVideoTracks()[0];
        if (old) {
          old.stop();
          local.removeTrack(old);
        }
        local.addTrack(track);
        setLocalStream(new MediaStream(local.getTracks()));
        const oldCall = activeMediaCallRef.current;
        const pc = oldCall?.peerConnection;
        const sender =
          pc?.getSenders().find((s) => s.track?.kind === 'video') ||
          pc?.getTransceivers().find((t) => t.receiver.track?.kind === 'video')?.sender;
        let sent = false;
        if (sender) {
          try {
            await sender.replaceTrack(track);
            sent = true;
          } catch (err) {
            console.warn('replaceTrack failed', err);
          }
        }
        // No video sender to swap into (rare): start a fresh media call that already carries the camera.
        // The old call is closed only after the new one is streaming, so the other side never sees a drop.
        if (!sent && oldCall && peerRef.current && partnerRef.current) {
          const fresh = peerRef.current.call(partnerRef.current, local);
          attachMediaCall(fresh);
          fresh.on('stream', () => oldCall.close());
        }
        hasRealVideoRef.current = true;
        setIsVideoMuted(false);
        const status = { audio: !isAudioMuted, video: true };
        sendToPartner({ type: 'media-toggle', mediaStatus: status }, 'media-toggle', { mediaStatus: status });
      } catch (e) {
        console.warn('camera on failed', e);
        setNotice(cameraErrorMessage(e));
      }
      return;
    }

    const track = local.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    setIsVideoMuted(muted);
    const status = { audio: !isAudioMuted, video: !muted };
    sendToPartner({ type: 'media-toggle', mediaStatus: status }, 'media-toggle', { mediaStatus: status });
  }, [isAudioMuted, sendToPartner, attachMediaCall]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim() || !partnerRef.current) return;
      const msg: ChatMessage = {
        id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
        sender: 'me',
        text: text.trim(),
        replyTo: takeReply(),
        timestamp: Date.now(),
      };
      appendMessage(msg);
      sendChat({ type: 'chat', id: msg.id, text: msg.text, replyTo: msg.replyTo, timestamp: msg.timestamp }, msg);
    },
    [appendMessage, sendChat, takeReply]
  );

  // Photo to cloud storage (partner offline, or not seen in time). Without cloud configured it falls back to the database relay.
  const uploadPhotoToCloud = useCallback(async (msg: ChatMessage) => {
    const socket = getSocket();
    try {
      const blob = await (await fetch(msg.imageUrl as string)).blob();
      const mime = blob.type || 'image/jpeg';
      const info: any = await new Promise((resolve) =>
        socket.timeout(10000).emit('media-upload-url', { kind: 'image', mime, size: blob.size }, (err: any, res: any) => resolve(err ? { error: 'timeout' } : res))
      );
      if (info.error === 'disabled') {
        socket.emit('chat-message', { message: msg });
        return;
      }
      if (info.error) throw new Error(info.error);
      await uploadWithProgress(info.url, blob, () => {}, mime);
      socket.emit('chat-message', { message: { id: msg.id, timestamp: msg.timestamp, replyTo: msg.replyTo, media: { key: info.key, kind: 'image', mime, size: blob.size } } });
    } catch (e) {
      console.warn('photo upload failed', e);
      setNotice('A photo could not be sent. Check your connection and try again.');
    }
  }, []);

  // Photo: peer-to-peer when the partner is online, otherwise through cloud storage.
  const sendPhoto = useCallback(
    (base64Image: string) => {
      if (!base64Image || !partnerRef.current) return;
      const msg: ChatMessage = {
        id: 'photo-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
        sender: 'me',
        imageUrl: base64Image,
        replyTo: takeReply(),
        timestamp: Date.now(),
      };
      appendMessage(msg);
      const conn = dataConnRef.current;
      if (conn && conn.open && partnerOnlineRef.current) {
        try {
          conn.send({ type: 'chat', id: msg.id, imageUrl: msg.imageUrl, replyTo: msg.replyTo, timestamp: msg.timestamp });
          // If it is not SEEN within 4 s (partner's app in background, etc.) also leave a copy in cloud storage.
          setTimeout(() => {
            if (!seenIdsRef.current.has(msg.id)) uploadPhotoToCloud(msg);
          }, 4000);
          return;
        } catch (e) {
          console.warn('P2P photo send failed, using cloud:', e);
        }
      }
      uploadPhotoToCloud(msg);
    },
    [appendMessage, uploadPhotoToCloud, takeReply]
  );

  // Video: straight peer-to-peer in chunks when the partner is online; otherwise (or if P2P drops) via private cloud storage.
  const sendVideo = useCallback(
    async (file: File) => {
      if (!partnerRef.current) return false;
      if (file.size > VIDEO_MAX_BYTES) {
        setNotice('Videos must be 500 MB or smaller.');
        return false;
      }
      const unseenVideos = messagesRef.current.filter((m) => m.sender === 'me' && m.videoUrl && m.status !== 'seen').length;
      if (unseenVideos >= MAX_UNSEEN_VIDEOS) {
        setNotice(`You can have at most ${MAX_UNSEEN_VIDEOS} unseen videos. Wait until your partner watches some.`);
        return false;
      }
      const id = 'video-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
      const timestamp = Date.now();
      const replyTo = takeReply();
      appendMessage({ id, sender: 'me', videoUrl: URL.createObjectURL(file), timestamp, transfer: 'sending', progress: 0, replyTo });

      const finish = () => updateMsg(id, { transfer: undefined, progress: undefined });
      const fail = (msg: string) => {
        removeMsg(id);
        setNotice(msg);
        return false;
      };

      // 1) Peer-to-peer
      const conn = dataConnRef.current;
      if (conn && conn.open && partnerOnlineRef.current && file.size <= P2P_MAX_BYTES) {
        try {
          const total = Math.ceil(file.size / VIDEO_CHUNK);
          conn.send({ type: 'vid-start', id, mime: file.type || 'video/mp4', total, timestamp, replyTo });
          for (let i = 0; i < total; i++) {
            if (!conn.open) throw new Error('closed');
            const buf = await file.slice(i * VIDEO_CHUNK, (i + 1) * VIDEO_CHUNK).arrayBuffer();
            // back-pressure so we never queue the whole file in memory
            const dc = (conn as any).dataChannel as RTCDataChannel | undefined;
            while (conn.open && (((conn as any).bufferSize || 0) > 160 || (dc && dc.bufferedAmount > 4 * 1024 * 1024))) {
              await new Promise((r) => setTimeout(r, 40));
            }
            conn.send({ type: 'vid-chunk', id, i, data: buf });
            if (i % 4 === 0) updateMsg(id, { progress: (i + 1) / total });
          }
          conn.send({ type: 'vid-end', id });
          finish();
          return true;
        } catch (e) {
          console.warn('P2P video failed, using cloud:', e);
          updateMsg(id, { progress: 0 });
        }
      }

      // 2) Cloud (partner offline or P2P failed)
      const socket = getSocket();
      const info: any = await new Promise((resolve) =>
        socket.timeout(10000).emit('media-upload-url', { kind: 'video', mime: file.type || 'video/mp4', size: file.size }, (err: any, res: any) =>
          resolve(err ? { error: 'timeout' } : res)
        )
      );
      if (info.error === 'disabled') return fail('Your partner is offline and cloud storage is not configured yet.');
      if (info.error === 'limit') return fail(`You can have at most ${MAX_UNSEEN_VIDEOS} unseen videos. Wait until your partner watches some.`);
      if (info.error) return fail('Could not start the upload. Please try again.');
      try {
        await uploadWithProgress(info.url, file, (p) => updateMsg(id, { progress: p }));
      } catch {
        return fail('Video upload failed. Check your connection and try again.');
      }
      socket.emit('chat-message', { message: { id, timestamp, replyTo, media: { key: info.key, kind: 'video', mime: file.type || 'video/mp4', size: file.size } } });
      finish();
      setNotice('Video uploaded. Your partner will get it as soon as they open the app.');
      return true;
    },
    [appendMessage, updateMsg, removeMsg, takeReply]
  );

  // Save a photo/video to the device. If it is the partner's media, they get told (like Snapchat).
  const saveMedia = useCallback(
    (msg: ChatMessage) => {
      const url = msg.imageUrl || msg.videoUrl;
      if (!url) return;
      const kind = msg.videoUrl ? 'video' : 'photo';
      const a = document.createElement('a');
      a.href = url;
      a.download = `p2p-duo-${Date.now()}.${kind === 'video' ? 'mp4' : 'jpg'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (msg.sender === 'peer') {
        sendToPartner({ type: 'media-saved', msgId: msg.id, kind }, 'media-saved', { msgId: msg.id, kind });
        addSystemMessage(`📥 You saved a ${kind === 'video' ? 'video' : 'photo'} — your partner was notified`);
      }
    },
    [sendToPartner, addSystemMessage]
  );

  // While any call screen is open: ask the server every few seconds whether the call still exists, and stop an
  // unanswered incoming-call screen after 45 s. Fixes "one side hung up, the other still shows a live call".
  useEffect(() => {
    if (callState === 'idle') return;
    const beat = setInterval(() => {
      getSocket()
        .timeout(4000)
        .emit('call-ping', {}, (err: any, res: any) => {
          if (!err && res && res.active === false && callStateRef.current !== 'idle') resetCall();
        });
    }, 6000);
    const ring = callState === 'incoming' ? setTimeout(() => resetCall(), 45000) : null;
    return () => {
      clearInterval(beat);
      if (ring) clearTimeout(ring);
    };
  }, [callState, resetCall]);

  // While a call is on: keep the screen awake, show it in the OS media controls (hang up from the lock screen),
  // and bring the camera back if the browser stopped it while the app was in the background.
  useEffect(() => {
    if (callState !== 'connected' && callState !== 'calling') return;
    let lock: any = null;
    const acquire = async () => {
      try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') lock = await (navigator as any).wakeLock.request('screen');
      } catch {
        /* not supported or denied: the call still works */
      }
    };
    acquire();

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      acquire();
      const track = localStreamRef.current?.getVideoTracks()[0];
      if (hasRealVideoRef.current && track && track.readyState === 'ended') {
        hasRealVideoRef.current = false;
        toggleVideo(); // re-acquires the camera and swaps it into the live call
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'Ongoing call' });
        navigator.mediaSession.setActionHandler('hangup' as any, () => endCall());
      }
    } catch {
      /* optional */
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      try {
        lock?.release();
      } catch {
        /* ignore */
      }
      try {
        if ('mediaSession' in navigator) {
          navigator.mediaSession.setActionHandler('hangup' as any, null);
          navigator.mediaSession.metadata = null;
        }
      } catch {
        /* ignore */
      }
    };
  }, [callState, toggleVideo, endCall]);

  const reportScreenshot = useCallback(() => {
    if (!partnerRef.current) return;
    sendToPartner({ type: 'screenshot-attempt' }, 'screenshot-attempt', {});
    addSystemMessage('📸 Screenshot attempt — your partner was notified');
  }, [sendToPartner, addSystemMessage]);

  return {
    isReady,
    isVideoCall,
    myId,
    partnerId,
    isPartnerOnline,
    socketConnected,
    notice,
    callHistory,
    notificationState,
    callState,
    callDuration,
    localStream,
    remoteStream,
    isAudioMuted,
    isVideoMuted,
    isFrontCamera,
    partnerMediaStatus,
    messages,
    pairWithPartner,
    unpair,
    startCall,
    acceptCall,
    declineCall,
    endCall,
    switchCamera,
    toggleAudio,
    toggleVideo,
    sendMessage,
    sendPhoto,
    sendVideo,
    saveMedia,
    reportScreenshot,
    clearChat,
    enableNotifications,
    dismissNotice: () => setNotice(null),
    showNotice: (m: string) => setNotice(m),
    replyTarget,
    startReply: (m: ChatMessage) => setReplyTarget(m),
    cancelReply: () => setReplyTarget(null),
    reactToMessage,
    deleteForMe,
    deleteForEveryone,
  };
}
