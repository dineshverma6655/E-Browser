import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface Story {
  id: number;
  title: string;
  url: string;
  domain: string;
  score: number;
  time: number;
  by: string;
}

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; data: Story[] } | null = null;

// Shown only if the news API cannot be reached, so the start page never looks broken.
const FALLBACK: Story[] = [
  { id: 1, title: 'How modern browsers keep your tabs fast and secure', url: 'https://developer.mozilla.org/', domain: 'developer.mozilla.org', score: 312, time: 0, by: 'web' },
  { id: 2, title: 'A short guide to web performance in 2026', url: 'https://web.dev/', domain: 'web.dev', score: 254, time: 0, by: 'web' },
  { id: 3, title: 'Open-source databases: what changed this year', url: 'https://www.postgresql.org/', domain: 'postgresql.org', score: 198, time: 0, by: 'web' },
  { id: 4, title: 'Why simple software lasts longer', url: 'https://news.ycombinator.com/', domain: 'news.ycombinator.com', score: 176, time: 0, by: 'web' },
];

const hostOf = (u?: string) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, '') : 'news.ycombinator.com';
  } catch {
    return 'news.ycombinator.com';
  }
};

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.data);
  try {
    const opts = { cache: 'no-store' as const, signal: AbortSignal.timeout(6000) };
    const ids: number[] = await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', opts)).json();
    const items = await Promise.all(
      ids.slice(0, 16).map((id) => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, opts).then((r) => r.json()))
    );
    const data: Story[] = items
      .filter((i) => i && i.title)
      .map((i) => ({
        id: i.id,
        title: String(i.title),
        url: i.url || `https://news.ycombinator.com/item?id=${i.id}`,
        domain: hostOf(i.url),
        score: i.score || 0,
        time: i.time || 0,
        by: i.by || '',
      }));
    if (data.length) cache = { at: Date.now(), data };
    return NextResponse.json(data.length ? data : cache?.data ?? FALLBACK);
  } catch {
    return NextResponse.json(cache?.data ?? FALLBACK);
  }
}
