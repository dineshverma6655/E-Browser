'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { FakeBrowser } from '@/components/FakeBrowser';
import { SecretChat } from '@/components/SecretChat';

// To anyone looking at the screen this is an ordinary web browser. The chat sits behind a secret code that is
// typed into the address/search bar. SecretChat stays mounted (but hidden) while locked, so calls, messages and
// presence keep working in the background.
const SECRET_CODE = process.env.NEXT_PUBLIC_SECRET_CODE || '28112005';

export default function Shell() {
  const [unlocked, setUnlocked] = useState(false);

  const unlock = useCallback(() => setUnlocked(true), []);
  const lock = useCallback(() => setUnlocked(false), []);

  // Status-bar colour matches whichever screen is showing
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', unlocked ? '#090d16' : '#ffffff');
  }, [unlocked]);

  return (
    <>
      <div className={unlocked ? 'contents' : 'hidden'}>
        <SecretChat active={unlocked} onLock={lock} />
      </div>
      {!unlocked && <FakeBrowser secretCode={SECRET_CODE} onSecret={unlock} />}
    </>
  );
}
