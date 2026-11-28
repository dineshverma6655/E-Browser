import { NextResponse } from 'next/server';
import { getServices } from '../../../../server/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Every chat action (the old Socket.io events) arrives here as one JSON request. See server/rt.js.
export async function POST(req: Request) {
  let body: any;
  try {
    // navigator.sendBeacon sends text/plain, so parse the raw text rather than relying on the content type
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ events: [], more: false, error: true }, { status: 400 });
  }
  const res = await getServices().rt.handle(body);
  return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
}
