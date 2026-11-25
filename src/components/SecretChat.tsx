'use client';

import React, { useEffect, useState } from 'react';
import { usePermanentP2P } from '@/hooks/usePermanentP2P';
import { VideoPlayer, RemoteAudio } from '@/components/VideoPlayer';
import { CallControls } from '@/components/CallControls';
import { ChatSheet } from '@/components/ChatSheet';
import { useScreenProtection } from '@/hooks/useScreenProtection';
import { backendUrl } from '@/lib/backend';
import { useChatTheme } from '@/lib/chatTheme';
import {
  Copy,
  Check,
  Share2,
  Video,
  PhoneCall,
  PhoneOff,
  PhoneIncoming,
  Lock,
  Wifi,
  WifiOff,
  Trash2,
  ShieldCheck,
  Sparkles,
  Smartphone,
  MessageSquare,
  Flame,
  Bell,
  PhoneMissed,
  PhoneOutgoing,
  Phone,
  Settings,
  Camera,
} from 'lucide-react';

// "just now" / "5 min ago" / "2 h ago" / "yesterday 9:40 PM" / "12 Nov, 9:40 PM"
function formatLastSeen(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 6) return `${hours} h ago`;
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  const yesterday = new Date(now - 86400000);
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

export function SecretChat({ active, onLock }: { active: boolean; onLock: () => void }) {
  const {
    isReady,
    myId,
    partnerId,
    isPartnerOnline,
    partnerLastSeen,
    callState,
    isVideoCall,
    callDuration,
    localStream,
    remoteStream,
    isAudioMuted,
    isVideoMuted,
    isFrontCamera,
    partnerMediaStatus,
    messages,
    socketConnected,
    notice,
    dismissNotice,
    showNotice,
    replyTarget,
    startReply,
    cancelReply,
    reactToMessage,
    deleteForMe,
    deleteForEveryone,
    callHistory,
    notificationState,
    enableNotifications,
    testNotification,
    primeMediaPermissions,
    setChatActive,
    unseenCount,
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
  } = usePermanentP2P();

  const [inputCode, setInputCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isPipSmall, setIsPipSmall] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [chatTheme, setChatTheme] = useChatTheme(); // 'light' (warm white) or 'dark' (black)
  // Re-render every 30 s so "Last seen 5 min ago" stays current
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const [status, setStatus] = useState<{ database: boolean; cloud: { configured: boolean; ok: boolean; error: string | null }; push: boolean } | null>(null);

  useEffect(() => {
    if (!showSettings) return;
    setStatus(null);
    fetch(backendUrl('/api/status'))
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [showSettings]);

  // Tell the hook when the chat is really open: "seen" only counts then, and the server re-sends anything still unseen.
  // While a call is on, the messages are only "on screen" when the chat sheet is open over the video.
  const inCallView = callState === 'connected' || callState === 'calling';
  const messagesOnScreen = active && (callState === 'idle' ? true : inCallView ? isChatOpen : false);
  useEffect(() => {
    setChatActive(active, messagesOnScreen);
  }, [active, messagesOnScreen, setChatActive]);

  // Notifications are on by default: browsers only allow the permission prompt after a tap, so ask on the first tap
  // once the chat is open (and again on later visits until the person answers).
  useEffect(() => {
    if (!active) return;
    // One go on the first tap: notifications, and camera + microphone together. Each prompt is skipped when already answered.
    const ask = () => {
      // Not chained: a prompt that is simply ignored must never stop the other one from being asked.
      if (notificationState === 'default') enableNotifications();
      primeMediaPermissions();
    };
    // `click` (not pointerdown): on phones the browser only counts a finished tap as a real user gesture.
    document.addEventListener('click', ask, { once: true });
    return () => document.removeEventListener('click', ask);
  }, [active, notificationState, enableNotifications, primeMediaPermissions]);

  // Blur + report when someone tries to screenshot while chat or a call is on screen
  useScreenProtection(active && (Boolean(partnerId) || callState !== 'idle'), reportScreenshot);

  // Auto-lock shortly after the app goes to the background (never during a call).
  const callStateForLock = React.useRef(callState);
  callStateForLock.current = callState;
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onVis = () => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => {
          if (callStateForLock.current === 'idle') {
            clearChat();
            onLock();
          }
        }, 8000);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [active, clearChat, onLock]);

  // Keep the app exactly as tall as the visible area, so the message box rides above the keyboard
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
      if (vv.offsetTop) window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.documentElement.style.removeProperty('--app-h');
    };
  }, []);

  // The settings panel starts exactly below the header (header height varies with notches)
  const headerRef = React.useRef<HTMLDivElement>(null);
  const [headerH, setHeaderH] = useState(64);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setHeaderH(el.offsetHeight);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [partnerId, showSettings]);

  if (!isReady) {
    return (
      <div data-chat-theme={chatTheme} className="flex-1 flex flex-col items-center justify-center p-6 bg-slate-950 text-slate-400">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-xs">Loading…</p>
      </div>
    );
  }

  const handleCopyMyCode = async () => {
    try {
      await navigator.clipboard.writeText(myId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error(e);
    }
  };

  const handleShareMyCode = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'My pairing code',
          text: `My pairing code is ${myId}. Enter it in the app to connect with me.`,
          url: typeof window !== 'undefined' ? window.location.origin : '',
        });
      } catch (e) {}
    } else {
      handleCopyMyCode();
    }
  };

  const handlePairSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputCode.trim()) {
      pairWithPartner(inputCode);
      setInputCode('');
    }
  };

  const toast = notice ? (
    <div
      onClick={dismissNotice}
      className="fixed top-[max(12px,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[100] max-w-[90%] px-4 py-2.5 rounded-2xl bg-slate-800/95 border border-slate-600 text-xs text-slate-100 shadow-2xl backdrop-blur-md"
    >
      {notice}
    </div>
  ) : null;

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // ==========================================
  // VIEW 1: ACTIVE VIDEO CALL (Connected or Calling)
  // ==========================================
  if (callState === 'connected' || callState === 'calling') {
    return (
      <div data-chat-theme="dark" className="relative flex-1 flex flex-col h-[var(--app-h,100dvh)] min-h-0 bg-slate-950 overflow-hidden select-none">
        {toast}
        {/* Top Status Header */}
        <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 via-black/40 to-transparent safe-top">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-bold text-slate-300 bg-black/60 px-2.5 py-1 rounded-full border border-white/10">
              {partnerId}
            </span>
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/50 backdrop-blur-md border border-white/10 text-xs">
            {callState === 'connected' ? (
              <>
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-mono font-medium text-emerald-400">
                  {formatTimer(callDuration)}
                </span>
                <span className="text-slate-400 text-[10px] font-mono">| P2P</span>
              </>
            ) : (
              <>
                <div className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-ping" />
                <span className="text-amber-300 font-medium text-xs">Ringing…</span>
              </>
            )}
          </div>

          <button
            onClick={() => setIsChatOpen(true)}
            aria-label={unseenCount > 0 ? `${unseenCount} new messages` : 'Chat'}
            className="relative p-2 rounded-full bg-black/50 border border-white/10 text-white"
          >
            <MessageSquare className="w-4 h-4" />
            {unseenCount > 0 && !isChatOpen && (
              <span className="absolute -top-1.5 -right-1.5 bg-rose-500 text-white text-[10px] font-bold h-4 min-w-[16px] px-1 rounded-full flex items-center justify-center border border-slate-950 animate-pulse">
                {unseenCount > 9 ? '9+' : unseenCount}
              </span>
            )}
          </button>
        </div>

        <RemoteAudio stream={remoteStream} />

        {/* Video Canvas */}
        <div className="relative flex-1 min-h-0 w-full bg-slate-950 flex items-center justify-center overflow-hidden">
          {remoteStream && callState === 'connected' ? (
            <VideoPlayer
              silent
              fit="contain"
              stream={remoteStream}
              userName="Partner"
              isMuted={!partnerMediaStatus.audio}
              isVideoDisabled={!partnerMediaStatus.video}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="text-center p-6 flex flex-col items-center">
              <div className="w-24 h-24 rounded-full bg-indigo-600/20 border-2 border-indigo-500/40 flex items-center justify-center mb-4 relative">
                <div className="w-16 h-16 rounded-full bg-indigo-600/30 animate-ping absolute" />
                <PhoneCall className="w-10 h-10 text-indigo-400 relative z-10" />
              </div>
              <h2 className="text-base font-bold text-white">
                {callState === 'connected' ? 'Connecting…' : `Calling ${partnerId}…`}
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                {callState === 'connected' ? 'Setting up a secure peer-to-peer link' : 'Waiting for your partner to answer'}
              </p>
            </div>
          )}

          {/* Self Camera Picture-in-Picture (PIP) */}
          <div
            onClick={() => setIsPipSmall((prev) => !prev)}
            className={`absolute z-20 transition-all duration-300 cursor-pointer overflow-hidden rounded-2xl shadow-2xl border border-white/20 bg-slate-900 ${
              isPipSmall
                ? 'top-16 right-4 w-28 h-40 sm:w-32 sm:h-48'
                : 'top-16 right-4 w-44 h-64 sm:w-52 sm:h-72'
            }`}
          >
            <VideoPlayer
              stream={localStream}
              isSelf
              isMirrored={isFrontCamera}
              isVideoDisabled={isVideoMuted}
              isMuted={isAudioMuted}
              userName={myId}
              compact
              className="w-full h-full object-cover"
            />
          </div>
        </div>

        {/* Call Dock Controls */}
        <CallControls
          isAudioMuted={isAudioMuted}
          isVideoMuted={isVideoMuted}
          onToggleAudio={toggleAudio}
          onToggleVideo={toggleVideo}
          onSwitchCamera={switchCamera}
          onEndCall={endCall}
          onToggleChat={() => setIsChatOpen((p) => !p)}
          isChatOpen={isChatOpen}
          unreadCount={unseenCount}
        />

        {/* Sliding P2P Chat (Snapchat Style) */}
        <ChatSheet
          isOpen={isChatOpen}
          keepOnClose
          onClose={() => setIsChatOpen(false)}
          messages={messages}
          onSendMessage={sendMessage}
          onSendPhoto={sendPhoto}
          onSendVideo={sendVideo}
          onSaveMedia={saveMedia}
        onNotice={showNotice}
        partnerOnline={isPartnerOnline}
        connected={socketConnected}
        replyTarget={replyTarget}
        onReply={startReply}
        onCancelReply={cancelReply}
        onReact={reactToMessage}
        onDeleteForMe={deleteForMe}
        onDeleteForEveryone={deleteForEveryone}
          onClearChat={clearChat}
          partnerName={partnerId || 'Partner'}
        />
      </div>
    );
  }

  // ==========================================
  // VIEW 2: INCOMING CALL MODAL
  // ==========================================
  if (callState === 'incoming') {
    return (
      <div data-chat-theme={chatTheme} className="flex-1 flex flex-col items-center justify-between p-6 safe-top safe-bottom bg-gradient-to-b from-indigo-950 via-slate-950 to-slate-900 text-slate-100">
        {toast}
        <div className="pt-8 text-center">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-semibold mb-4 border border-emerald-500/30">
            <PhoneIncoming className="w-3.5 h-3.5 animate-bounce" />
            <span>{isVideoCall ? 'Incoming Video Call' : 'Incoming Voice Call'}</span>
          </div>
          <h1 className="text-2xl font-extrabold text-white">{partnerId}</h1>
          <p className="text-xs text-slate-400 mt-1">Your partner is calling</p>
        </div>

        {/* Animated Radar Pulse */}
        <div className="relative flex items-center justify-center my-10">
          <div className="w-40 h-40 rounded-full bg-emerald-500/10 animate-ping absolute" />
          <div className="w-28 h-28 rounded-full bg-emerald-500/20 animate-pulse absolute" />
          <div className="w-20 h-20 rounded-full bg-emerald-600 flex items-center justify-center shadow-xl shadow-emerald-600/50">
            {isVideoCall ? <Video className="w-10 h-10 text-white" /> : <Phone className="w-10 h-10 text-white" />}
          </div>
        </div>

        {/* Accept / Decline Action Buttons */}
        <div className="w-full flex items-center justify-around gap-6 pb-8">
          <button
            onClick={declineCall}
            className="flex flex-col items-center gap-2 group"
          >
            <div className="w-16 h-16 rounded-full bg-rose-600 group-hover:bg-rose-700 flex items-center justify-center shadow-xl shadow-rose-900/50 active:scale-95 transition-all">
              <PhoneOff className="w-7 h-7 text-white" />
            </div>
            <span className="text-xs text-rose-300 font-medium">Decline</span>
          </button>

          <button
            onClick={acceptCall}
            className="flex flex-col items-center gap-2 group"
          >
            <div className="w-16 h-16 rounded-full bg-emerald-600 group-hover:bg-emerald-700 flex items-center justify-center shadow-xl shadow-emerald-600/50 animate-bounce active:scale-95 transition-all">
              <PhoneCall className="w-7 h-7 text-white" />
            </div>
            <span className="text-xs text-emerald-300 font-medium">Accept Call</span>
          </button>
        </div>
      </div>
    );
  }

  // ==========================================
  // VIEW 3: NOT PAIRED YET (one-time setup)
  // ==========================================
  if (!partnerId) {
    return (
      <div data-chat-theme={chatTheme} className="flex-1 flex flex-col p-5 safe-top safe-bottom bg-gradient-to-b from-slate-950 via-slate-900 to-indigo-950 text-slate-100 overflow-y-auto no-scrollbar h-[var(--app-h,100dvh)]">
        {toast}

        <div className="flex items-center justify-between pt-2 mb-8">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/30">
              <Lock className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white leading-tight">Connect a partner</h1>
              <p className="text-xs text-slate-400">One-time pairing</p>
            </div>
          </div>
          <div
            className={`px-2.5 py-1 rounded-full border text-[11px] font-medium flex items-center gap-1.5 ${
              socketConnected
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${socketConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
            {socketConnected ? 'Online' : 'Connecting…'}
          </div>
        </div>

        {/* Your code */}
        <section className="bg-slate-900/80 border border-slate-800 rounded-3xl p-5 mb-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Your code</p>
          <div className="flex items-center justify-between gap-2 rounded-2xl bg-slate-950 border border-slate-800 px-4 py-3">
            <span className="text-xl font-bold tracking-widest font-mono text-white">{myId}</span>
            <button
              onClick={handleCopyMyCode}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 px-3 py-2 rounded-xl"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            onClick={handleShareMyCode}
            className="mt-3 w-full py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.99]"
          >
            <Share2 className="w-4 h-4" />
            Share my code
          </button>
        </section>

        <div className="flex items-center gap-3 mb-5 text-[11px] uppercase tracking-wider text-slate-500">
          <span className="h-px flex-1 bg-slate-800" />
          or
          <span className="h-px flex-1 bg-slate-800" />
        </div>

        {/* Partner's code */}
        <form onSubmit={handlePairSubmit} className="bg-slate-900/80 border border-slate-800 rounded-3xl p-5">
          <label htmlFor="partner-code" className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
            Partner&apos;s code
          </label>
          <input
            id="partner-code"
            type="text"
            value={inputCode}
            onChange={(e) => setInputCode(e.target.value.toUpperCase())}
            placeholder="P2P-XXXXXX"
            autoComplete="off"
            autoCapitalize="characters"
            className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-base font-mono tracking-wider text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!inputCode.trim() || !socketConnected}
            className="mt-3 w-full py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-semibold flex items-center justify-center gap-2 active:scale-[0.99]"
          >
            <Lock className="w-4 h-4" />
            Pair permanently
          </button>
        </form>

        <p className="mt-6 flex items-start gap-2 text-xs text-slate-500 leading-relaxed">
          <ShieldCheck className="w-4 h-4 text-emerald-500/70 flex-shrink-0 mt-0.5" />
          Pair once and stay connected. Messages, photos and videos disappear when the chat is closed.
        </p>
      </div>
    );
  }

  // ==========================================
  // VIEW 4: PERMANENTLY PAIRED — WhatsApp/Snapchat-style single screen
  //   header: name + online/offline · middle: chat · bottom: message box
  // ==========================================
  return (
    <div data-chat-theme={chatTheme} className="relative flex-1 flex flex-col min-h-0 h-[var(--app-h,100dvh)] bg-gradient-to-b from-slate-950 via-slate-900 to-indigo-950 text-slate-100 overflow-hidden">
      {toast}

      {/* Header */}
      <div ref={headerRef} className="flex items-center justify-between gap-2 px-3 pb-2 safe-top border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative w-11 h-11 max-[359px]:w-9 max-[359px]:h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0 max-[419px]:hidden">
            <Smartphone className="w-5 h-5 text-indigo-400" />
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-slate-950 ${
                isPartnerOnline ? 'bg-emerald-500' : 'bg-slate-500'
              }`}
            />
          </div>
          <div className="min-w-0 leading-tight">
            <p className="text-sm font-bold font-mono tracking-wide truncate">{partnerId}</p>
            <p className={`text-[11px] ${isPartnerOnline ? 'text-emerald-400' : 'text-slate-500'}`}>
              {!socketConnected
                ? 'Connecting…'
                : isPartnerOnline
                  ? 'Online'
                  : partnerLastSeen
                    ? `Last seen ${formatLastSeen(partnerLastSeen, nowTick)}`
                    : 'Offline'}
            </p>
          </div>
        </div>

        <button
          onClick={() => setConfirmClear(true)}
          aria-label="Clear chat"
          title="Clear chat"
          className="w-11 h-11 max-[359px]:w-9 max-[359px]:h-9 rounded-full flex-shrink-0 text-slate-400 hover:text-rose-400 hover:bg-slate-800 flex items-center justify-center active:scale-90 transition"
        >
          <Trash2 className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => startCall(false)}
            disabled={!isPartnerOnline}
            aria-label="Voice call"
            className="w-11 h-11 max-[359px]:w-9 max-[359px]:h-9 rounded-full text-slate-200 hover:bg-slate-800 flex items-center justify-center disabled:opacity-35 active:scale-90 transition-transform"
          >
            <Phone className="w-5 h-5" />
          </button>
          <button
            onClick={() => startCall(true)}
            disabled={!isPartnerOnline}
            aria-label="Video call"
            className="w-11 h-11 max-[359px]:w-9 max-[359px]:h-9 rounded-full text-emerald-400 hover:bg-slate-800 flex items-center justify-center disabled:opacity-35 active:scale-90 transition-transform"
          >
            <Video className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            aria-label="Settings"
            className={`w-11 h-11 max-[359px]:w-9 max-[359px]:h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform ${
              showSettings ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Chat fills the middle, message box sits at the bottom */}
      <ChatSheet
        variant="inline"
        isOpen
        onClose={() => {}}
        messages={messages}
        onSendMessage={sendMessage}
        onSendPhoto={sendPhoto}
        onSendVideo={sendVideo}
        onSaveMedia={saveMedia}
        onNotice={showNotice}
        partnerOnline={isPartnerOnline}
        connected={socketConnected}
        replyTarget={replyTarget}
        onReply={startReply}
        onCancelReply={cancelReply}
        onReact={reactToMessage}
        onDeleteForMe={deleteForMe}
        onDeleteForEveryone={deleteForEveryone}
        onClearChat={clearChat}
        partnerName={partnerId || 'Partner'}
      />

      {/* Clear-chat confirmation */}
      {confirmClear && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-6" onClick={() => setConfirmClear(false)}>
          <div className="w-full max-w-sm rounded-3xl bg-slate-900 border border-slate-700 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">Clear chat?</h3>
            <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">
              This removes all messages, photos and videos from this device. Your partner&apos;s chat is not affected, and you stay connected.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button onClick={() => setConfirmClear(false)} className="py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-sm font-medium text-slate-200">
                Cancel
              </button>
              <button
                onClick={() => {
                  clearChat();
                  setConfirmClear(false);
                }}
                className="py-3 rounded-2xl bg-rose-600 hover:bg-rose-500 text-sm font-semibold text-white"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings drop-down (covers the chat area only) */}
      {showSettings && (
        <div style={{ top: headerH }} className="absolute inset-x-0 bottom-0 z-40 bg-slate-950/98 backdrop-blur-xl overflow-y-auto overflow-x-hidden no-scrollbar p-4 space-y-4">
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4">
            <p className="text-[11px] text-slate-400 mb-1">Your permanent code</p>
            <div className="flex items-center justify-between">
              <span className="font-mono font-bold tracking-widest">{myId}</span>
              <button onClick={handleCopyMyCode} className="text-xs text-indigo-300 flex items-center gap-1">
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Connection status */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4">
            <h4 className="text-xs font-semibold text-slate-300 mb-3">Connection status</h4>
            {(() => {
              const Row = ({ label, state, detail }: { label: string; state: 'ok' | 'bad' | 'off' | 'wait'; detail?: string }) => (
                <div className="flex items-center justify-between py-1.5 text-xs">
                  <span className="text-slate-300">{label}</span>
                  <span
                    className={`flex items-center gap-1.5 ${
                      state === 'ok' ? 'text-emerald-400' : state === 'bad' ? 'text-rose-400' : state === 'wait' ? 'text-slate-500' : 'text-amber-400'
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${
                        state === 'ok' ? 'bg-emerald-500' : state === 'bad' ? 'bg-rose-500' : state === 'wait' ? 'bg-slate-600 animate-pulse' : 'bg-amber-500'
                      }`}
                    />
                    {detail}
                  </span>
                </div>
              );
              return (
                <>
                  <Row label="Server" state={socketConnected ? 'ok' : 'bad'} detail={socketConnected ? 'Connected' : 'Disconnected'} />
                  <Row label="Database" state={!status ? 'wait' : status.database ? 'ok' : 'bad'} detail={!status ? 'Checking…' : status.database ? 'Connected' : 'Unreachable'} />
                  <Row
                    label="Cloud storage"
                    state={!status ? 'wait' : !status.cloud.configured ? 'off' : status.cloud.ok ? 'ok' : 'bad'}
                    detail={!status ? 'Checking…' : !status.cloud.configured ? 'Not configured' : status.cloud.ok ? 'Connected' : status.cloud.error || 'Unreachable'}
                  />
                  <Row label="Notifications" state={!status ? 'wait' : status.push ? 'ok' : 'off'} detail={!status ? 'Checking…' : status.push ? 'Enabled' : 'Not configured'} />
                </>
              );
            })()}
          </div>

          <button
            onClick={() => {
              clearChat();
              setShowSettings(false);
            }}
            className="w-full py-3 rounded-2xl bg-slate-900/80 border border-slate-800 text-slate-200 text-xs font-medium flex items-center justify-center gap-2"
          >
            <Flame className="w-4 h-4 text-rose-400" />
            <span>Clear chat (connection stays)</span>
          </button>

          <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4 space-y-2.5">
            <p className="text-xs font-semibold text-slate-300">Theme</p>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Chat theme">
              {(['light', 'dark'] as const).map((t) => (
                <button
                  key={t}
                  role="radio"
                  aria-checked={chatTheme === t}
                  onClick={() => setChatTheme(t)}
                  className={`py-3 rounded-2xl border text-xs font-semibold flex items-center justify-center gap-2 active:scale-[0.98] ${
                    chatTheme === t
                      ? 'border-indigo-500 ring-2 ring-indigo-400 bg-slate-800 text-slate-100'
                      : 'border-slate-700 bg-slate-900 text-slate-400'
                  }`}
                >
                  <span className={`w-4 h-4 rounded-full border ${t === 'light' ? 'bg-[#FAF7F2] border-slate-500' : 'bg-black border-slate-500'}`} />
                  {t === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300 flex items-center gap-2">
                <Bell className="w-4 h-4 text-indigo-400" /> Notifications on this device
              </span>
              <span
                className={
                  notificationState === 'granted'
                    ? 'text-emerald-400'
                    : notificationState === 'denied'
                      ? 'text-rose-400'
                      : 'text-slate-400'
                }
              >
                {notificationState === 'granted'
                  ? 'Allowed'
                  : notificationState === 'denied'
                    ? 'Blocked'
                    : notificationState === 'unsupported'
                      ? 'Not available here'
                      : 'Not asked yet'}
              </span>
            </div>
            <button
              onClick={testNotification}
              className="w-full py-3 rounded-2xl bg-indigo-600/20 border border-indigo-500/40 text-indigo-300 text-xs font-medium flex items-center justify-center gap-2 active:scale-[0.99]"
            >
              <Bell className="w-4 h-4" />
              <span>{notificationState === 'granted' ? 'Send test notification' : 'Turn on notifications'}</span>
            </button>
            {notificationState === 'denied' && (
              <p className="text-[11px] text-slate-500 leading-snug">
                Blocked in the browser. Tap the lock icon next to the address, open Notifications and choose Allow.
              </p>
            )}
          </div>

          {callHistory.length > 0 && (
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4">
              <h4 className="text-xs font-semibold text-slate-300 mb-2">Recent Calls</h4>
              <ul className="space-y-2">
                {callHistory.slice(0, 6).map((c) => {
                  const outgoing = c.caller_id === myId;
                  const missed = c.status === 'missed' || c.status === 'declined';
                  const Icon = missed ? PhoneMissed : outgoing ? PhoneOutgoing : PhoneIncoming;
                  return (
                    <li key={c.id} className="flex items-center justify-between text-[11px]">
                      <span className={`flex items-center gap-2 ${missed ? 'text-rose-400' : 'text-slate-300'}`}>
                        <Icon className="w-3.5 h-3.5" />
                        {missed ? (outgoing ? 'Not answered' : 'Missed call') : outgoing ? 'Outgoing' : 'Incoming'}
                        {c.duration_s > 0 && <span className="text-slate-500">· {formatTimer(c.duration_s)}</span>}
                      </span>
                      <span className="text-slate-500">
                        {new Date(c.started_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <p className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500/70" /> Permanent link · screenshots protected
          </p>

          <div className="pt-2 text-center">
            {confirmUnpair ? (
              <div className="inline-flex flex-col items-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3">
                <p className="text-xs text-rose-200">Unpairing permanently disconnects you both. Continue?</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setConfirmUnpair(false);
                      setShowSettings(false);
                      unpair();
                    }}
                    className="text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-xl px-4 py-2"
                  >
                    Yes, unpair
                  </button>
                  <button
                    onClick={() => setConfirmUnpair(false)}
                    className="text-xs font-semibold text-slate-200 bg-slate-700/70 hover:bg-slate-600 rounded-xl px-4 py-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmUnpair(true)}
                className="inline-flex items-center gap-1.5 text-xs text-rose-400/80 hover:text-rose-400 py-2 px-3 rounded-xl hover:bg-rose-500/10"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Unpair</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
