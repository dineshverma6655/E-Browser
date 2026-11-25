import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Start-page feed from the free Wikipedia feed API: daily wallpaper, news (with photos), most-read articles and the
// featured article. No API key needed.
interface NewsItem {
  id: string;
  text: string;
  url: string;
  thumb: string | null;
}
interface ReadItem {
  id: string;
  title: string;
  desc: string;
  views: number;
  url: string;
  thumb: string | null;
}
interface Feed {
  wallpaper: { url: string; title: string } | null;
  news: NewsItem[];
  mostRead: ReadItem[];
  featured: { title: string; extract: string; url: string; thumb: string | null } | null;
  updated: number;
}

const TTL_MS = 20 * 60 * 1000;
let cache: { at: number; data: Feed } | null = null;
const EMPTY: Feed = { wallpaper: null, news: [], mostRead: [], featured: null, updated: 0 };

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const pad = (n: number) => String(n).padStart(2, '0');

async function fetchDay(d: Date): Promise<any> {
  const url = `https://en.wikipedia.org/api/rest_v1/feed/featured/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  const res = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'WebBrowserApp/1.0 (start page feed)', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('feed ' + res.status);
  return res.json();
}

// Wikimedia only serves a fixed set of thumbnail widths (anything else returns HTTP 400), so snap to one of them.
const WIDTHS = [250, 330, 500, 960];
const bigger = (src?: string, px = 500) => {
  if (!src) return null;
  const w = WIDTHS.find((x) => x >= px) || WIDTHS[WIDTHS.length - 1];
  return src.replace(/\/(\d+)px-/, `/${w}px-`);
};

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.data);
  try {
    let json: any;
    try {
      json = await fetchDay(new Date());
    } catch {
      json = await fetchDay(new Date(Date.now() - 24 * 3600 * 1000)); // today's feed is sometimes not ready yet
    }

    const thumb: string | undefined = json?.image?.thumbnail?.source || json?.image?.image?.source;
    const wallpaper = thumb
      ? { url: bigger(thumb, 960) as string, title: strip(String(json?.image?.description?.text || json?.image?.title || 'Picture of the day')) }
      : null;

    const news: NewsItem[] = (json?.news || [])
      .map((n: any, i: number) => {
        const links: any[] = n.links || [];
        const withPic = links.find((l) => l?.thumbnail?.source);
        const first = links[0];
        return {
          id: `n${i}`,
          text: strip(String(n.story || '')),
          url: (withPic || first)?.content_urls?.desktop?.page || 'https://en.wikipedia.org/wiki/Portal:Current_events',
          thumb: bigger(withPic?.thumbnail?.source, 330),
        } as NewsItem;
      })
      .filter((n: NewsItem) => n.text)
      .slice(0, 8);

    const mostRead: ReadItem[] = (json?.mostread?.articles || [])
      .filter((a: any) => a?.title && !String(a.title).includes(':') && a.title !== 'Main_Page')
      .map((a: any, i: number) => ({
        id: `m${i}`,
        title: String(a.normalizedtitle || a.title).replace(/_/g, ' '),
        desc: String(a.description || ''),
        views: Number(a.views || 0),
        url: a.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(a.title)}`,
        thumb: bigger(a.thumbnail?.source, 330),
      }))
      .slice(0, 10);

    const tfa = json?.tfa;
    const featured = tfa
      ? {
          title: String(tfa.normalizedtitle || tfa.title || '').replace(/_/g, ' '),
          extract: String(tfa.extract || '').slice(0, 240),
          url: tfa.content_urls?.desktop?.page || 'https://en.wikipedia.org/',
          thumb: bigger(tfa.thumbnail?.source, 500),
        }
      : null;

    const data: Feed = { wallpaper, news, mostRead, featured, updated: Date.now() };
    cache = { at: Date.now(), data };
    return NextResponse.json(data);
  } catch {
    // Offline / API down: serve the last good copy, or an empty feed (the page then falls back to a gradient)
    return NextResponse.json(cache?.data ?? EMPTY);
  }
}
