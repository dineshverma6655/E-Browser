'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  X,
  Plus,
  Camera,
  ImageIcon,
  Flame,
  Trash2,
  MessageCircle,
  Download,
  Loader2,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Video as VideoIcon,
  Reply,
  Ban,
  Copy as CopyIcon,
} from 'lucide-react';
import { ChatMessage, ReplyRef } from '@/types';
import { CameraCapture } from '@/components/CameraCapture';

const MAX_IMAGES_PER_SEND = 20;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
// 5 quick reactions + a "+" that opens the full picker
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢'];
const ALL_EMOJIS = [
  '👍', '👎', '❤️', '🔥', '😂', '🤣', '😊', '😍', '🥰', '😘', '😎', '🤔',
  '😮', '😲', '😢', '😭', '😡', '🥺', '🙏', '👏', '🙌', '💪', '🤝', '👌',
  '✌️', '🤞', '🎉', '✨', '💯', '🙈', '😴', '🤗', '😅', '😉', '😇', '🤩',
  '😬', '😱', '🤯', '🥳', '😋', '😜', '🤪', '😐', '🙄', '😤', '💔', '💕',
];
const LONG_PRESS_MS = 420;
const SWIPE_REPLY_PX = 34; // a light slide to the right is enough

interface ChatSheetProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onSendPhoto?: (base64: string) => void;
  onSendVideo?: (file: File) => Promise<boolean> | boolean | void;
  onSaveMedia?: (msg: ChatMessage) => void;
  onClearChat?: () => void;
  onNotice?: (message: string) => void;
  /** reply / react / delete (long-press menu) */
  replyTarget?: ChatMessage | null;
  onReply?: (msg: ChatMessage) => void;
  onCancelReply?: () => void;
  onReact?: (msgId: string, emoji: string) => void;
  onDeleteForMe?: (msgId: string) => void;
  onDeleteForEveryone?: (msgId: string) => void;
  /** live connection state, used for the status dot under your messages */
  partnerOnline?: boolean;
  connected?: boolean;
  partnerName?: string;
  /** 'sheet' = bottom overlay (used during calls), 'inline' = fills its parent like a messaging app */
  variant?: 'sheet' | 'inline';
}

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        const maxDim = 1280;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

const replySnippet = (r: ReplyRef) => r.text || (r.kind === 'photo' ? '📷 Photo' : r.kind === 'video' ? '🎥 Video' : 'Message');
const messageSnippet = (m: ChatMessage) =>
  m.text || (m.imageUrl || m.mediaKind === 'image' ? '📷 Photo' : m.videoUrl || m.mediaKind === 'video' ? '🎥 Video' : 'Message');

