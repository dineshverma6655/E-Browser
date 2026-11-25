'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FakeBrowser } from '@/components/FakeBrowser';
import { SecretChat } from '@/components/SecretChat';
import { CHAT_THEME_COLORS, useChatTheme } from '@/lib/chatTheme';

// To anyone looking at the screen this is an ordinary web browser. The chat sits behind a secret code that is
// typed into the address/search bar. SecretChat stays mounted (but hidden) while locked, so calls, messages and
// presence keep working in the background.
const SECRET_CODE = process.env.NEXT_PUBLIC_SECRET_CODE || '28112005';

export default function Shell() {
  const [unlocked, setUnlocked] = useState(false);
  const [chatTheme] = useChatTheme();

  const unlockedRef = useRef(false);
  unlockedRef.current = unlocked;

  // Opening the chat adds ONE browser-history step (same URL, nothing shows in the address bar), so the Back button /
  // swipe-back closes the chat and returns to the browser screen instead of leaving the site.
  const unlock = useCallback(() => {
    setUnlocked(true);
    if (!window.history.state?.chat) window.history.pushState({ ...window.history.state, chat: true }, '');
  }, []);

  // Locking from inside the app (auto-lock etc.) also removes that history step, so Back does not need a second press.
  const lock = useCallback(() => {
    setUnlocked(false);
    if (window.history.state?.chat) window.history.back();
  }, []);

  useEffect(() => {
    const onPop = () => {
      const inChat = Boolean(window.history.state?.chat);
      if (inChat && !unlockedRef.current) {
        // "Forward" must never re-open the chat without the code.
        window.history.back();
        return;
      }
      if (!inChat) setUnlocked(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Status-bar colour and the area behind the app match whichever screen is showing (fake browser = white, chat = its theme)
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', unlocked ? CHAT_THEME_COLORS[chatTheme] : '#ffffff');
    if (unlocked) document.documentElement.setAttribute('data-chat-bg', chatTheme);
    else document.documentElement.removeAttribute('data-chat-bg');
  }, [unlocked, chatTheme]);

  return (
    <>
      <div className={unlocked ? 'contents' : 'hidden'}>
        <SecretChat active={unlocked} onLock={lock} />
      </div>
      {!unlocked && <FakeBrowser secretCode={SECRET_CODE} onSecret={unlock} />}
    </>
  );
}
