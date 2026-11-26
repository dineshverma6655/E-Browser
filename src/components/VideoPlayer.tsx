'use client';

import React, { useEffect, useRef } from 'react';
import { MicOff, VideoOff, User } from 'lucide-react';

interface VideoPlayerProps {
  stream: MediaStream | null;
  isMuted?: boolean;
  isVideoDisabled?: boolean;
  isMirrored?: boolean;
  userName?: string;
  isSelf?: boolean;
  /** small tile (picture-in-picture): icon only, no text */
  compact?: boolean;
  /** do not play this stream's audio from the <video> (a separate <audio> element plays it) */
  silent?: boolean;
  /** 'cover' fills the box (crops the edges); 'contain' shows the WHOLE picture (nothing cut off) */
  fit?: 'cover' | 'contain';
  className?: string;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  stream,
  isMuted = false,
  isVideoDisabled = false,
  isMirrored = false,
  userName = 'User',
  isSelf = false,
  compact = false,
  silent = false,
  fit = 'cover',
  className = '',
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const hasVideo = stream && stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
  const showVideoPlaceholder = isVideoDisabled || !hasVideo;

  return (
    <div className={`relative overflow-hidden bg-slate-900 flex items-center justify-center select-none ${className}`}>
      {/* Video Stream Element */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isSelf || silent} // Always mute local video to avoid acoustic feedback
        className={`w-full h-full ${fit === 'contain' ? 'object-contain' : 'object-cover'} transition-opacity duration-300 ${
          isMirrored ? 'scale-x-[-1]' : ''
        } ${showVideoPlaceholder ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      />

      {/* Video Disabled / Camera Off Fallback */}
      {showVideoPlaceholder && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-slate-900 via-slate-950 to-indigo-950 text-slate-300 p-3">
          <div
            className={`rounded-full bg-slate-800/80 border border-slate-700/60 flex items-center justify-center shadow-xl relative ${
              compact ? 'w-12 h-12' : 'w-20 h-20 mb-3'
            }`}
          >
            <User className={compact ? 'w-6 h-6 text-slate-400' : 'w-10 h-10 text-slate-400'} />
            {isMuted && (
              <span className="absolute bottom-0 right-0 p-1 bg-rose-500 rounded-full text-white shadow-md">
                <MicOff className="w-3 h-3" />
              </span>
            )}
          </div>
          {!compact && (
            <>
              <p className="font-medium text-slate-200 text-sm tracking-wide">{isSelf ? 'Your camera is off' : userName}</p>
              <span className="text-xs text-slate-500 mt-1 flex items-center gap-1.5">
                <VideoOff className="w-3 h-3" /> Camera off
              </span>
            </>
          )}
        </div>
      )}

      {/* Overlay status chips */}
      {compact ? (
        isSelf && (
          <span className="absolute bottom-1.5 left-1.5 text-[9px] font-bold bg-indigo-500/90 text-white px-1.5 py-0.5 rounded-full pointer-events-none">YOU</span>
        )
      ) : (
        <div className="absolute bottom-3 left-3 flex items-center gap-2 pointer-events-none">
          <div className="px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md text-white text-xs font-medium flex items-center gap-1.5 shadow-md">
            <span>{userName}</span>
            {isSelf && <span className="text-[10px] bg-indigo-500/80 text-white px-1.5 py-0.5 rounded-full font-bold">YOU</span>}
          </div>
          {isMuted && (
            <div className="p-1 rounded-full bg-rose-500/90 text-white shadow-md">
              <MicOff className="w-3.5 h-3.5" />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Plays the partner's audio through a dedicated <audio> element. Audio elements keep playing when the screen locks or the
 * app goes to the background (a <video> element is often paused by the browser), so calls stay audible.
 */
export const RemoteAudio: React.FC<{ stream: MediaStream | null; speakerOn?: boolean }> = ({ stream, speakerOn = true }) => {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
      ref.current.play().catch(() => {});
    }
  }, [stream]);

  // Earpiece (held to the ear) vs loudspeaker. Browsers have no single standard for this, so try each route that exists.
  useEffect(() => {
    // iOS Safari / newer browsers: 'play-and-record' uses the earpiece, 'playback' uses the loudspeaker
    try {
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = speakerOn ? 'playback' : 'play-and-record';
    } catch {}

    // Chrome/Android (and desktop): pick the matching output device when the browser lists one
    const el = ref.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!el || typeof el.setSinkId !== 'function' || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (cancelled) return;
        const outs = devices.filter((d) => d.kind === 'audiooutput');
        const earpiece = outs.find((d) => /earpiece|receiver|handset|phone/i.test(d.label));
        const speaker = outs.find((d) => /speaker/i.test(d.label) && !/earpiece|receiver|handset/i.test(d.label));
        const target = speakerOn ? speaker?.deviceId ?? 'default' : earpiece?.deviceId;
        if (target !== undefined) el.setSinkId!(target).catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [speakerOn, stream]);

  return <audio ref={ref} autoPlay playsInline className="hidden" />;
};
