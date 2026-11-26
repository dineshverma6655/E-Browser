'use client';

import React from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  SwitchCamera,
  MessageSquare,
  Volume2,
  Phone,
} from 'lucide-react';

interface CallControlsProps {
  isAudioMuted: boolean;
  isVideoMuted: boolean;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onSwitchCamera: () => void;
  onEndCall: () => void;
  onToggleChat: () => void;
  isChatOpen: boolean;
  unreadCount?: number;
  isSpeakerOn: boolean;
  onToggleSpeaker: () => void;
}

export const CallControls: React.FC<CallControlsProps> = ({
  isAudioMuted,
  isVideoMuted,
  onToggleAudio,
  onToggleVideo,
  onSwitchCamera,
  onEndCall,
  onToggleChat,
  isChatOpen,
  unreadCount = 0,
  isSpeakerOn,
  onToggleSpeaker,
}) => {
  return (
    <div className="px-4 py-3 pb-6 bg-gradient-to-t from-black via-black/80 to-transparent flex items-center justify-between gap-2 max-w-md w-full mx-auto select-none safe-bottom">
      {/* Mic Mute / Unmute */}
      <button
        onClick={onToggleAudio}
        aria-label={isAudioMuted ? 'Unmute Mic' : 'Mute Mic'}
        className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 active:scale-95 shadow-lg ${
          isAudioMuted
            ? 'bg-rose-500/90 text-white hover:bg-rose-600'
            : 'bg-slate-800/80 text-white hover:bg-slate-700/80 border border-slate-700/40 backdrop-blur-md'
        }`}
      >
        {isAudioMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
      </button>

      {/* Video Camera Toggle */}
      <button
        onClick={onToggleVideo}
        aria-label={isVideoMuted ? 'Turn Camera On' : 'Turn Camera Off'}
        className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 active:scale-95 shadow-lg ${
          isVideoMuted
            ? 'bg-rose-500/90 text-white hover:bg-rose-600'
            : 'bg-slate-800/80 text-white hover:bg-slate-700/80 border border-slate-700/40 backdrop-blur-md'
        }`}
      >
        {isVideoMuted ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
      </button>

      {/* Speaker (loud) / Earpiece (hold to ear) */}
      <button
        onClick={onToggleSpeaker}
        aria-label={isSpeakerOn ? 'Switch to earpiece' : 'Switch to speaker'}
        title={isSpeakerOn ? 'Speaker on' : 'Earpiece'}
        className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 active:scale-95 shadow-lg ${
          isSpeakerOn
            ? 'bg-indigo-600 text-white'
            : 'bg-slate-800/80 text-white hover:bg-slate-700/80 border border-slate-700/40 backdrop-blur-md'
        }`}
      >
        {isSpeakerOn ? <Volume2 className="w-5 h-5" /> : <Phone className="w-5 h-5" />}
      </button>

      {/* Flip Front / Back Camera (Mobile Feature) */}
      <button
        onClick={onSwitchCamera}
        aria-label="Flip Camera"
        className="w-12 h-12 rounded-full flex items-center justify-center bg-slate-800/80 text-white hover:bg-slate-700/80 border border-slate-700/40 backdrop-blur-md transition-all duration-200 active:scale-95 shadow-lg"
      >
        <SwitchCamera className="w-5 h-5" />
      </button>

      {/* Chat Drawer Toggle Button */}
      <button
        onClick={onToggleChat}
        aria-label="Chat"
        className={`relative w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 active:scale-95 shadow-lg ${
          isChatOpen
            ? 'bg-indigo-600 text-white'
            : 'bg-slate-800/80 text-white hover:bg-slate-700/80 border border-slate-700/40 backdrop-blur-md'
        }`}
      >
        <MessageSquare className="w-5 h-5" />
        {unreadCount > 0 && !isChatOpen && (
          <span className="absolute -top-1 -right-1 bg-indigo-500 text-white text-[11px] font-bold h-5 min-w-[20px] px-1 rounded-full flex items-center justify-center border-2 border-slate-950">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* End Call Button */}
      <button
        onClick={onEndCall}
        aria-label="End Call"
        className="w-14 h-14 rounded-full flex items-center justify-center bg-rose-600 hover:bg-rose-700 text-white shadow-xl shadow-rose-900/50 transition-all duration-200 active:scale-90"
      >
        <PhoneOff className="w-6 h-6" />
      </button>
    </div>
  );
};
