'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Plus,
  Menu as MenuIcon,
  Home,
  Lock,
  RotateCw,
  X,
  Globe,
  Star,
  History as HistoryIcon,
  Download,
  Settings as SettingsIcon,
  EyeOff,
  Monitor,
  Trash2,
  Puzzle,
  Share2,
  MonitorSmartphone,
  UserPlus,
  SlidersHorizontal,
  Mic,
  Printer,
  ZoomIn,
  TextSearch,
  Info,
  Loader2,
} from 'lucide-react';
import { loadJSON, saveJSON, clearBrowserData } from '@/lib/browserStore';

/* ───────────────────────────── types ───────────────────────────── */

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
interface HnStory {
  id: number;
  title: string;
  url: string;
  domain: string;
  score: number;
  time: number;
  by: string;
}
interface Tab {
  id: string;
  priv: boolean;
  stack: string[]; // '' = start page, otherwise a search query
  idx: number;
  status: 'idle' | 'loading' | 'done' | 'empty';
  results: Result[];
  instant: Instant | null;
}
interface Settings {
  theme: 'system' | 'light' | 'dark';
  wallpaper: boolean;
  links: boolean;
  news: boolean;
  desktop: boolean;
  zoom: number;
}
interface Fav {
  id: string;
  title: string;
  query?: string;
  url?: string;
}
interface Hist {
  q: string;
  t: number;
}
interface LinkItem {
  name: string;
  url: string;
}
type SheetName = 'menu' | 'favorites' | 'history' | 'downloads' | 'settings' | 'extensions' | 'signin' | 'customise' | 'addlink' | 'deletedata' | 'devices' | 'about' | null;

interface FakeBrowserProps {
  /** typing this in the address/search bar (then Enter) opens the hidden app */
  secretCode: string;
  onSecret: () => void;
}

/* ───────────────────────────── helpers ───────────────────────────── */

const DEFAULT_SETTINGS: Settings = { theme: 'system', wallpaper: true, links: true, news: true, desktop: false, zoom: 100 };
const ZOOMS = [100, 125, 150, 75];

const BUILTIN_LINKS = [
  { name: 'YouTube', url: 'https://www.youtube.com', bg: 'bg-red-600', letter: '▶' },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org', bg: 'bg-slate-700', letter: 'W' },
  { name: 'Maps', url: 'https://www.openstreetmap.org', bg: 'bg-emerald-600', letter: 'M' },
  { name: 'Translate', url: 'https://translate.google.com', bg: 'bg-blue-600', letter: 'T' },
];
const TILE_COLORS = ['bg-indigo-600', 'bg-orange-500', 'bg-teal-600', 'bg-pink-600', 'bg-cyan-600', 'bg-violet-600'];

const looksLikeUrl = (q: string) => !/\s/.test(q) && /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(q);
const fullUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : 'https://' + u);
const hostOf = (u: string) => {
  try {
    return new URL(fullUrl(u)).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};
const favicon = (domain: string) => `https://icons.duckduckgo.com/ip3/${domain}.ico`;

const agoSec = (unix: number) => {
  if (!unix) return '';
  const s = Math.max(1, Math.floor(Date.now() / 1000 - unix));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const agoMs = (ms: number) => agoSec(Math.floor(ms / 1000));

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

let seq = 1;
const mkTab = (priv = false): Tab => ({ id: 't' + seq++, priv, stack: [''], idx: 0, status: 'idle', results: [], instant: null });
const uid = () => Math.random().toString(36).slice(2, 9);

function usePersisted<T>(key: string, init: T) {
  const [v, setV] = useState<T>(init);
  const ready = useRef(false);
  useEffect(() => {
    setV(loadJSON<T>(key, init));
    ready.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (ready.current) saveJSON(key, v);
  }, [key, v]);
  return [v, setV] as const;
}

/* ───────────────────────── small UI pieces ───────────────────────── */

const Sheet: React.FC<{ title?: string; dark: boolean; onClose: () => void; children: React.ReactNode }> = ({ title, dark, onClose, children }) => (
  <div className="absolute inset-0 z-40 flex flex-col justify-end bg-black/55" onClick={onClose}>
    <div
      onClick={(e) => e.stopPropagation()}
      className={`rounded-t-3xl max-h-[88%] overflow-y-auto overflow-x-hidden pb-[max(16px,env(safe-area-inset-bottom))] ${
        dark ? 'bg-[#2b2b2b] text-white' : 'bg-white text-slate-900'
      }`}
    >
      <div className={`mx-auto mt-2.5 mb-1 w-10 h-1 rounded-full ${dark ? 'bg-white/30' : 'bg-slate-300'}`} />
      {title && <h3 className="px-5 pt-2 pb-3 text-lg font-semibold">{title}</h3>}
      {children}
    </div>
  </div>
);

const Switch: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: string }> = ({ on, onChange, label }) => (
  <button
    role="switch"
    aria-checked={on}
    aria-label={label}
    onClick={() => onChange(!on)}
    className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-sky-500' : 'bg-slate-500/60'}`}
  >
    <span className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
  </button>
);

const MenuItem: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; accent?: boolean }> = ({ icon, label, onClick, disabled, accent }) => (
  <button
    onClick={disabled ? undefined : onClick}
    disabled={disabled}
    className={`flex flex-col items-center gap-2 py-2 px-1 rounded-xl active:bg-white/10 ${disabled ? 'opacity-40' : ''}`}
  >
    <span className={`h-7 flex items-center ${accent ? 'text-sky-400' : ''}`}>{icon}</span>
    <span className="text-[12px] leading-tight text-center">{label}</span>
  </button>
);

/* ───────────────────────────── component ───────────────────────────── */

