'use client';

import { useEffect } from 'react';

// Keeps the installed app / mobile browser on the latest deploy automatically:
//  - registers the service worker on every start (not only when push is enabled),
//  - re-checks for a new version whenever the app comes back to the foreground,
//  - reloads once when a new version takes over.
export function RegisterSW() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;

    const onControllerChange = () => {
      if (!hadController) {
        hadController = true; // first install, nothing to refresh
        return;
      }
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    let reg: ServiceWorkerRegistration | undefined;
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((r) => {
        reg = r;
        r.update().catch(() => {});
      })
      .catch(() => {});

    const check = () => {
      if (document.visibilityState === 'visible') reg?.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, 5 * 60 * 1000);

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
