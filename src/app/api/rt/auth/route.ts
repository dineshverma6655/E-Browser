import { NextResponse } from 'next/server';
import { getServices } from '../../../../../server/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Pusher asks for permission before a device may listen on its private channel. Only the owner of an ID (who knows
// the secret) may listen to `private-u-<id>`, so nobody else can read someone's messages or call signals.
export async function POST(req: Request) {
  const { db, publisher } = getServices();
  if (!publisher.enabled) return NextResponse.json({ error: 'realtime-off' }, { status: 503 });
  const userId = req.headers.get('x-uid') || '';
  const secret = req.headers.get('x-secret') || '';
  const form = await req.formData();
  const socketId = String(form.get('socket_id') || '');
  const channel = String(form.get('channel_name') || '');
  if (!userId || channel !== publisher.channelOf(userId) || !(await db.verify(userId, secret))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json(publisher.authorize(socketId, channel), { headers: { 'Cache-Control': 'no-store' } });
}