export const FakeBrowser: React.FC<FakeBrowserProps> = ({ secretCode, onSecret }) => {
  const [tabs, setTabs] = useState<Tab[]>(() => [mkTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [menuPage, setMenuPage] = useState(0);
  const [showTabs, setShowTabs] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [addr, setAddr] = useState('');
  const [addrFocused, setAddrFocused] = useState(false);
  const [ntpQ, setNtpQ] = useState('');
  const [feed, setFeed] = useState<Feed | null>(null);
  const [hn, setHn] = useState<HnStory[]>([]);
  const [sysDark, setSysDark] = useState(false);
  const [signinName, setSigninName] = useState('');
  const [linkName, setLinkName] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [del, setDel] = useState({ history: true, favs: true, links: false, settings: false });

  const [settings, setSettings] = usePersisted<Settings>('settings', DEFAULT_SETTINGS);
  const [favs, setFavs] = usePersisted<Fav[]>('favorites', []);
  const [hist, setHist] = usePersisted<Hist[]>('history', []);
  const [links, setLinks] = usePersisted<LinkItem[]>('links', []);
  const [profile, setProfile] = usePersisted<string>('profile', '');

  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  const retryRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const addrRef = useRef<HTMLInputElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tab = tabs.find((t) => t.id === activeId) || tabs[0];
  const query = tab.stack[tab.idx];
  const onStart = query === '';
  const dark = tab.priv || settings.theme === 'dark' || (settings.theme === 'system' && sysDark);

  const say = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t))), []);

  // system dark mode
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setSysDark(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // start-page feed (wallpaper, news, trending, tech) — refreshed in the background
  const loadFeed = useCallback(() => {
    fetch('/api/feed')
      .then((r) => r.json())
      .then((d: Feed) => setFeed(d))
      .catch(() => setFeed((p) => p ?? { wallpaper: null, news: [], mostRead: [], featured: null, updated: 0 }));
    fetch('/api/news')
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setHn(d))
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadFeed();
    const t = setInterval(loadFeed, 10 * 60 * 1000);
    const onVis = () => document.visibilityState === 'visible' && loadFeed();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [loadFeed]);

  useEffect(
    () => () => {
      Object.values(retryRef.current).forEach(clearTimeout);
    },
    []
  );

  // address bar text follows the page unless the user is typing
  useEffect(() => {
    if (!addrFocused) setAddr(query);
  }, [query, tab.id, addrFocused]);

  /* ── search ── */
  const stillOn = (id: string, q: string) => {
    const t = tabsRef.current.find((x) => x.id === id);
    return Boolean(t && t.stack[t.idx] === q);
  };

  const fetchResults = useCallback(
    (id: string, q: string) => {
      clearTimeout(retryRef.current[id]);
      patchTab(id, { status: 'loading', results: [], instant: null });
      const attempt = async () => {
        try {
          const r = await fetch('/api/search?q=' + encodeURIComponent(q)).then((x) => x.json());
          if (r.error) throw new Error('api');
          setTabs((prev) =>
            prev.map((t) =>
              t.id === id && t.stack[t.idx] === q
                ? { ...t, status: (r.results && r.results.length) || r.instant ? 'done' : 'empty', results: r.results || [], instant: r.instant || null }
                : t
            )
          );
        } catch {
          // No data yet: keep the loading screen and keep trying in the background.
          retryRef.current[id] = setTimeout(() => stillOn(id, q) && attempt(), 4000);
        }
      };
      void attempt();
    },
    [patchTab]
  );

  const openExternal = (url: string) => window.open(fullUrl(url), '_blank', 'noopener,noreferrer');

  const navigate = (id: string, q: string) => {
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    clearTimeout(retryRef.current[id]);
    setTabs((prev) =>
      prev.map((x) => (x.id === id ? { ...x, stack: [...x.stack.slice(0, x.idx + 1), q], idx: x.idx + 1, status: q ? 'loading' : 'idle', results: [], instant: null } : x))
    );
    if (q) {
      if (!t.priv) setHist((p) => [{ q, t: Date.now() }, ...p.filter((h) => h.q !== q)].slice(0, 100));
      fetchResults(id, q);
    }
  };

  const submit = (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    // Hidden door: this exact code opens the chat. It is never searched, never stored in history.
    if (secretCode && q === secretCode) {
      setAddr('');
      setNtpQ('');
      setAddrFocused(false);
      addrRef.current?.blur();
      (document.activeElement as HTMLElement | null)?.blur?.();
      onSecret();
      return;
    }
    addrRef.current?.blur();
    setAddrFocused(false);
    setNtpQ('');
    if (looksLikeUrl(q)) {
      if (!tab.priv) setHist((p) => [{ q, t: Date.now() }, ...p.filter((h) => h.q !== q)].slice(0, 100));
      openExternal(q);
      return;
    }
    navigate(tab.id, q);
  };

  const go = (delta: number) => {
    const t = tab;
    const ni = t.idx + delta;
    if (ni < 0 || ni >= t.stack.length) return;
    clearTimeout(retryRef.current[t.id]);
    const q = t.stack[ni];
    patchTab(t.id, { idx: ni, status: q ? 'loading' : 'idle', results: [], instant: null });
    if (q) fetchResults(t.id, q);
  };

  const reload = () => {
    if (query) fetchResults(tab.id, query);
    else loadFeed();
  };

  const addTab = (priv = false) => {
    const t = mkTab(priv);
    setTabs((p) => [...p, t]);
    setActiveId(t.id);
    setShowTabs(false);
    setSheet(null);
  };
  const closeTab = (id: string) => {
    clearTimeout(retryRef.current[id]);
    const next = tabs.filter((t) => t.id !== id);
    if (!next.length) {
      const t = mkTab();
      setTabs([t]);
      setActiveId(t.id);
      return;
    }
    setTabs(next);
    if (id === activeId) setActiveId(next[next.length - 1].id);
  };

  /* ── menu actions ── */
  const openSheet = (s: SheetName) => setSheet(s);
  const shareUrl = () => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
  const doShare = async () => {
    setSheet(null);
    try {
      if (navigator.share) {
        await navigator.share({ title: query, url: shareUrl() });
      } else {
        await navigator.clipboard.writeText(shareUrl());
        say('Link copied');
      }
    } catch {
      /* cancelled */
    }
  };
  const addFavorite = () => {
    setSheet(null);
    if (favs.some((f) => f.query === query)) return say('Already in favourites');
    setFavs((p) => [{ id: uid(), title: query, query }, ...p]);
    say('Added to favourites');
  };
  const toggleDesktop = () => {
    setSheet(null);
    setSettings((s) => ({ ...s, desktop: !s.desktop }));
    say(settings.desktop ? 'Mobile site' : 'Desktop site');
  };
  const cycleZoom = () => {
    const next = ZOOMS[(ZOOMS.indexOf(settings.zoom) + 1) % ZOOMS.length];
    setSettings((s) => ({ ...s, zoom: next }));
    say(`Zoom ${next}%`);
  };
  const runFind = (text: string) => {
    const w = window as unknown as { find?: (s: string) => boolean };
    if (text && typeof w.find === 'function') {
      if (!w.find(text)) say('No matches');
    }
  };
  const startVoice = () => {
    const w = window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) return say('Voice search is not supported in this browser');
    try {
      const rec = new SR();
      rec.lang = 'en-US';
      rec.onresult = (e: any) => submit(String(e.results[0][0].transcript));
      rec.onerror = () => say('Could not hear anything');
      rec.start();
      say('Listening…');
    } catch {
      say('Voice search is unavailable');
    }
  };
  const deleteData = () => {
    const keys: string[] = [];
    if (del.history) keys.push('history');
    if (del.favs) keys.push('favorites');
    if (del.links) keys.push('links');
    if (del.settings) keys.push('settings', 'profile');
    clearBrowserData(keys);
    if (del.history) setHist([]);
    if (del.favs) setFavs([]);
    if (del.links) setLinks([]);
    if (del.settings) {
      setSettings(DEFAULT_SETTINGS);
      setProfile('');
    }
    setSheet(null);
    say('Browsing data deleted');
  };

  /* ── theme tokens ── */
  const T = {
    page: tab.priv ? 'bg-[#1b1530] text-white' : dark ? 'bg-[#1f1f1f] text-white' : 'bg-white text-slate-900',
    bar: dark ? 'bg-[#2d2d2d]' : 'bg-slate-100',
    line: dark ? 'border-white/10' : 'border-slate-200',
    sub: dark ? 'text-slate-400' : 'text-slate-500',
    card: dark ? 'bg-[#2b2b2b] ring-1 ring-white/10' : 'bg-white ring-1 ring-slate-200 shadow-sm',
    link: dark ? 'text-sky-400' : 'text-sky-700',
    toolbar: tab.priv ? 'bg-[#1b1530]' : dark ? 'bg-[#1f1f1f]' : 'bg-white',
    icon: dark ? 'text-white' : 'text-slate-700',
    disabled: dark ? 'text-white/25' : 'text-slate-300',
  };

  const wallpaperOn = onStart && !tab.priv && settings.wallpaper && feed?.wallpaper;
  const initial = profile ? profile.trim()[0]?.toUpperCase() : '';

  /* ───────────── start page ───────────── */
  const startPage = (
    <div className="relative flex-1 min-h-0">
      {wallpaperOn ? (
        <>
          <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${feed!.wallpaper!.url}")` }} />
          <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-black/5 to-black/55" />
        </>
      ) : (
        <div className={`absolute inset-0 ${tab.priv ? 'bg-gradient-to-b from-[#241a45] to-[#1b1530]' : dark ? 'bg-gradient-to-b from-[#16324a] via-[#1b2733] to-[#1f1f1f]' : 'bg-gradient-to-b from-sky-100 via-sky-50 to-white'}`} />
      )}

      <div className="absolute inset-0 overflow-y-auto overflow-x-hidden no-scrollbar">
        <div className={`min-h-full flex flex-col px-4 pt-[max(14px,env(safe-area-inset-top))] pb-3 ${wallpaperOn || dark ? 'text-white' : 'text-slate-900'}`}>
          {/* greeting row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                onClick={() => openSheet('signin')}
                aria-label="Profile"
                className="w-10 h-10 rounded-full bg-black/45 backdrop-blur text-white flex items-center justify-center text-sm font-semibold flex-shrink-0 active:scale-95"
              >
                {initial || <UserPlus className="w-5 h-5" />}
              </button>
              <span className="text-[15px] font-medium drop-shadow truncate">{tab.priv ? 'Private tab' : greeting()}</span>
            </div>
            <button onClick={() => openSheet('customise')} aria-label="Customise" className="w-10 h-10 rounded-full flex items-center justify-center bg-black/30 backdrop-blur text-white active:scale-95">
              <SlidersHorizontal className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 min-h-[3rem]" />

          {tab.priv ? (
            <div className="rounded-2xl bg-black/35 backdrop-blur p-5 mb-4">
              <div className="flex items-center gap-2 text-base font-semibold mb-1.5">
                <EyeOff className="w-5 h-5" /> You&apos;re in a private tab
              </div>
              <p className="text-sm text-white/75 leading-relaxed">Searches in private tabs are not saved to history. Favourites you add stay on this device.</p>
            </div>
          ) : (
            <>
              {settings.links && (
                <div className="grid grid-cols-5 gap-x-2 gap-y-4 mb-5">
                  <button onClick={() => openSheet('favorites')} className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
                    <span className="w-14 h-14 rounded-2xl bg-black/45 backdrop-blur flex items-center justify-center text-sky-400">
                      <Star className="w-7 h-7 fill-sky-400" />
                    </span>
                    <span className="text-[11px] drop-shadow">Favourites</span>
                  </button>
                  {BUILTIN_LINKS.map((l) => (
                    <button key={l.name} onClick={() => openExternal(l.url)} className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
                      <span className={`w-14 h-14 rounded-2xl ${l.bg} text-white text-xl font-bold flex items-center justify-center shadow`}>{l.letter}</span>
                      <span className="text-[11px] drop-shadow truncate max-w-full">{l.name}</span>
                    </button>
                  ))}
                  {links.map((l, i) => (
                    <button key={l.url + i} onClick={() => openExternal(l.url)} className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
                      <span className={`w-14 h-14 rounded-2xl ${TILE_COLORS[i % TILE_COLORS.length]} text-white text-xl font-bold flex items-center justify-center shadow uppercase`}>{l.name[0]}</span>
                      <span className="text-[11px] drop-shadow truncate max-w-full">{l.name}</span>
                    </button>
                  ))}
                  <button onClick={() => openSheet('addlink')} className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
                    <span className="w-14 h-14 rounded-2xl bg-black/45 backdrop-blur flex items-center justify-center text-white">
                      <Plus className="w-7 h-7" />
                    </span>
                    <span className="text-[11px] drop-shadow">Add</span>
                  </button>
                </div>
              )}

              <button
                onClick={() => openSheet('customise')}
                className="text-left rounded-2xl bg-black/50 backdrop-blur p-4 mb-3 text-white active:bg-black/60"
              >
                <p className="text-[12px] text-white/65 pb-2 mb-2 border-b border-white/15">Tips</p>
                <p className="text-[16px] font-semibold">Make this page yours</p>
                <p className="text-[13px] text-white/75 mt-0.5">Choose a wallpaper and what shows on your start page.</p>
              </button>

              {settings.news && (
                <button onClick={() => feedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="mx-auto flex flex-col items-center gap-0.5 py-1 text-white drop-shadow active:scale-95">
                  <ChevronUp className="w-5 h-5" />
                  <span className="text-[14px] font-medium">News and more</span>
                </button>
              )}
            </>
          )}
        </div>

        {/* feed */}
        {!tab.priv && settings.news && (
          <div ref={feedRef} className={`px-4 pt-4 pb-6 space-y-5 ${dark || wallpaperOn ? 'bg-[#1f1f1f]/92 backdrop-blur-md text-white' : 'bg-white text-slate-900'}`}>
            {feed === null && (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="rounded-2xl bg-white/10 p-4 animate-pulse">
                    <div className="h-3 w-24 rounded bg-white/20 mb-3" />
                    <div className="h-4 w-full rounded bg-white/20 mb-2" />
                    <div className="h-4 w-2/3 rounded bg-white/20" />
                  </div>
                ))}
              </div>
            )}

            {feed?.featured && (
              <section>
                <h2 className="text-sm font-semibold mb-2.5">Featured</h2>
                <button onClick={() => openExternal(feed.featured!.url)} className={`block w-full text-left rounded-2xl overflow-hidden ${dark || wallpaperOn ? 'bg-[#2b2b2b]' : 'bg-white ring-1 ring-slate-200 shadow-sm'}`}>
                  {feed.featured.thumb && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={feed.featured.thumb} alt="" loading="lazy" draggable={false} className="w-full h-44 object-cover" />
                  )}
                  <div className="p-4">
                    <p className="text-[17px] font-semibold leading-snug">{feed.featured.title}</p>
                    <p className={`mt-1 text-[13px] leading-snug line-clamp-3 ${dark || wallpaperOn ? 'text-slate-300' : 'text-slate-600'}`}>{feed.featured.extract}</p>
                  </div>
                </button>
              </section>
            )}

            {feed && feed.news.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold mb-2.5">News</h2>
                <div className="space-y-3">
                  {feed.news.map((n) => (
                    <button key={n.id} onClick={() => openExternal(n.url)} className={`flex w-full gap-3 text-left rounded-2xl p-3 ${dark || wallpaperOn ? 'bg-[#2b2b2b]' : 'bg-white ring-1 ring-slate-200 shadow-sm'}`}>
                      <div className="flex-1 min-w-0">
                        <p className={`text-[11px] mb-1 ${dark || wallpaperOn ? 'text-slate-400' : 'text-slate-500'}`}>In the news</p>
                        <p className="text-[14.5px] leading-snug line-clamp-5 [overflow-wrap:anywhere]">{n.text}</p>
                      </div>
                      {n.thumb && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={n.thumb} alt="" loading="lazy" draggable={false} className="w-24 h-24 rounded-xl object-cover flex-shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {feed && feed.mostRead.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold mb-2.5">Trending now</h2>
                <div className="grid grid-cols-2 gap-3">
                  {feed.mostRead.slice(0, 6).map((a) => (
                    <button key={a.id} onClick={() => openExternal(a.url)} className={`text-left rounded-2xl overflow-hidden ${dark || wallpaperOn ? 'bg-[#2b2b2b]' : 'bg-white ring-1 ring-slate-200 shadow-sm'}`}>
                      {a.thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.thumb} alt="" loading="lazy" draggable={false} className="w-full h-28 object-cover" />
                      ) : (
                        <div className="w-full h-28 bg-gradient-to-br from-sky-500/30 to-emerald-400/30 flex items-center justify-center">
                          <Globe className="w-7 h-7 opacity-50" />
                        </div>
                      )}
                      <div className="p-2.5">
                        <p className="text-[13.5px] font-medium leading-snug line-clamp-2">{a.title}</p>
                        {a.desc && <p className={`mt-0.5 text-[11px] line-clamp-1 ${dark || wallpaperOn ? 'text-slate-400' : 'text-slate-500'}`}>{a.desc}</p>}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {hn.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold mb-2.5">Tech</h2>
                <div className="space-y-3">
                  {hn.slice(0, 8).map((s) => (
                    <button key={s.id} onClick={() => openExternal(s.url)} className={`block w-full text-left rounded-2xl p-3.5 ${dark || wallpaperOn ? 'bg-[#2b2b2b]' : 'bg-white ring-1 ring-slate-200 shadow-sm'}`}>
                      <div className={`flex items-center gap-2 text-[11px] mb-1.5 ${dark || wallpaperOn ? 'text-slate-400' : 'text-slate-500'}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={favicon(s.domain)} alt="" width={16} height={16} className="w-4 h-4 rounded" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                        <span className="truncate">{s.domain}</span>
                        {s.time > 0 && <span>· {agoSec(s.time)}</span>}
                      </div>
                      <p className="text-[14.5px] font-medium leading-snug [overflow-wrap:anywhere]">{s.title}</p>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );

  /* ───────────── results page ───────────── */
  const resultsPage = (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden no-scrollbar relative">
      {tab.status === 'loading' && <div className="sticky top-0 z-10 h-0.5 w-full bg-sky-500 animate-pulse" />}
      <div className="px-4 py-4" style={{ zoom: settings.desktop ? 0.85 : settings.zoom / 100 }}>
        {tab.status === 'loading' ? (
          <div className="py-6 space-y-5">
            <div className="flex justify-center">
              <Loader2 className="w-7 h-7 text-sky-500 animate-spin" />
            </div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="animate-pulse space-y-2">
                <div className={`h-3 w-28 rounded ${dark ? 'bg-white/10' : 'bg-slate-200'}`} />
                <div className={`h-5 w-3/4 rounded ${dark ? 'bg-white/10' : 'bg-slate-200'}`} />
                <div className={`h-3 w-full rounded ${dark ? 'bg-white/10' : 'bg-slate-200'}`} />
                <div className={`h-3 w-5/6 rounded ${dark ? 'bg-white/10' : 'bg-slate-200'}`} />
              </div>
            ))}
          </div>
        ) : tab.status === 'empty' ? (
          <div className={`py-16 text-center text-[15px] ${T.sub}`}>
            <Search className="w-10 h-10 mx-auto mb-3 opacity-40" />
            No results found for “{query}”.
          </div>
        ) : (
          <>
            {tab.instant && (
              <button onClick={() => openExternal(tab.instant!.url)} className={`block w-full text-left rounded-2xl p-4 mb-5 ${T.card}`}>
                <p className={`text-[11px] mb-1 ${T.sub}`}>{hostOf(tab.instant.url)}</p>
                <p className="text-[18px] font-semibold mb-1">{tab.instant.title}</p>
                <p className={`text-[14px] leading-snug ${dark ? 'text-slate-300' : 'text-slate-600'}`}>{tab.instant.text}</p>
              </button>
            )}
            <div className="space-y-5">
              {tab.results.map((r) => (
                <button key={r.url} onClick={() => openExternal(r.url)} className="block w-full text-left">
                  <div className={`flex items-center gap-2 text-[11.5px] mb-0.5 ${T.sub}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={favicon('en.wikipedia.org')} alt="" width={16} height={16} className="w-4 h-4 rounded" />
                    <span className="truncate">en.wikipedia.org › {r.title}</span>
                  </div>
                  <p className={`text-[17.5px] leading-snug font-medium [overflow-wrap:anywhere] ${T.link}`}>{r.title}</p>
                  <p className={`mt-0.5 text-[13.5px] leading-snug line-clamp-3 [overflow-wrap:anywhere] ${dark ? 'text-slate-300' : 'text-slate-600'}`}>{r.snippet}…</p>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );

  /* ───────────── render ───────────── */
  return (
    <div className={`relative flex flex-col h-[var(--app-h,100dvh)] overflow-hidden select-none ${T.page}`}>
      {/* address bar (search pages only — the start page has its search bar at the bottom) */}
      {!onStart && (
        <div className={`px-3 pt-[max(10px,env(safe-area-inset-top))] pb-2 border-b ${T.line} ${T.page}`}>
          <div className={`flex items-center gap-2 h-11 rounded-full px-3.5 ring-1 ring-transparent focus-within:ring-sky-400 ${T.bar}`}>
            {addrFocused ? <Search className={`w-4 h-4 flex-shrink-0 ${T.sub}`} /> : <Lock className="w-4 h-4 text-emerald-500 flex-shrink-0" />}
            <input
              ref={addrRef}
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={addr}
              placeholder="Search or enter web address"
              onChange={(e) => setAddr(e.target.value)}
              onFocus={(e) => {
                setAddrFocused(true);
                e.currentTarget.select();
              }}
              onBlur={() => setAddrFocused(false)}
              onKeyDown={(e) => e.key === 'Enter' && submit(addr)}
              className="flex-1 min-w-0 bg-transparent text-base outline-none select-text"
            />
            {addr && addrFocused ? (
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => setAddr('')} aria-label="Clear" className={T.sub}>
                <X className="w-4 h-4" />
              </button>
            ) : (
              <button onClick={reload} aria-label="Refresh" className={`${T.sub} active:scale-90`}>
                <RotateCw className="w-4 h-4" />
              </button>
            )}
          </div>
          {findOpen && (
            <div className={`mt-2 flex items-center gap-2 h-10 rounded-full px-3.5 ${T.bar}`}>
              <TextSearch className={`w-4 h-4 ${T.sub}`} />
              <input
                autoFocus
                value={findText}
                onChange={(e) => setFindText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runFind(findText)}
                placeholder="Find on page"
                className="flex-1 min-w-0 bg-transparent text-base outline-none select-text"
              />
              <button onClick={() => runFind(findText)} className="text-sm font-medium text-sky-500">Find</button>
              <button onClick={() => setFindOpen(false)} aria-label="Close find" className={T.sub}>
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {onStart ? startPage : resultsPage}

      {/* bottom search bar on the start page */}
      {onStart && (
        <div className={`px-3 pb-2 pt-1 ${T.toolbar}`}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(ntpQ);
            }}
            className={`flex items-center gap-2.5 h-12 rounded-full px-2.5 ${dark ? 'bg-[#2d2d2d]' : 'bg-slate-100'}`}
          >
            <span className="w-8 h-8 rounded-full bg-gradient-to-br from-sky-500 to-emerald-400 flex items-center justify-center flex-shrink-0">
              <Search className="w-4 h-4 text-white" />
            </span>
            <input
              type="text"
              value={ntpQ}
              onChange={(e) => setNtpQ(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="search"
              placeholder="Search or type web address"
              className="flex-1 min-w-0 bg-transparent text-base outline-none select-text placeholder:opacity-70"
            />
            <button type="button" onClick={startVoice} aria-label="Voice search" className={`w-9 h-9 flex items-center justify-center ${T.icon} active:scale-90`}>
              <Mic className="w-5 h-5" />
            </button>
          </form>
        </div>
      )}

      {/* toolbar */}
      <div className={`flex items-center justify-around border-t ${T.line} ${T.toolbar} pt-1 pb-[max(8px,env(safe-area-inset-bottom))]`}>
        <button onClick={() => go(-1)} disabled={tab.idx === 0} aria-label="Back" className={`w-12 h-11 flex items-center justify-center active:scale-90 ${tab.idx === 0 ? T.disabled : T.icon}`}>
          <ChevronLeft className="w-6 h-6" />
        </button>
        <button onClick={() => go(1)} disabled={tab.idx >= tab.stack.length - 1} aria-label="Forward" className={`w-12 h-11 flex items-center justify-center active:scale-90 ${tab.idx >= tab.stack.length - 1 ? T.disabled : T.icon}`}>
          <ChevronRight className="w-6 h-6" />
        </button>
        <button onClick={() => addTab(tab.priv)} aria-label="New tab" className={`w-12 h-11 flex items-center justify-center active:scale-90 ${T.icon}`}>
          <Plus className="w-6 h-6" />
        </button>
        <button onClick={() => setShowTabs(true)} aria-label="Tabs" className="w-12 h-11 flex items-center justify-center active:scale-90">
          <span className={`min-w-[24px] h-6 px-1 rounded-md border-2 text-[12px] font-bold flex items-center justify-center ${dark ? 'border-white text-white' : 'border-slate-700 text-slate-700'}`}>{tabs.length}</span>
        </button>
        <button
          onClick={() => {
            setMenuPage(0);
            setSheet('menu');
          }}
          aria-label="Menu"
          className={`w-12 h-11 flex items-center justify-center active:scale-90 ${T.icon}`}
        >
          <MenuIcon className="w-6 h-6" />
        </button>
      </div>

      {/* toast */}
      {toast && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-[calc(env(safe-area-inset-bottom)+120px)] z-50 max-w-[85%] px-4 py-2.5 rounded-full bg-black/85 text-white text-[13px] shadow-xl">
          {toast}
        </div>
      )}

      {/* ── main menu ── */}
      {sheet === 'menu' && (
        <Sheet dark onClose={() => setSheet(null)}>
          <div className="px-4 pb-1">
            <div className="rounded-2xl bg-white/10 p-3.5 flex items-center gap-3 mb-3">
              <span className="w-11 h-11 rounded-full bg-white/15 flex items-center justify-center text-base font-semibold flex-shrink-0">{initial || <UserPlus className="w-5 h-5" />}</span>
              <p className="flex-1 text-[14px] leading-snug">{profile ? `Signed in as ${profile}` : 'Sign in to keep your history, favourites and more on this device.'}</p>
              <button onClick={() => setSheet('signin')} className="px-4 h-9 rounded-full bg-sky-600 text-[14px] font-semibold">{profile ? 'Account' : 'Sign in'}</button>
            </div>
          </div>
          <div
            className="flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
            onScroll={(e) => setMenuPage(e.currentTarget.scrollLeft > e.currentTarget.clientWidth / 2 ? 1 : 0)}
          >
            <div className="snap-start flex-shrink-0 w-full px-3">
              <div className="grid grid-cols-4">
                <MenuItem accent icon={<Star className="w-6 h-6 fill-sky-400" />} label="Favourites" onClick={() => openSheet('favorites')} />
                <MenuItem accent icon={<HistoryIcon className="w-6 h-6" />} label="History" onClick={() => openSheet('history')} />
                <MenuItem accent icon={<Download className="w-6 h-6" />} label="Downloads" onClick={() => openSheet('downloads')} />
                <MenuItem accent icon={<SettingsIcon className="w-6 h-6" />} label="Settings" onClick={() => openSheet('settings')} />
              </div>
              <div className="my-2 border-t border-white/10" />
              <div className="grid grid-cols-4">
                <MenuItem icon={<Home className="w-6 h-6" />} label="Home" disabled={onStart} onClick={() => { setSheet(null); navigate(tab.id, ''); }} />
                <MenuItem icon={<EyeOff className="w-6 h-6" />} label="New private tab" onClick={() => addTab(true)} />
                <MenuItem icon={<Star className="w-6 h-6" />} label="Add to favourites" disabled={onStart} onClick={addFavorite} />
                <MenuItem icon={<Monitor className="w-6 h-6" />} label={settings.desktop ? 'Mobile site' : 'View desktop site'} disabled={onStart} onClick={toggleDesktop} />
              </div>
              <div className="grid grid-cols-4">
                <MenuItem icon={<Trash2 className="w-6 h-6" />} label="Delete data" onClick={() => openSheet('deletedata')} />
                <MenuItem icon={<Puzzle className="w-6 h-6" />} label="Extensions" onClick={() => openSheet('extensions')} />
                <MenuItem icon={<Share2 className="w-6 h-6" />} label="Share" disabled={onStart} onClick={doShare} />
                <MenuItem icon={<MonitorSmartphone className="w-6 h-6" />} label="Send to devices" disabled={onStart} onClick={() => openSheet('devices')} />
              </div>
            </div>
            <div className="snap-start flex-shrink-0 w-full px-3">
              <div className="grid grid-cols-4">
                <MenuItem icon={<TextSearch className="w-6 h-6" />} label="Find on page" disabled={onStart} onClick={() => { setSheet(null); setFindOpen(true); }} />
                <MenuItem icon={<ZoomIn className="w-6 h-6" />} label={`Zoom ${settings.zoom}%`} disabled={onStart} onClick={cycleZoom} />
                <MenuItem icon={<Printer className="w-6 h-6" />} label="Print" disabled={onStart} onClick={() => { setSheet(null); setTimeout(() => window.print(), 150); }} />
                <MenuItem icon={<Info className="w-6 h-6" />} label="About" onClick={() => openSheet('about')} />
              </div>
            </div>
          </div>
          <div className="flex justify-center gap-1.5 pt-3 pb-1">
            {[0, 1].map((i) => (
              <span key={i} className={`h-1 rounded-full transition-all ${menuPage === i ? 'w-6 bg-white' : 'w-3 bg-white/30'}`} />
            ))}
          </div>
        </Sheet>
      )}

      {/* ── favourites ── */}
      {sheet === 'favorites' && (
        <Sheet title="Favourites" dark onClose={() => setSheet(null)}>
          <div className="px-3 pb-3">
            {favs.length === 0 && (
              <div className="py-10 text-center text-slate-400 text-sm">
                <Star className="w-9 h-9 mx-auto mb-2 opacity-40" />
                No favourites yet. Open a search and choose “Add to favourites” from the menu.
              </div>
            )}
            {favs.map((f) => (
              <div key={f.id} className="flex items-center gap-3 px-2 h-14 rounded-xl active:bg-white/10">
                <button
                  onClick={() => {
                    setSheet(null);
                    if (f.query) navigate(tab.id, f.query);
                    else if (f.url) openExternal(f.url);
                  }}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left"
                >
                  <Star className="w-5 h-5 text-sky-400 fill-sky-400 flex-shrink-0" />
                  <span className="truncate text-[15px]">{f.title}</span>
                </button>
                <button onClick={() => setFavs((p) => p.filter((x) => x.id !== f.id))} aria-label="Remove favourite" className="w-9 h-9 flex items-center justify-center text-slate-400">
                  <X className="w-5 h-5" />
                </button>
              </div>
            ))}
          </div>
        </Sheet>
      )}

      {/* ── history ── */}
      {sheet === 'history' && (
        <Sheet title="History" dark onClose={() => setSheet(null)}>
          <div className="px-3 pb-3">
            {hist.length > 0 && (
              <button onClick={() => { setHist([]); say('History cleared'); }} className="mb-2 ml-2 text-sm font-medium text-sky-400">Clear all</button>
            )}
            {hist.length === 0 && (
              <div className="py-10 text-center text-slate-400 text-sm">
                <HistoryIcon className="w-9 h-9 mx-auto mb-2 opacity-40" />
                Your history will show up here.
              </div>
            )}
            {hist.map((h) => (
              <div key={h.q + h.t} className="flex items-center gap-3 px-2 h-14 rounded-xl active:bg-white/10">
                <button
                  onClick={() => {
                    setSheet(null);
                    if (looksLikeUrl(h.q)) openExternal(h.q);
                    else navigate(tab.id, h.q);
                  }}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left"
                >
                  {looksLikeUrl(h.q) ? <Globe className="w-5 h-5 text-slate-400 flex-shrink-0" /> : <Search className="w-5 h-5 text-slate-400 flex-shrink-0" />}
                  <span className="min-w-0">
                    <span className="block truncate text-[15px]">{h.q}</span>
                    <span className="block text-[11px] text-slate-400">{agoMs(h.t)}</span>
                  </span>
                </button>
                <button onClick={() => setHist((p) => p.filter((x) => x !== h))} aria-label="Remove from history" className="w-9 h-9 flex items-center justify-center text-slate-400">
                  <X className="w-5 h-5" />
                </button>
              </div>
            ))}
          </div>
        </Sheet>
      )}

      {sheet === 'downloads' && (
        <Sheet title="Downloads" dark onClose={() => setSheet(null)}>
          <div className="py-12 text-center text-slate-400 text-sm">
            <Download className="w-10 h-10 mx-auto mb-3 opacity-40" />
            No downloads yet.
          </div>
        </Sheet>
      )}

      {sheet === 'extensions' && (
        <Sheet title="Extensions" dark onClose={() => setSheet(null)}>
          <div className="py-12 px-6 text-center text-slate-400 text-sm">
            <Puzzle className="w-10 h-10 mx-auto mb-3 opacity-40" />
            No extensions installed.
          </div>
        </Sheet>
      )}

      {sheet === 'devices' && (
        <Sheet title="Send to devices" dark onClose={() => setSheet(null)}>
          <div className="py-12 px-6 text-center text-slate-400 text-sm">
            <MonitorSmartphone className="w-10 h-10 mx-auto mb-3 opacity-40" />
            No other devices found. Sign in on another device to send pages to it.
          </div>
        </Sheet>
      )}

      {sheet === 'about' && (
        <Sheet title="About" dark onClose={() => setSheet(null)}>
          <div className="px-6 pb-6 text-sm text-slate-300 leading-relaxed">
            <div className="flex items-center gap-3 mb-3">
              <span className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-500 to-emerald-400 flex items-center justify-center">
                <Globe className="w-7 h-7 text-white" />
              </span>
              <div>
                <p className="text-white font-semibold">E-Browser</p>
                <p className="text-slate-400 text-xs">Version 1.0</p>
              </div>
            </div>
            A fast, simple browser with a personal start page.
          </div>
        </Sheet>
      )}

      {/* ── settings ── */}
      {sheet === 'settings' && (
        <Sheet title="Settings" dark onClose={() => setSheet(null)}>
          <div className="px-5 pb-4 space-y-5">
            <div>
              <p className="text-[13px] text-slate-400 mb-2">Appearance</p>
              <div className="grid grid-cols-3 gap-2">
                {(['system', 'light', 'dark'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setSettings((s) => ({ ...s, theme: m }))}
                    className={`h-10 rounded-xl text-sm font-medium capitalize ${settings.theme === m ? 'bg-sky-600 text-white' : 'bg-white/10 text-slate-200'}`}
                  >
                    {m === 'system' ? 'System' : m}
                  </button>
                ))}
              </div>
            </div>
            {[
              { k: 'wallpaper', label: 'Wallpaper' },
              { k: 'links', label: 'Quick links' },
              { k: 'news', label: 'News and more' },
            ].map((row) => (
              <div key={row.k} className="flex items-center justify-between">
                <span className="text-[15px]">{row.label}</span>
                <Switch label={row.label} on={settings[row.k as 'wallpaper' | 'links' | 'news']} onChange={(v) => setSettings((s) => ({ ...s, [row.k]: v }))} />
              </div>
            ))}
            <div className="flex items-center justify-between">
              <span className="text-[15px]">Search engine</span>
              <span className="text-[14px] text-slate-400">Web search</span>
            </div>
            <button onClick={() => openSheet('deletedata')} className="w-full flex items-center justify-between h-11 text-[15px]">
              Clear browsing data <ChevronRight className="w-5 h-5 text-slate-400" />
            </button>
            <button onClick={() => openSheet('about')} className="w-full flex items-center justify-between h-11 text-[15px]">
              About <ChevronRight className="w-5 h-5 text-slate-400" />
            </button>
          </div>
        </Sheet>
      )}

      {/* ── customise (start page) ── */}
      {sheet === 'customise' && (
        <Sheet title="Customise your page" dark onClose={() => setSheet(null)}>
          <div className="px-5 pb-4 space-y-4">
            {[
              { k: 'wallpaper', label: 'Wallpaper', sub: 'A new picture every day' },
              { k: 'links', label: 'Quick links', sub: 'Shortcuts to your favourite sites' },
              { k: 'news', label: 'News and more', sub: 'Stories, trending topics and tech' },
            ].map((row) => (
              <div key={row.k} className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[15px]">{row.label}</p>
                  <p className="text-[12px] text-slate-400">{row.sub}</p>
                </div>
                <Switch label={row.label} on={settings[row.k as 'wallpaper' | 'links' | 'news']} onChange={(v) => setSettings((s) => ({ ...s, [row.k]: v }))} />
              </div>
            ))}
            {feed?.wallpaper && <p className="text-[11px] text-slate-500 pt-1">Today&apos;s picture: {feed.wallpaper.title.slice(0, 140)}</p>}
          </div>
        </Sheet>
      )}

      {/* ── add shortcut ── */}
      {sheet === 'addlink' && (
        <Sheet title="Add a shortcut" dark onClose={() => setSheet(null)}>
          <form
            className="px-5 pb-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const name = linkName.trim() || hostOf(linkUrl.trim());
              const url = linkUrl.trim();
              if (!url || !looksLikeUrl(url.replace(/^https?:\/\//i, ''))) return say('Enter a valid web address');
              setLinks((p) => [...p, { name: name.slice(0, 18), url: fullUrl(url) }]);
              setLinkName('');
              setLinkUrl('');
              setSheet(null);
              say('Shortcut added');
            }}
          >
            <input value={linkName} onChange={(e) => setLinkName(e.target.value)} placeholder="Name" className="w-full h-12 rounded-xl bg-white/10 px-4 text-base outline-none select-text" />
            <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="Web address (example.com)" inputMode="url" autoCapitalize="none" autoCorrect="off" className="w-full h-12 rounded-xl bg-white/10 px-4 text-base outline-none select-text" />
            <button type="submit" className="w-full h-12 rounded-xl bg-sky-600 font-semibold">Add</button>
            {links.length > 0 && (
              <div className="pt-2">
                <p className="text-[12px] text-slate-400 mb-1">Your shortcuts</p>
                {links.map((l, i) => (
                  <div key={l.url + i} className="flex items-center justify-between h-11">
                    <span className="truncate text-[15px]">{l.name}</span>
                    <button type="button" onClick={() => setLinks((p) => p.filter((_, j) => j !== i))} aria-label={`Remove ${l.name}`} className="w-9 h-9 flex items-center justify-center text-slate-400">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </form>
        </Sheet>
      )}

      {/* ── sign in (local profile) ── */}
      {sheet === 'signin' && (
        <Sheet title={profile ? 'Account' : 'Sign in'} dark onClose={() => setSheet(null)}>
          <div className="px-5 pb-4">
            {profile ? (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <span className="w-14 h-14 rounded-full bg-sky-600 flex items-center justify-center text-xl font-semibold">{initial}</span>
                  <div>
                    <p className="text-base font-semibold">{profile}</p>
                    <p className="text-[12px] text-slate-400">Favourites and history are kept on this device.</p>
                  </div>
                </div>
                <button onClick={() => { setProfile(''); setSheet(null); say('Signed out'); }} className="w-full h-12 rounded-xl bg-white/10 font-semibold">Sign out</button>
              </>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!signinName.trim()) return;
                  setProfile(signinName.trim().slice(0, 24));
                  setSigninName('');
                  setSheet(null);
                  say('Signed in');
                }}
              >
                <p className="text-[13px] text-slate-400">Choose a name for this profile. Your favourites and history stay on this device.</p>
                <input value={signinName} onChange={(e) => setSigninName(e.target.value)} placeholder="Your name" className="w-full h-12 rounded-xl bg-white/10 px-4 text-base outline-none select-text" />
                <button type="submit" className="w-full h-12 rounded-xl bg-sky-600 font-semibold">Continue</button>
              </form>
            )}
          </div>
        </Sheet>
      )}

      {/* ── delete data ── */}
      {sheet === 'deletedata' && (
        <Sheet title="Delete browsing data" dark onClose={() => setSheet(null)}>
          <div className="px-5 pb-4 space-y-3">
            {[
              { k: 'history', label: 'History' },
              { k: 'favs', label: 'Favourites' },
              { k: 'links', label: 'Shortcuts' },
              { k: 'settings', label: 'Settings and profile' },
            ].map((row) => (
              <label key={row.k} className="flex items-center justify-between h-10 text-[15px]">
                {row.label}
                <input type="checkbox" checked={del[row.k as keyof typeof del]} onChange={(e) => setDel((d) => ({ ...d, [row.k]: e.target.checked }))} className="w-5 h-5 accent-sky-500" />
              </label>
            ))}
            <button onClick={deleteData} className="w-full h-12 rounded-xl bg-rose-600 font-semibold mt-2">Delete</button>
          </div>
        </Sheet>
      )}

      {/* ── tab switcher ── */}
      {showTabs && (
        <div className={`absolute inset-0 z-40 flex flex-col ${dark ? 'bg-[#161616] text-white' : 'bg-slate-100 text-slate-900'}`}>
          <div className="flex items-center justify-between px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3">
            <h2 className="text-base font-semibold">{tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}</h2>
            <button onClick={() => setShowTabs(false)} className="text-sm font-semibold text-sky-500 px-2 py-1">Done</button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-4 grid grid-cols-2 gap-3 content-start no-scrollbar">
            {tabs.map((t) => {
              const q = t.stack[t.idx];
              return (
                <div
                  key={t.id}
                  onClick={() => {
                    setActiveId(t.id);
                    setShowTabs(false);
                  }}
                  className={`relative rounded-2xl p-3 h-36 shadow-sm ring-2 ${t.priv ? 'bg-[#2a2146]' : dark ? 'bg-[#2b2b2b]' : 'bg-white'} ${t.id === activeId ? 'ring-sky-400' : 'ring-transparent'}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium truncate pr-2 flex items-center gap-1">
                      {t.priv && <EyeOff className="w-3 h-3 flex-shrink-0" />}
                      {q || (t.priv ? 'Private tab' : 'New tab')}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.id);
                      }}
                      aria-label="Close tab"
                      className="w-6 h-6 rounded-full bg-black/10 flex items-center justify-center"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className={`h-20 rounded-xl flex items-center justify-center ${dark ? 'bg-white/5' : 'bg-slate-100'}`}>
                    {q ? <Search className="w-7 h-7 opacity-30" /> : <Globe className="w-7 h-7 opacity-30" />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="px-4 pb-[max(14px,env(safe-area-inset-bottom))] grid grid-cols-2 gap-3">
            <button onClick={() => addTab(false)} className="h-12 rounded-full bg-sky-600 text-white font-semibold text-sm flex items-center justify-center gap-2 active:scale-[0.98]">
              <Plus className="w-5 h-5" /> New tab
            </button>
            <button onClick={() => addTab(true)} className={`h-12 rounded-full font-semibold text-sm flex items-center justify-center gap-2 active:scale-[0.98] ${dark ? 'bg-white/10' : 'bg-slate-800 text-white'}`}>
              <EyeOff className="w-5 h-5" /> Private
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
