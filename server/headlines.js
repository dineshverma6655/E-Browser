// Notifications are made to look like an ordinary news alert, so nobody glancing at the phone suspects a chat.
// The text is a REAL current headline from the same public feed the start page already shows (Hacker News top stories),
// never anything about the chat. Falls back to neutral generic lines if the feed cannot be reached.
const TTL_MS = 10 * 60 * 1000;
const MAX_WAIT_MS = 1200; // a notification never waits longer than this for a fresh headline
let cache = { at: 0, titles: [] };
let cursor = 0;
let inflight = null;

const FALLBACK = [
  'How modern browsers keep your tabs fast and secure',
  'A short guide to web performance in 2026',
  'Open-source databases: what changed this year',
  'Why simple software lasts longer',
];

function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const opts = { signal: AbortSignal.timeout(5000) };
      const ids = await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', opts)).json();
      const items = await Promise.all(ids.slice(0, 20).map((id) => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, opts).then((r) => r.json())));
      const titles = items.filter((i) => i && i.title).map((i) => String(i.title).slice(0, 110));
      if (titles.length) cache = { at: Date.now(), titles };
    } catch {
      /* keep whatever we had; the caller falls back below */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Load the feed in the background at start-up so the first notification does not have to wait for the network.
function warm() {
  refresh();
}

// Next headline, rotating so two notifications in a row never show the same one.
async function nextHeadline() {
  if (!cache.titles.length || Date.now() - cache.at > TTL_MS) {
    await Promise.race([refresh(), new Promise((r) => setTimeout(r, MAX_WAIT_MS))]);
  }
  const list = cache.titles.length ? cache.titles : FALLBACK;
  cursor = (cursor + 1) % list.length;
  return list[cursor];
}

module.exports = { nextHeadline, warm };