export const ChatSheet: React.FC<ChatSheetProps> = ({
  isOpen,
  onClose,
  messages,
  onSendMessage,
  onSendPhoto,
  onSendVideo,
  onSaveMedia,
  onClearChat,
  onNotice,
  replyTarget = null,
  onReply,
  onCancelReply,
  onReact,
  onDeleteForMe,
  onDeleteForEveryone,
  partnerOnline = true,
  connected = true,
  partnerName = 'Partner',
  variant = 'sheet',
}) => {
  const inline = variant === 'inline';
  const [inputText, setInputText] = useState('');
  const [viewer, setViewer] = useState<ChatMessage | null>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  // Long-press popup anchored next to the pressed message (like WhatsApp)
  const [menu, setMenu] = useState<{ msg: ChatMessage; rect: { top: number; bottom: number; left: number; right: number } } | null>(null);
  const [moreEmoji, setMoreEmoji] = useState(false);
  const [deleteAsk, setDeleteAsk] = useState<ChatMessage | null>(null);
  // Tiny "who reacted with what" popup, opened by tapping the reaction pill under a message
  const [reactInfo, setReactInfo] = useState<{ id: string; rect: { left: number; right: number; top: number; bottom: number } } | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number } | null>(null); // swipe-to-reply offset

  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null); // the app column: popups are kept inside it
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null); // fallback when the in-app camera is unavailable (photo only)
  const galleryInputRef = useRef<HTMLInputElement>(null);

  // long-press / swipe tracking
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longFired = useRef(false);
  const swipeDone = useRef(false); // reply already triggered during this gesture
  const menuOpenedAt = useRef(0); // the finger-lift right after a long-press must not close the popup it just opened
  const start = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (isOpen || inline) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [isOpen, inline, messages.length]);

  // Keyboard opened/closed (visible area changed): keep the newest message in view
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const onResize = () => messagesEndRef.current?.scrollIntoView({ block: 'end' });
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // Replying: jump straight to the composer
  useEffect(() => {
    if (replyTarget) inputRef.current?.focus();
  }, [replyTarget]);

  if (!isOpen && !inline) return null;

  // Closing the chat removes every message, photo and video. The pairing itself is never touched.
  const handleClose = () => {
    setViewer(null);
    setMenu(null);
    setDeleteAsk(null);
    onClearChat?.();
    onClose();
  };

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim()) {
      onSendMessage(inputText);
      setInputText('');
    }
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    setAttachMenu(false);
    void processFiles(files);
  };

  const openCamera = () => {
    setAttachMenu(false);
    // In-app camera (photo + video) needs getUserMedia (HTTPS/localhost); otherwise fall back to the phone's camera app for a photo.
    if (typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
      setCameraOpen(true);
    } else {
      cameraInputRef.current?.click();
    }
  };

  const processFiles = async (files: File[]) => {
    if (!files.length) return;

    let images = files.filter((f) => f.type.startsWith('image/'));
    const videos = files.filter((f) => f.type.startsWith('video/'));

    if (images.length > MAX_IMAGES_PER_SEND) {
      onNotice?.(`You can send up to ${MAX_IMAGES_PER_SEND} photos at a time.`);
      images = images.slice(0, MAX_IMAGES_PER_SEND);
    }
    for (const file of images) {
      try {
        onSendPhoto?.(await compressImage(file));
      } catch {
        onNotice?.('One of the photos could not be read.');
      }
    }
    for (const file of videos) {
      if (file.size > MAX_VIDEO_BYTES) {
        onNotice?.('Videos must be 500 MB or smaller.');
        continue;
      }
      const ok = await onSendVideo?.(file);
      if (ok === false) break; // limit reached or failed: do not keep trying the rest
    }
  };

  // ---- long-press popup + swipe-to-reply on a message ----
  const openMenu = (msg: ChatMessage, rowEl: HTMLElement) => {
    rowEl.scrollIntoView({ block: 'center', behavior: 'auto' }); // make room above and below the bubble
    requestAnimationFrame(() => {
      const target = (rowEl.querySelector('[data-bubble]') as HTMLElement) || rowEl;
      const r = target.getBoundingClientRect();
      setMoreEmoji(false);
      menuOpenedAt.current = Date.now();
      setMenu({ msg, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } });
    });
  };

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const rowProps = (msg: ChatMessage) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      start.current = { x: e.clientX, y: e.clientY };
      longFired.current = false;
      swipeDone.current = false;
      clearPress();
      const rowEl = e.currentTarget as HTMLElement;
      pressTimer.current = setTimeout(() => {
        longFired.current = true;
        if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(12);
        openMenu(msg, rowEl);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const dx = e.clientX - start.current.x;
      const dy = Math.abs(e.clientY - start.current.y);
      if (Math.abs(dx) > 8 || dy > 10) clearPress();
      if (msg.deleted || !onReply || swipeDone.current || longFired.current) return;
      if (dx > 4 && dy < 30) {
        // the message follows the finger, and the reply starts as soon as the slide is light-but-clear
        setDrag({ id: msg.id, x: Math.min(dx, 60) });
        if (dx > SWIPE_REPLY_PX) {
          swipeDone.current = true;
          if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(8);
          onReply(msg);
          setDrag(null); // springs back
        }
      }
    },
    onPointerUp: () => {
      clearPress();
      setDrag(null);
    },
    onPointerCancel: () => {
      clearPress();
      setDrag(null);
    },
    onPointerLeave: () => {
      clearPress();
      setDrag(null);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      openMenu(msg, e.currentTarget as HTMLElement);
    },
    // A long-press must not also "click" the photo/video underneath
    onClickCapture: (e: React.MouseEvent) => {
      if (longFired.current) {
        e.stopPropagation();
        e.preventDefault();
        longFired.current = false;
      }
    },
  });

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older browsers / non-secure pages: fall back to a temporary textarea.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      (window as any).__allowCopy = true;
      try {
        document.execCommand('copy');
      } finally {
        (window as any).__allowCopy = false;
        ta.remove();
      }
    }
    onNotice?.('Copied');
  };

  const jumpTo = (id: string) => {
    const el = listRef.current?.querySelector(`[data-mid="${CSS.escape(id)}"]`);
    if (!el) {
      onNotice?.('That message is no longer in this chat.');
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashId(id);
    setTimeout(() => setFlashId(null), 1300);
  };

  const SaveButton = ({ msg, dark = false }: { msg: ChatMessage; dark?: boolean }) =>
    onSaveMedia ? (
      <button
        onClick={(e) => {
          e.stopPropagation();
          onSaveMedia(msg);
        }}
        className={`inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full active:scale-95 transition-transform ${
          dark ? 'bg-white/20 text-white backdrop-blur-md' : 'bg-black/55 text-white backdrop-blur-sm'
        }`}
        title={msg.sender === 'peer' ? 'Save (your partner will be notified)' : 'Save'}
      >
        <Download className="w-3 h-3" /> Save
      </button>
    ) : null;

  const ProgressBar = ({ value }: { value: number }) => (
    <div className="h-1 w-full rounded-full bg-white/15 overflow-hidden">
      <div className="h-full bg-emerald-400 transition-all" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );

  // The quoted message at the top of a reply
  const Quote = ({ r, isMe }: { r: ReplyRef; isMe: boolean }) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        jumpTo(r.id);
      }}
      className={`block w-full text-left mb-1.5 rounded-lg border-l-[3px] px-2.5 py-1.5 ${
        isMe ? 'bg-black/20 border-white/70' : 'bg-black/25 border-emerald-400'
      }`}
    >
      <span className={`block text-[11px] font-semibold ${isMe ? 'text-white/90' : 'text-emerald-300'}`}>{r.mine ? 'You' : partnerName}</span>
      <span className="block text-xs text-slate-200/80 truncate max-w-[14rem]">{replySnippet(r)}</span>
    </button>
  );

  // Emoji reactions shown just under a bubble. Tap the pill to see who reacted with what.
  const Reactions = ({ msg, isMe }: { msg: ChatMessage; isMe: boolean }) => {
    const list = [msg.reactions?.me, msg.reactions?.peer].filter(Boolean) as string[];
    if (!list.length) return null;
    return (
      <div className={`-mt-2 relative z-[1] flex ${isMe ? 'justify-end pr-2' : 'justify-start pl-2'}`}>
        <button
          type="button"
          aria-label="See who reacted"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setReactInfo({ id: msg.id, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
          }}
          className="inline-flex items-center gap-0.5 rounded-full bg-slate-800 border border-slate-600/70 px-1.5 py-0.5 text-sm shadow active:scale-95 transition-transform"
        >
          {list.map((e, i) => (
            <span key={i}>{e}</span>
          ))}
        </button>
      </div>
    );
  };

  // Small status dot under your own messages: red = partner offline / no internet, blue = partner online, green = seen
  const dotFor = (msg: ChatMessage) => {
    const seen = msg.status === 'seen';
    const offline = !connected || !partnerOnline;
    const color = seen ? 'bg-emerald-400' : offline ? 'bg-rose-500' : 'bg-sky-400';
    const label = seen ? 'Seen' : offline ? 'Waiting - partner is offline' : 'Sent - not seen yet';
    const word = seen ? 'Seen' : offline ? 'Waiting' : 'Sent';
    const wordColor = seen ? 'text-emerald-300' : offline ? 'text-rose-300' : 'text-sky-200';
    return (
      <span title={label} aria-label={label} className="inline-flex items-center align-middle ml-1.5">
        <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
        <span className={`ml-1 text-[10px] leading-none ${wordColor}`}>{word}</span>
      </span>
    );
  };

  const rowStyle = (msg: ChatMessage): React.CSSProperties =>
    drag && drag.id === msg.id
      ? { transform: `translateX(${drag.x}px)`, transition: 'none' }
      : { transform: 'translateX(0)', transition: 'transform 0.18s ease-out' };

  // A small always-visible reply button next to the bubble (the swipe and the long-press menu do the same)
  const replyBtn = (msg: ChatMessage) =>
    onReply && !msg.deleted ? (
      <button
        type="button"
        aria-label="Reply"
        title="Reply"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onReply(msg);
        }}
        className={`self-center flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:text-white hover:bg-slate-800 active:scale-90 transition ${
          drag && drag.id === msg.id && drag.x > SWIPE_REPLY_PX ? 'text-emerald-400 bg-slate-800' : ''
        }`}
      >
        <Reply className="w-4 h-4" />
      </button>
    ) : null;

  const flash = (id: string) => (flashId === id ? 'ring-2 ring-emerald-400/70 rounded-2xl transition-shadow' : '');

  return (
    <div
      ref={rootRef}
      className={
        inline
          ? 'flex-1 min-h-0 flex flex-col select-none'
          : 'absolute bottom-0 inset-x-0 z-50 flex flex-col h-[68%] rounded-t-3xl bg-slate-950 border-t border-slate-700/70 shadow-[0_-12px_40px_rgba(0,0,0,0.6)] select-none overflow-hidden'
      }
    >
      {!inline && (
        <>
          <div className="flex justify-center pt-2">
            <span className="w-10 h-1 rounded-full bg-slate-700" />
          </div>
          <div className="px-4 py-2 border-b border-slate-800/80 flex items-center justify-between bg-slate-950">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-full bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 flex-shrink-0">
                <Flame className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold text-slate-100 text-sm truncate">{partnerName}</h3>
                <p className="text-[10px] text-slate-400">Messages disappear when you close this chat</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {onClearChat && (
                <button onClick={onClearChat} className="p-2 rounded-full hover:bg-slate-800 text-slate-400 hover:text-rose-400" title="Clear chat">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button onClick={handleClose} className="p-2 rounded-full hover:bg-slate-800 text-slate-400 hover:text-white" title="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        </>
      )}

      {/* Messages */}
      <div ref={listRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-3 no-scrollbar">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <div className="w-14 h-14 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center mb-3">
              <MessageCircle className="w-6 h-6 text-slate-500" />
            </div>
            <p className="text-sm font-medium text-slate-300">No messages yet</p>
            <p className="text-xs text-slate-500 mt-1 max-w-[16rem] leading-relaxed">
              Photos and videos can be replayed while the chat is open. Press and hold a message to reply, react or delete it.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.call) {
              const c = msg.call;
              const kind = c.video ? 'Video' : 'Voice';
              const mm = String(Math.floor(c.duration / 60)).padStart(2, '0');
              const ss = String(c.duration % 60).padStart(2, '0');
              const bad = c.status !== 'completed';
              const Icon = bad ? PhoneMissed : c.outgoing ? PhoneOutgoing : PhoneIncoming;
              const label =
                c.status === 'completed'
                  ? `${kind} call · ${mm}:${ss}`
                  : c.status === 'declined'
                    ? c.outgoing
                      ? `${kind} call declined`
                      : `You declined a ${kind.toLowerCase()} call`
                    : c.outgoing
                      ? `${kind} call · No answer`
                      : `Missed ${kind.toLowerCase()} call`;
              const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return (
                <div key={msg.id} data-mid={msg.id} className="flex justify-center">
                  <span
                    className={`inline-flex items-center gap-2 text-xs rounded-full px-3.5 py-1.5 border ${
                      bad ? 'text-rose-300 bg-rose-500/10 border-rose-500/25' : 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25'
                    }`}
                  >
                    {c.video && !bad ? <VideoIcon className="w-3.5 h-3.5" /> : <Icon className="w-3.5 h-3.5" />}
                    {label}
                    <span className="text-[10px] opacity-60">{time}</span>
                  </span>
                </div>
              );
            }

            if (msg.sender === 'system') {
              return (
                <div key={msg.id} data-mid={msg.id} className="flex justify-center">
                  <span className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-full px-3 py-1">
                    {msg.text}
                  </span>
                </div>
              );
            }

            const isMe = msg.sender === 'me';
            const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const align = isMe ? 'items-end' : 'items-start';

            // "Delete for everyone" tombstone
            if (msg.deleted) {
              return (
                <div key={msg.id} data-mid={msg.id} className={`flex flex-col ${align} touch-pan-y`} style={rowStyle(msg)} {...rowProps(msg)}>
                  <span data-bubble className="inline-flex items-center gap-1.5 text-xs italic text-slate-500 border border-slate-800 rounded-2xl px-3 py-2">
                    <Ban className="w-3.5 h-3.5" />
                    {isMe ? 'You deleted this message' : 'This message was deleted'}
                  </span>
                </div>
              );
            }

            if (msg.imageUrl) {
              return (
                <div key={msg.id} data-mid={msg.id} className={`flex flex-col ${align} touch-pan-y`} style={rowStyle(msg)} {...rowProps(msg)}>
                  <div className="flex items-center gap-1.5 max-w-full">
                  {isMe && replyBtn(msg)}
                  <div data-bubble className={`max-w-[72%] ${flash(msg.id)}`}>
                    {msg.replyTo && (
                      <div className={`rounded-2xl px-2 pt-2 ${isMe ? 'bg-indigo-600' : 'bg-slate-800 border border-slate-700/60'}`}>
                        <Quote r={msg.replyTo} isMe={isMe} />
                      </div>
                    )}
                    <div className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={msg.imageUrl}
                        alt=""
                        draggable={false}
                        onClick={() => setViewer(msg)}
                        className="rounded-2xl max-h-64 min-w-[120px] min-h-[80px] object-cover cursor-pointer border border-slate-700/60 shadow-lg"
                      />
                      <div className="absolute bottom-2 right-2">
                        <SaveButton msg={msg} />
                      </div>
                    </div>
                  </div>
                  {!isMe && replyBtn(msg)}
                  </div>
                  <Reactions msg={msg} isMe={isMe} />
                  <span className="text-[10px] text-slate-500 mt-1">
                    {time}
                    {isMe && dotFor(msg)}
                  </span>
                </div>
              );
            }

            if (msg.transfer && !msg.videoUrl) {
              // Incoming media still arriving
              return (
                <div key={msg.id} data-mid={msg.id} className={`flex flex-col ${align}`}>
                  <div className="w-56 rounded-2xl bg-slate-800 border border-slate-700/60 px-4 py-3 space-y-2">
                    {msg.replyTo && <Quote r={msg.replyTo} isMe={false} />}
                    <div className="flex items-center gap-2 text-xs text-slate-200">
                      <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                      <span>Receiving {msg.mediaKind === 'image' ? 'photo' : 'video'}… {Math.round((msg.progress || 0) * 100)}%</span>
                    </div>
                    <ProgressBar value={msg.progress || 0} />
                  </div>
                </div>
              );
            }

            if (msg.videoUrl) {
              return (
                <div key={msg.id} data-mid={msg.id} className={`flex flex-col ${align} touch-pan-y`} style={rowStyle(msg)} {...rowProps(msg)}>
                  <div className="flex items-center gap-1.5 max-w-full">
                  {isMe && replyBtn(msg)}
                  <div data-bubble className={`max-w-[72%] ${flash(msg.id)}`}>
                    {msg.replyTo && (
                      <div className={`rounded-2xl px-2 pt-2 ${isMe ? 'bg-indigo-600' : 'bg-slate-800 border border-slate-700/60'}`}>
                        <Quote r={msg.replyTo} isMe={isMe} />
                      </div>
                    )}
                    <div className="relative">
                      <video
                        src={msg.videoUrl}
                        controls
                        playsInline
                        controlsList="nodownload noremoteplayback"
                        disablePictureInPicture
                        onContextMenu={(e) => e.preventDefault()}
                        className="rounded-2xl max-h-72 border border-slate-700/60 shadow-lg bg-black"
                      />
                      {msg.transfer === 'sending' ? (
                        <div className="absolute inset-x-0 bottom-0 rounded-b-2xl bg-black/70 px-3 py-2 space-y-1.5">
                          <p className="text-[11px] text-slate-100">Sending… {Math.round((msg.progress || 0) * 100)}%</p>
                          <ProgressBar value={msg.progress || 0} />
                        </div>
                      ) : (
                        <div className="absolute top-2 right-2">
                          <SaveButton msg={msg} />
                        </div>
                      )}
                    </div>
                  </div>
                  {!isMe && replyBtn(msg)}
                  </div>
                  <Reactions msg={msg} isMe={isMe} />
                  <span className="text-[10px] text-slate-500 mt-1">
                    {time}
                    {isMe && dotFor(msg)}
                  </span>
                </div>
              );
            }

            return (
              <div key={msg.id} data-mid={msg.id} className={`flex flex-col ${align} touch-pan-y`} style={rowStyle(msg)} {...rowProps(msg)}>
                <div className="flex items-center gap-1.5 max-w-full">
                {isMe && replyBtn(msg)}
                <div
                  data-bubble
                  className={`max-w-[80%] min-w-0 rounded-2xl px-3.5 py-2 text-[15px] leading-snug break-words [overflow-wrap:anywhere] shadow-md ${flash(msg.id)} ${
                    isMe ? 'bg-indigo-600 text-white rounded-br-md' : 'bg-slate-800 text-slate-100 rounded-bl-md border border-slate-700/60'
                  }`}
                >
                  {msg.replyTo && <Quote r={msg.replyTo} isMe={isMe} />}
                  <p>{msg.text}</p>
                  <span className={`text-[10px] block mt-0.5 text-right ${isMe ? 'text-indigo-200' : 'text-slate-400'}`}>
                    {time}
                    {isMe && dotFor(msg)}
                  </span>
                </div>
                {!isMe && replyBtn(msg)}
                </div>
                <Reactions msg={msg} isMe={isMe} />
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Reply preview above the composer */}
      {replyTarget && (
        <div className="flex items-center gap-3 px-3 py-2 border-t border-slate-800/80 bg-slate-950/95">
          <span className="w-1 self-stretch rounded bg-emerald-400" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-emerald-300">Replying to {replyTarget.sender === 'me' ? 'yourself' : partnerName}</p>
            <p className="text-xs text-slate-300 truncate">{messageSnippet(replyTarget)}</p>
          </div>
          <button onClick={onCancelReply} aria-label="Cancel reply" className="p-1.5 rounded-full text-slate-400 hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Composer */}
      <div className={`px-3 pt-2 pb-3 border-t border-slate-800/80 safe-bottom ${inline ? 'bg-slate-950/90 backdrop-blur-md' : 'bg-slate-950'}`}>
        <form onSubmit={handleSendText} className="flex items-center gap-2">
          {(onSendPhoto || onSendVideo) && (
            <div className="relative flex-shrink-0">
              {/* Camera: in-app camera (photo or video). Gallery: pick up to 20 photos / a video. */}
              <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFiles} />
              <input ref={galleryInputRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={handleFiles} />

              <button
                type="button"
                onClick={() => setAttachMenu((v) => !v)}
                aria-label="Attach"
                aria-expanded={attachMenu}
                className={`w-11 h-11 rounded-full border flex items-center justify-center active:scale-95 transition-all ${
                  attachMenu ? 'bg-indigo-600 border-indigo-500 text-white rotate-45' : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Plus className="w-5 h-5" />
              </button>

              {attachMenu && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setAttachMenu(false)} />
                  <div className="absolute bottom-14 left-0 z-30 w-44 rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden">
                    <button
                      type="button"
                      onClick={openCamera}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-100 hover:bg-slate-800"
                    >
                      <Camera className="w-4 h-4 text-rose-400" /> Camera
                    </button>
                    <button
                      type="button"
                      onClick={() => galleryInputRef.current?.click()}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-100 hover:bg-slate-800 border-t border-slate-800"
                    >
                      <ImageIcon className="w-4 h-4 text-indigo-400" /> Gallery
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Message"
            className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded-full px-4 py-3 text-base text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!inputText.trim()}
            aria-label="Send"
            className="w-11 h-11 rounded-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white flex items-center justify-center active:scale-95 flex-shrink-0"
          >
            <Send className="w-4 h-4 ml-0.5" />
          </button>
        </form>
      </div>

      {/* Long-press popup: 5 quick reactions + "+", then Reply / Delete — anchored next to the message */}
      {menu &&
        (() => {
          const { msg, rect } = menu;
          const mine = msg.sender === 'me';
          const vw = typeof window !== 'undefined' ? window.innerWidth : 400;
          const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
          const bounds = rootRef.current?.getBoundingClientRect();
          const minX = (bounds?.left ?? 0) + 8;
          const maxX = (bounds?.right ?? vw) - 8;
          const avail = Math.max(200, maxX - minX);
          const BW = Math.min(296, avail); // emoji bar / picker width
          const MW = Math.min(216, avail); // action menu width
          const canCopy = !msg.deleted && Boolean(msg.text);
          const actionCount = (!msg.deleted && onReply ? 1 : 0) + (canCopy ? 1 : 0) + (onDeleteForMe || onDeleteForEveryone ? 1 : 0);
          const MH = actionCount * 46 + 2;
          const clampX = (x: number, w: number) => Math.max(minX, Math.min(x, maxX - w));
          const barLeft = clampX(mine ? rect.right - BW : rect.left, BW);
          const menuLeft = clampX(mine ? rect.right - MW : rect.left, MW);
          const barTop = Math.max(8, rect.top - 60);
          const menuTop = Math.min(rect.bottom + 8, vh - MH - 8);
          const gridTop = Math.max(8, Math.min(rect.top - 60, vh - 292));
          const close = () => {
            setMenu(null);
            setMoreEmoji(false);
          };
          const pick = (emoji: string) => {
            onReact?.(msg.id, emoji);
            close();
          };
          return (
            <div className="fixed inset-0 z-[110] bg-black/45" onClick={() => Date.now() - menuOpenedAt.current > 600 && close()}>
              {!msg.deleted && onReact && !moreEmoji && (
                <div
                  style={{ left: barLeft, top: barTop, width: BW }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute flex items-center justify-between rounded-full bg-slate-900 border border-slate-700 px-2 py-1.5 shadow-2xl"
                >
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => pick(emoji)}
                      aria-label={`React ${emoji}`}
                      className={`w-10 h-10 rounded-full text-2xl flex items-center justify-center active:scale-90 transition-transform ${
                        msg.reactions?.me === emoji ? 'bg-indigo-600/40 ring-1 ring-indigo-400' : 'hover:bg-slate-800'
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                  <button
                    onClick={() => setMoreEmoji(true)}
                    aria-label="More emojis"
                    className="w-9 h-9 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center active:scale-90"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </div>
              )}

              {!msg.deleted && onReact && moreEmoji && (
                <div
                  style={{ left: barLeft, top: gridTop, width: BW }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute rounded-3xl bg-slate-900 border border-slate-700 p-2 shadow-2xl"
                >
                  <div className="grid grid-cols-6 gap-0.5 max-h-[272px] overflow-y-auto no-scrollbar">
                    {ALL_EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => pick(emoji)}
                        className={`h-11 rounded-xl text-2xl flex items-center justify-center active:scale-90 transition-transform ${
                          msg.reactions?.me === emoji ? 'bg-indigo-600/40 ring-1 ring-indigo-400' : 'hover:bg-slate-800'
                        }`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {!moreEmoji && (
                <div
                  style={{ left: menuLeft, top: menuTop, width: MW }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute rounded-2xl bg-slate-900 border border-slate-700 overflow-hidden shadow-2xl"
                >
                  {[
                    !msg.deleted && onReply
                      ? {
                          key: 'reply',
                          label: 'Reply',
                          icon: <Reply className="w-4 h-4 text-slate-300" />,
                          danger: false,
                          run: () => {
                            onReply(msg);
                            close();
                          },
                        }
                      : null,
                    canCopy
                      ? {
                          key: 'copy',
                          label: 'Copy',
                          icon: <CopyIcon className="w-4 h-4 text-slate-300" />,
                          danger: false,
                          run: () => {
                            void copyText(msg.text as string);
                            close();
                          },
                        }
                      : null,
                    onDeleteForMe || onDeleteForEveryone
                      ? {
                          key: 'delete',
                          label: 'Delete',
                          icon: <Trash2 className="w-4 h-4" />,
                          danger: true,
                          run: () => {
                            setDeleteAsk(msg);
                            close();
                          },
                        }
                      : null,
                  ]
                    .filter((x): x is NonNullable<typeof x> => Boolean(x))
                    .map((item, i) => (
                      <button
                        key={item.key}
                        onClick={item.run}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-slate-800 ${
                          item.danger ? 'text-rose-400' : 'text-slate-100'
                        } ${i > 0 ? 'border-t border-slate-800' : ''}`}
                      >
                        {item.icon} {item.label}
                      </button>
                    ))}
                </div>
              )}
            </div>
          );
        })()}

      {/* Delete choices */}
      {deleteAsk && (
        <div className="fixed inset-0 z-[115] bg-black/60 flex items-center justify-center p-6" onClick={() => setDeleteAsk(null)}>
          <div className="w-full max-w-xs rounded-3xl bg-slate-900 border border-slate-700 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="px-1 text-base font-semibold text-white">Delete message?</h3>
            <div className="mt-3 flex flex-col gap-2">
              {deleteAsk.sender === 'me' && !deleteAsk.deleted && onDeleteForEveryone && (
                <button
                  onClick={() => {
                    onDeleteForEveryone(deleteAsk.id);
                    setDeleteAsk(null);
                  }}
                  className="w-full py-3 rounded-2xl bg-rose-600 hover:bg-rose-500 text-sm font-semibold text-white"
                >
                  Delete for everyone
                </button>
              )}
              {onDeleteForMe && (
                <button
                  onClick={() => {
                    onDeleteForMe(deleteAsk.id);
                    setDeleteAsk(null);
                  }}
                  className="w-full py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-sm font-medium text-slate-100"
                >
                  Delete for me
                </button>
              )}
              <button onClick={() => setDeleteAsk(null)} className="w-full py-3 rounded-2xl text-sm font-medium text-slate-400 hover:bg-slate-800">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Who reacted with what */}
      {reactInfo &&
        (() => {
          const m = messages.find((x) => x.id === reactInfo.id);
          const mine = m?.reactions?.me;
          const theirs = m?.reactions?.peer;
          if (!m || (!mine && !theirs)) return null;
          const vw = typeof window !== 'undefined' ? window.innerWidth : 400;
          const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
          const bounds = rootRef.current?.getBoundingClientRect();
          const minX = (bounds?.left ?? 0) + 8;
          const maxX = (bounds?.right ?? vw) - 8;
          const W = Math.min(190, Math.max(160, maxX - minX));
          const H = (mine ? 40 : 0) + (theirs ? 40 : 0) + 8;
          const left = Math.max(minX, Math.min(reactInfo.rect.left, maxX - W));
          const top = reactInfo.rect.bottom + 6 + H > vh - 8 ? reactInfo.rect.top - H - 6 : reactInfo.rect.bottom + 6;
          const close = () => setReactInfo(null);
          return (
            <div className="fixed inset-0 z-[105]" onClick={close}>
              <div
                style={{ left, top, width: W }}
                onClick={(e) => e.stopPropagation()}
                className="absolute rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl py-1"
              >
                {mine && (
                  <button
                    onClick={() => {
                      onReact?.(m.id, mine); // tapping your own reaction removes it
                      close();
                    }}
                    className="w-full flex items-center justify-between gap-3 px-3.5 h-10 hover:bg-slate-800 rounded-xl"
                    title="Tap to remove your reaction"
                  >
                    <span className="text-sm text-slate-100">You</span>
                    <span className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-500">tap to remove</span>
                      <span className="text-xl">{mine}</span>
                    </span>
                  </button>
                )}
                {theirs && (
                  <div className="w-full flex items-center justify-between gap-3 px-3.5 h-10">
                    <span className="text-sm text-slate-100 truncate">{partnerName}</span>
                    <span className="text-xl">{theirs}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

      {cameraOpen && (
        <CameraCapture
          onClose={() => setCameraOpen(false)}
          onCapture={(file) => {
            setCameraOpen(false);
            void processFiles([file]);
          }}
        />
      )}

      {/* Fullscreen photo viewer — unlimited replay while the chat is open */}
      {viewer?.imageUrl && (
        <div onClick={() => setViewer(null)} className="fixed inset-0 z-[100] bg-black flex flex-col items-center justify-between p-4 select-none">
          <div className="w-full flex items-center justify-between safe-top pt-2">
            <SaveButton msg={viewer} dark />
            <button onClick={() => setViewer(null)} className="p-2.5 rounded-full bg-white/20 text-white backdrop-blur-md" aria-label="Close">
              <X className="w-6 h-6" />
            </button>
          </div>
          <div className="flex-1 w-full max-h-[80vh] flex items-center justify-center my-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={viewer.imageUrl} alt="" draggable={false} className="max-w-full max-h-full object-contain rounded-2xl" />
          </div>
          <p className="pb-6 text-[11px] text-slate-400">This photo is deleted when the chat is closed</p>
        </div>
      )}
    </div>
  );
};
