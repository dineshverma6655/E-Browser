'use client';

import { useCallback, useEffect, useState } from 'react';

// Colour theme of the CHAT (the fake browser has its own theme setting).
//  light = warm white, dark ink   (default)
//  dark  = true black
export type ChatTheme = 'light' | 'dark';

const KEY = 'chat_theme';
const EVENT = 'chat-theme-change';

export const CHAT_THEME_COLORS: Record<ChatTheme, string> = { light: '#FAF7F2', dark: '#000000' };

export function readChatTheme(): ChatTheme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function useChatTheme(): [ChatTheme, (t: ChatTheme) => void] {
  const [theme, setThemeState] = useState<ChatTheme>('light');

  useEffect(() => {
    setThemeState(readChatTheme());
    const sync = () => setThemeState(readChatTheme());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setTheme = useCallback((t: ChatTheme) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode: the choice just lasts for this visit */
    }
    setThemeState(t);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [theme, setTheme];
}
