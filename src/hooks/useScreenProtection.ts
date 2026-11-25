'use client';

import { useEffect } from 'react';

/**
 * Best-effort screenshot / screen-record deterrent for a WEB app.
 * A browser can NOT truly block the OS screenshot (only a native app can, via FLAG_SECURE on Android).
 * What this does:
 *  - blurs the whole app when the page loses focus / goes to background (app-switcher, notification shade, Win+Shift+S overlay)
 *  - catches PrintScreen / Cmd+Shift+3/4/5 keys, blurs, clears clipboard and reports the attempt to the partner
 *  - disables context menu, long-press save, drag, text selection and printing
 */
export function useScreenProtection(active: boolean, onAttempt?: () => void) {
  useEffect(() => {
    const root = document.documentElement;
    if (!active) {
      delete root.dataset.shield;
      return;
    }

    let attemptTimer: ReturnType<typeof setTimeout> | null = null;
    const shield = (on: boolean) => {
      if (on) root.dataset.shield = '1';
      else delete root.dataset.shield;
    };

    const onVisibility = () => shield(document.visibilityState !== 'visible');
    const onBlur = () => shield(true);
    const onFocus = () => shield(document.visibilityState !== 'visible' ? true : false);

    const flagAttempt = () => {
      shield(true);
      try {
        navigator.clipboard?.writeText('').catch(() => {});
      } catch {
        /* ignore */
      }
      onAttempt?.();
      if (attemptTimer) clearTimeout(attemptTimer);
      attemptTimer = setTimeout(() => shield(document.visibilityState !== 'visible' || !document.hasFocus()), 1500);
    };

    const onKey = (e: KeyboardEvent) => {
      const isPrintScreen = e.key === 'PrintScreen' || e.code === 'PrintScreen';
      const macShot = e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.key);
      const winSnip = e.metaKey && e.shiftKey && (e.key === 's' || e.key === 'S');
      if (isPrintScreen || macShot || winSnip) {
        e.preventDefault();
        flagAttempt();
      }
    };
    const stop = (e: Event) => e.preventDefault();
    // The chat's own "Copy" button sets this flag for the instant of its copy.
    const stopCopy = (e: Event) => {
      if ((window as any).__allowCopy) return;
      e.preventDefault();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    document.addEventListener('contextmenu', stop);
    document.addEventListener('dragstart', stop);
    document.addEventListener('copy', stopCopy);
    document.addEventListener('cut', stopCopy);
    window.addEventListener('beforeprint', flagAttempt);

    return () => {
      if (attemptTimer) clearTimeout(attemptTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      document.removeEventListener('contextmenu', stop);
      document.removeEventListener('dragstart', stop);
      document.removeEventListener('copy', stopCopy);
      document.removeEventListener('cut', stopCopy);
      window.removeEventListener('beforeprint', flagAttempt);
      delete root.dataset.shield;
    };
  }, [active, onAttempt]);
}
