import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface Result {
  title: string;
  url: string;
  snippet: string;
}
interface Instant {
  title: string;
  text: string;
  url: string;
}

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const UA = { 'User-Agent': 'WebBrowserApp/1.0 (search)' };

// Optional "instant answer" card. Failures are ignored: it is a bonus on top of the main results.
async function instantAnswer(q: string): Promise<Instant | null> {
  try {
    const res = await fetch('https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' + encodeURIComponent(q), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3500),
      headers: UA,
    });
    const j = await res.json();
    if (j?.AbstractText && j?.AbstractURL) {
      return { title: String(j.Heading || q), text: String(j.AbstractText).slice(0, 420), url: String(j.AbstractURL) };
    }
  } catch {
    /* no instant answer */
  }
  return null;
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim().slice(0, 200);
  if (!q) return NextResponse.json({ results: [], instant: null });
  try {
    const [wiki, instant] = await Promise.all([
      fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=10&srsearch=' + encodeURIComponent(q), {
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
        headers: UA,
      }).then((r) => {
        if (!r.ok) throw new Error('search ' + r.status);
        return r.json();
      }),
      instantAnswer(q),
    ]);
    const results: Result[] = (wiki?.query?.search || []).map((r: any) => ({
      title: String(r.title),
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(r.title).replace(/ /g, '_')),
      snippet: strip(String(r.snippet || '')),
    }));
    return NextResponse.json({ results, instant });
  } catch {
    // The page keeps showing its loading state and retries, exactly like a slow connection.
    return NextResponse.json({ results: [], instant: null, error: true });
  }
}
