'use client';

import { useCallback, useEffect, useState } from 'react';

// "Install app" support. Chrome/Edge/Android fire `beforeinstallprompt` once; we keep the event so the app can show
// its own Install button (the browser's address-bar icon is easy to miss). iPhone has no such event, so it gets steps.
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

const standaloneNow = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true);

export function useInstall() {
  const [canPrompt, setCanPrompt] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    const sync = () => {
      setCanPrompt(Boolean(deferred));
      setStandalone(standaloneNow());
    };
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent));
    sync();
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferred) return 'unavailable';
    const ev = deferred;
    deferred = null; // an install event can only be used once
    notify();
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    return outcome;
  }, []);

  return { canPrompt, standalone, ios, promptInstall };
}
