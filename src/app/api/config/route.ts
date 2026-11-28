import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public config for the browser (VAPID public key, STUN/TURN servers).
export async function GET() {
  const turnUrl = process.env.TURN_URL || process.env.NEXT_PUBLIC_TURN_URL;
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = (
    process.env.NEXT_PUBLIC_STUN_SERVERS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((urls) => ({ urls }));
  if (turnUrl) {
    iceServers.push({
      urls: turnUrl.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME || process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL || process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return NextResponse.json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null, iceServers }, { headers: { 'Cache-Control': 'no-store' } });
}
