'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, SwitchCamera, Send } from 'lucide-react';

interface CameraCaptureProps {
  onCapture: (file: File) => void;
  onClose: () => void;
}

const MAX_RECORD_SECONDS = 5 * 60;

function pickVideoMime(): string {
  const candidates = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  if (typeof MediaRecorder === 'undefined') return '';
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
}

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

interface Captured {
  file: File;
  url: string;
  kind: 'photo' | 'video';
}

export const CameraCapture: React.FC<CameraCaptureProps> = ({ onCapture, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  const capturedUrlRef = useRef<string | null>(null);

  const [mode, setMode] = useState<'photo' | 'video'>('photo');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<Captured | null>(null); // review step before sending
  const [restartKey, setRestartKey] = useState(0);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // (Re)start the camera preview when the facing direction changes or after "retake".
  useEffect(() => {
    if (captured) return; // reviewing a capture: camera stays off
    let alive = true;
    (async () => {
      try {
        stopStream();
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setError(null);
      } catch {
        if (alive) setError('Camera access was denied or is not available. Allow it in your browser settings.');
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facing, restartKey, captured === null]);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      if (timerRef.current) clearInterval(timerRef.current);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try {
          recorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      stopStream();
      if (capturedUrlRef.current) URL.revokeObjectURL(capturedUrlRef.current);
    },
    []
  );

  const showReview = (file: File, kind: 'photo' | 'video') => {
    const url = URL.createObjectURL(file);
    capturedUrlRef.current = url;
    stopStream(); // camera light off while reviewing
    setCaptured({ file, url, kind });
  };

  // X in the review: throw the capture away and go back to the live camera
  const discard = () => {
    if (capturedUrlRef.current) URL.revokeObjectURL(capturedUrlRef.current);
    capturedUrlRef.current = null;
    setCaptured(null);
    setSeconds(0);
    setRestartKey((k) => k + 1);
  };

  const send = () => {
    if (!captured) return;
    onCapture(captured.file); // parent compresses/uploads it and closes the camera
  };

  const takePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (facing === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1); // un-mirror the selfie
    }
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) showReview(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }), 'photo');
      },
      'image/jpeg',
      0.92
    );
  };

  const startRecording = async () => {
    const base = streamRef.current;
    if (!base || typeof MediaRecorder === 'undefined') {
      setError('Video recording is not supported in this browser.');
      return;
    }
    // Ask for the microphone only now; record without audio if it is refused.
    const tracks = [...base.getVideoTracks()];
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      tracks.push(...audio.getAudioTracks());
    } catch {
      /* continue silent */
    }
    const mime = pickVideoMime();
    const recorder = new MediaRecorder(new MediaStream(tracks), {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: 2_500_000,
    });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    recorder.onstop = () => {
      tracks.filter((t) => t.kind === 'audio').forEach((t) => t.stop());
      if (cancelledRef.current || !chunksRef.current.length) return;
      const type = (recorder.mimeType || mime || 'video/mp4').split(';')[0]; // strip ";codecs=..."
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      showReview(new File(chunksRef.current, `video-${Date.now()}.${ext}`, { type }), 'video');
    };
    recorderRef.current = recorder;
    recorder.start(1000);
    setRecording(true);
    setSeconds(0);
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_RECORD_SECONDS) stopRecording();
        return s + 1;
      });
    }, 1000);
  };

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
  }, []);

  const handleShutter = () => {
    if (mode === 'photo') takePhoto();
    else if (recording) stopRecording();
    else startRecording();
  };

  // ---------- Review step: X (top-left) = discard & retake, Send (bottom-right) ----------
  if (captured) {
    return (
      <div className="fixed inset-0 z-[120] bg-black flex flex-col select-none">
        <div className="flex-1 relative overflow-hidden flex items-center justify-center bg-black">
          {captured.kind === 'photo' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={captured.url} alt="" draggable={false} className="max-w-full max-h-full object-contain" />
          ) : (
            <video
              src={captured.url}
              controls
              autoPlay
              loop
              playsInline
              controlsList="nodownload noremoteplayback"
              disablePictureInPicture
              className="max-w-full max-h-full"
            />
          )}
        </div>

        <button
          onClick={discard}
          aria-label="Discard and retake"
          className="absolute top-0 left-4 mt-[max(12px,env(safe-area-inset-top))] w-11 h-11 rounded-full bg-black/55 backdrop-blur-md text-white flex items-center justify-center active:scale-90"
        >
          <X className="w-6 h-6" />
        </button>

        <div className="absolute bottom-0 inset-x-0 px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-10 bg-gradient-to-t from-black/80 to-transparent flex items-end justify-between">
          <span className="text-xs text-white/70 pb-3">{captured.kind === 'photo' ? 'Photo' : `Video · ${fmt(seconds)}`}</span>
          <button
            onClick={send}
            aria-label="Send"
            className="w-14 h-14 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center shadow-xl shadow-indigo-900/50 active:scale-90 transition-transform"
          >
            <Send className="w-6 h-6 ml-0.5" />
          </button>
        </div>
      </div>
    );
  }

  // ---------- Live camera ----------
  return (
    <div className="fixed inset-0 z-[120] bg-black flex flex-col select-none">
      <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-4 safe-top pb-3 bg-gradient-to-b from-black/70 to-transparent">
        <button onClick={onClose} aria-label="Close camera" className="w-10 h-10 rounded-full bg-black/40 text-white flex items-center justify-center">
          <X className="w-5 h-5" />
        </button>
        {recording && (
          <span className="flex items-center gap-2 px-3 py-1 rounded-full bg-black/50 text-white text-xs font-mono">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            {fmt(seconds)}
          </span>
        )}
        <button
          onClick={() => !recording && setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
          disabled={recording}
          aria-label="Flip camera"
          className="w-10 h-10 rounded-full bg-black/40 text-white flex items-center justify-center disabled:opacity-40"
        >
          <SwitchCamera className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-slate-300">{error}</div>
        ) : (
          <video ref={videoRef} autoPlay playsInline muted className={`w-full h-full object-cover ${facing === 'user' ? 'scale-x-[-1]' : ''}`} />
        )}
      </div>

      <div className="absolute bottom-0 inset-x-0 z-10 pb-8 pt-6 bg-gradient-to-t from-black/80 to-transparent flex flex-col items-center gap-5 safe-bottom">
        <div className="flex items-center gap-6 text-sm font-semibold tracking-wide">
          {(['photo', 'video'] as const).map((m) => (
            <button
              key={m}
              disabled={recording}
              onClick={() => setMode(m)}
              className={`uppercase transition-colors ${mode === m ? 'text-white' : 'text-white/50'} disabled:opacity-60`}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={handleShutter}
          disabled={Boolean(error)}
          aria-label={mode === 'photo' ? 'Take photo' : recording ? 'Stop recording' : 'Start recording'}
          className="w-[72px] h-[72px] rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40"
        >
          {mode === 'photo' ? (
            <span className="w-14 h-14 rounded-full bg-white" />
          ) : recording ? (
            <span className="w-7 h-7 rounded-md bg-rose-500" />
          ) : (
            <span className="w-14 h-14 rounded-full bg-rose-500" />
          )}
        </button>
      </div>
    </div>
  );
};
