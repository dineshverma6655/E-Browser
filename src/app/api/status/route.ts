import { NextResponse } from 'next/server';
import { getServices } from '../../../../server/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Health of every moving part, shown in the app's settings panel.
export async function GET() {
  const { db, media, push, publisher } = getServices();
  const out = {
    database: false,
    cloud: { configured: media.enabled, ok: false, error: null as string | null },
    push: push.enabled,
    realtime: publisher.enabled,
  };
  try {
    await db.pool.query('SELECT 1');
    out.database = true;
  } catch {
    /* stays false */
  }
  if (media.enabled) {
    const r = await media.ping();
    out.cloud.ok = r.ok;
    out.cloud.error = r.error || null;
  }
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
}
