(() => {
'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const sess = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
};
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v; // trusted static strings only
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  kids.flat().forEach((c) => c != null && e.append(c));
  return e;
}

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>', fwd: '<path d="M9 18l6-6-6-6"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  menu: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7-2.6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
  download: '<path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 20h16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5H5V6h5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
};
const svg = (n) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
$$('[data-ic]').forEach((e) => e.insertAdjacentHTML('afterbegin', svg(e.dataset.ic)));

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const pretty = (u) => (u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
function avatar(url, cls = 'fav') {
  const host = hostOf(url) || '?';
  let n = 0; for (const c of host) n = (n * 31 + c.charCodeAt(0)) % 360;
  return h('span', { class: cls, style: `background:hsl(${n} 62% 46%)` }, (host[0] || '?').toUpperCase());
}

/* ---------- state ---------- */
const ENGINES = {
  ddg: ['DuckDuckGo', 'https://html.duckduckgo.com/html/?q=%s'],
  bing: ['Bing', 'https://www.bing.com/search?q=%s'],
  google: ['Google', 'https://www.google.com/search?q=%s&hl=en'],
  wiki: ['Wikipedia', 'https://en.wikipedia.org/w/index.php?search=%s'],
};
const DEFAULT_TILES = [
  ['Wikipedia', 'https://www.wikipedia.org'], ['DuckDuckGo', 'https://html.duckduckgo.com/html/'],
  ['Google', 'https://www.google.com/?hl=en'], ['Bing', 'https://www.bing.com'],
  ['BBC', 'https://www.bbc.com'], ['Hacker News', 'https://news.ycombinator.com'],
  ['GitHub', 'https://github.com'], ['Reddit', 'https://old.reddit.com'],
];
let bookmarks = store.get('eb.bm', []);
let historyList = store.get('eb.hist', []);
let engine = store.get('eb.engine', 'ddg'); if (!ENGINES[engine]) engine = 'ddg';
let themePref = store.get('eb.theme', 'auto');

let tabs = [], activeId = null, uid = 0;
const cur = () => tabs.find((t) => t.id === activeId);
const urlOf = (t) => (t && t.idx >= 0 ? t.hist[t.idx] : '');
const proxyUrl = (u) => '/proxy?url=' + encodeURIComponent(u);

/* ---------- theme ---------- */
function applyTheme() {
  document.documentElement.dataset.theme = themePref === 'auto' ? '' : themePref;
  requestAnimationFrame(() => {
    const m = $('meta[name="theme-color"]');
    if (m) m.content = getComputedStyle($('#top')).backgroundColor;
  });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

/* ---------- input -> url ---------- */
function parseInput(raw) {
  const s = raw.trim(); if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return /^https?:/i.test(s) ? s : engineUrl(s);
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(s)) return 'http://' + s;
  if (!/\s/.test(s) && /^[^\s/]+\.[a-z]{2,}([:/?#]|$)/i.test(s)) return 'https://' + s;
  return engineUrl(s);
}
const engineUrl = (q) => ENGINES[engine][1].replace('%s', encodeURIComponent(q));

/* ---------- tabs ---------- */
function saveTabs() {
  store.set('eb.tabs', {
    active: tabs.findIndex((t) => t.id === activeId),
    tabs: tabs.map((t) => ({ hist: t.hist.slice(-30), idx: Math.min(t.idx, 29), title: t.title })),
  });
}
function createTab(url, activate = true) {
  if (tabs.length >= 20) { toast('Maximum 20 tabs'); return null; }
  const t = { id: ++uid, hist: [url || ''], idx: 0, title: '', iframe: null, loading: false };
  tabs.push(t);
  if (activate) switchTo(t.id); else render();
  return t;
}
function switchTo(id) {
  activeId = id; const t = cur();
  if (urlOf(t) && !t.iframe) loadTab(t); else render();
  saveTabs();
  if (!urlOf(t)) setTimeout(() => { if (matchMedia('(pointer:fine)').matches) $('#homeInput').focus(); }, 0);
}
function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id); if (i < 0) return;
  tabs[i].iframe?.remove(); tabs.splice(i, 1);
  if (!tabs.length) { createTab('', true); return; }
  if (activeId === id) switchTo(tabs[Math.min(i, tabs.length - 1)].id); else { render(); saveTabs(); }
}
function loadTab(t) {
  const url = urlOf(t);
  if (!url) { t.loading = false; render(); return; }
  if (!t.iframe) {
    t.iframe = h('iframe', {
      sandbox: 'allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-presentation',
      referrerpolicy: 'no-referrer', title: 'Web page', allow: 'fullscreen',
    });
    t.iframe.addEventListener('load', () => { if (t.loading) { t.loading = false; render(); } });
    $('#views').append(t.iframe);
  }
  t.loading = true;
  t.iframe.src = proxyUrl(url);
  render();
}
function navigate(t, url, push = true) {
  if (!t || !url) return;
  if (push) {
    t.hist = t.hist.slice(0, t.idx + 1);
    if (urlOf(t) !== url) { t.hist.push(url); t.idx++; }
  } else t.hist[t.idx] = url;
  t.title = '';
  loadTab(t); saveTabs();
}
function go(t, delta) {
  const ni = t.idx + delta; if (ni < 0 || ni >= t.hist.length) return;
  t.idx = ni; t.title = '';
  loadTab(t); saveTabs();
}
function addHistory(url, title) {
  const last = historyList[0];
  if (last && last.url === url && Date.now() - last.t < 30000) { if (title) last.title = title; }
  else historyList.unshift({ url, title: title || '', t: Date.now() });
  historyList = historyList.slice(0, 500); store.set('eb.hist', historyList);
}

/* messages from proxied pages */
addEventListener('message', (e) => {
  const d = e.data; if (!d || d.eb !== 1) return;
  const t = tabs.find((x) => x.iframe && x.iframe.contentWindow === e.source); if (!t) return;
  if (d.type === 'nav' && typeof d.url === 'string') navigate(t, d.url);
  else if (d.type === 'newtab' && typeof d.url === 'string') { if (/^https?:/i.test(d.url)) createTab(d.url, true); }
  else if (d.type === 'external' && typeof d.url === 'string') openExternal(d.url);
  else if (d.type === 'reload') loadTab(t);
  else if (d.type === 'loaded' && typeof d.url === 'string' && /^https?:/i.test(d.url)) {
    t.hist[t.idx] = d.url; t.title = String(d.title || '').slice(0, 120); t.loading = false;
    addHistory(d.url, t.title); render(); saveTabs();
  }
});
function openExternal(url) {
  if (!/^(https?|mailto|tel|sms):/i.test(url)) return;
  window.open(url, '_blank', 'noopener');
}

/* ---------- render ---------- */
let progOn = false;
function progress(on) {
  const i = $('#progress i');
  if (on && !progOn) {
    i.style.transition = 'none'; i.style.width = '0'; i.style.opacity = '1'; void i.offsetWidth;
    i.style.transition = 'width 9s cubic-bezier(.1,.8,.2,1)'; i.style.width = '85%';
  } else if (!on && progOn) {
    i.style.transition = 'width .2s'; i.style.width = '100%';
    setTimeout(() => { if (!progOn) { i.style.transition = 'opacity .3s'; i.style.opacity = '0'; } }, 220);
  }
  progOn = on;
}
const bookmarked = (u) => bookmarks.some((b) => b.url === u);
const standalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;

function render() {
  const t = cur(); if (!t) return;
  const url = urlOf(t);

  // tabs
  const strip = $('#tabs'); strip.textContent = '';
  tabs.forEach((x) => {
    const u = urlOf(x);
    const title = x.title || (u ? hostOf(u) : 'Naya tab');
    const chip = h('div', { class: 'tab' + (x.id === activeId ? ' active' : '') + (x.loading ? ' loading' : ''), role: 'tab', title, onclick: () => switchTo(x.id) },
      u ? avatar(u) : h('span', { class: 'fav', style: 'background:var(--brand)' }, 'E'),
      h('span', { class: 'tt' }, title),
      h('button', { class: 'cl', type: 'button', 'aria-label': 'Tab band karein', html: svg('x'), onclick: (ev) => { ev.stopPropagation(); closeTab(x.id); } }));
    strip.append(chip);
    if (x.id === activeId) requestAnimationFrame(() => chip.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });

  // views
  $('#home').hidden = !!url;
  tabs.forEach((x) => { if (x.iframe) x.iframe.style.display = x === t && url ? 'block' : 'none'; });
  if (!url) renderHome();

  // omnibox
  const addr = $('#addr');
  if (document.activeElement !== addr) addr.value = pretty(url);
  const lock = $('#lock');
  const secure = url.startsWith('https:'), insecure = url.startsWith('http:');
  lock.className = 'lock' + (secure ? ' ok' : insecure ? ' bad' : '');
  lock.innerHTML = svg(secure ? 'lock' : insecure ? 'unlock' : 'search');
  lock.title = secure ? 'Secure connection' : insecure ? 'Not secure' : '';

  // buttons
  const canBack = t.idx > 0, canFwd = t.idx < t.hist.length - 1, bm = bookmarked(url);
  $('#backBtn').disabled = !canBack; $('#fwdBtn').disabled = !canFwd;
  $('#reloadBtn').disabled = !url; $('#homeBtn').disabled = !url && t.hist.length <= 1;
  $('#starBtn').disabled = !url; $('#starBtn').classList.toggle('on', bm);
  const mf = $('#menu [data-act=forward]'); mf.disabled = !canFwd;
  $('#menu [data-act=reload]').disabled = !url;
  const ms = $('#menu [data-act=star]'); ms.disabled = !url; ms.classList.toggle('on', bm);
  $('#menu [data-act=external]').disabled = !url;
  document.title = (t.title ? t.title + ' - ' : '') + 'E-Browser';
  progress(!!t.loading);
  installUI();
}

function renderHome() {
  const box = $('#tiles'); box.textContent = '';
  const items = bookmarks.slice(0, 8).map((b) => [b.title || hostOf(b.url), b.url]);
  for (const d of DEFAULT_TILES) if (items.length < 8 && !items.some((i) => i[1] === d[1])) items.push(d);
  items.forEach(([name, url]) => box.append(
    h('button', { class: 'tile', type: 'button', onclick: () => navigate(cur(), url) }, avatar(url), h('span', { class: 'l' }, name))));
}

/* ---------- omnibox + suggestions ---------- */
const addr = $('#addr'), sugg = $('#sugg');
let suggTimer, suggSeq = 0, suggItems = [], suggSel = -1;

function hideSugg() { sugg.hidden = true; suggItems = []; suggSel = -1; }
function showSugg(list) {
  suggItems = list; suggSel = -1; sugg.textContent = '';
  if (!list.length) { sugg.hidden = true; return; }
  list.forEach((s, i) => sugg.append(h('button', { class: 'sg', type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => pick(i) },
    h('span', { html: svg(s.kind === 'web' ? 'globe' : s.kind === 'hist' ? 'clock' : 'search') }),
    h('span', {}, s.label, s.sub ? h('small', {}, s.sub) : null))));
  sugg.hidden = false;
}
function pick(i) {
  const s = suggItems[i]; if (!s) return;
  hideSugg(); addr.blur(); navigate(cur(), s.url);
}
function localMatches(q) {
  const ql = q.toLowerCase(), out = [], seen = new Set();
  for (const b of [...bookmarks, ...historyList]) {
    if (out.length >= 4) break;
    if (seen.has(b.url)) continue;
    if ((b.title || '').toLowerCase().includes(ql) || b.url.toLowerCase().includes(ql)) {
      seen.add(b.url);
      out.push({ kind: bookmarks.includes(b) ? 'web' : 'hist', label: b.title || pretty(b.url), sub: pretty(b.url), url: b.url });
    }
  }
  return out;
}
addr.addEventListener('input', () => {
  const q = addr.value.trim(); clearTimeout(suggTimer);
  if (!q) return hideSugg();
  const local = localMatches(q);
  showSugg([{ kind: 'q', label: q, url: parseInput(q) }, ...local]);
  const seq = ++suggSeq;
  suggTimer = setTimeout(async () => {
    try {
      const r = await fetch('/suggest?q=' + encodeURIComponent(q)); const list = await r.json();
      if (seq !== suggSeq || document.activeElement !== addr) return;
      showSugg([{ kind: 'q', label: q, url: parseInput(q) }, ...local,
        ...list.filter((x) => x.toLowerCase() !== q.toLowerCase()).map((x) => ({ kind: 'q', label: x, url: engineUrl(x) }))]);
    } catch {}
  }, 160);
});
addr.addEventListener('focus', () => { const t = cur(); addr.value = urlOf(t); setTimeout(() => addr.select(), 0); });
addr.addEventListener('blur', () => { hideSugg(); render(); });
addr.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { addr.blur(); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggItems.length) {
    e.preventDefault();
    suggSel = (suggSel + (e.key === 'ArrowDown' ? 1 : -1) + suggItems.length) % suggItems.length;
    $$('.sg', sugg).forEach((el, i) => el.classList.toggle('sel', i === suggSel));
    addr.value = suggItems[suggSel].url.startsWith('http') && suggItems[suggSel].kind !== 'q' ? suggItems[suggSel].url : suggItems[suggSel].label;
  }
});
$('#omni').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = suggSel >= 0 && suggItems[suggSel] ? suggItems[suggSel].url : parseInput(addr.value);
  hideSugg(); addr.blur(); if (url) navigate(cur(), url);
});
$('#homeForm').addEventListener('submit', (e) => {
  e.preventDefault(); const i = $('#homeInput'); const url = parseInput(i.value); i.value = ''; i.blur();
  if (url) navigate(cur(), url);
});

/* ---------- toolbar ---------- */
$('#backBtn').onclick = () => go(cur(), -1);
$('#fwdBtn').onclick = () => go(cur(), 1);
$('#reloadBtn').onclick = () => loadTab(cur());
$('#homeBtn').onclick = () => { const t = cur(); if (urlOf(t)) navigate(t, ''); };
$('#newTabBtn').onclick = () => createTab('');
$('#starBtn').onclick = toggleBookmark;
function toggleBookmark() {
  const t = cur(), u = urlOf(t); if (!u) return;
  if (bookmarked(u)) { bookmarks = bookmarks.filter((b) => b.url !== u); toast('Bookmark hata diya'); }
  else { bookmarks.unshift({ url: u, title: t.title || hostOf(u) }); toast('Bookmark save ho gaya ⭐'); }
  store.set('eb.bm', bookmarks); render();
}

/* ---------- menu ---------- */
function openMenu() {
  const r = $('#menuBtn').getBoundingClientRect();
  $('#menu').style.setProperty('--menu-top', r.bottom + 6 + 'px');
  $('#menu').hidden = false; $('#menuScrim').hidden = false;
}
function closeMenu() { $('#menu').hidden = true; $('#menuScrim').hidden = true; }
$('#menuBtn').onclick = () => ($('#menu').hidden ? openMenu() : closeMenu());
$('#menuScrim').onclick = closeMenu;
$('#menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  closeMenu(); const t = cur();
  ({
    forward: () => go(t, 1), reload: () => loadTab(t), star: toggleBookmark, home: () => navigate(t, ''),
    newtab: () => createTab(''), bookmarks: openBookmarks, history: openHistory, settings: openSettings,
    external: () => openExternal(urlOf(t)), install: doInstall,
  })[b.dataset.act]?.();
});

/* ---------- sheets ---------- */
function openSheet(title, ...content) {
  $('#sheetTitle').textContent = title; const body = $('#sheetBody'); body.textContent = ''; body.append(...content);
  $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

function listRow(item, onDelete) {
  const open = () => { closeSheet(); navigate(cur(), item.url); };
  return h('div', { class: 'row' }, avatar(item.url),
    h('button', { class: 'main', type: 'button', onclick: open }, h('b', {}, item.title || pretty(item.url)), h('small', {}, pretty(item.url))),
    h('button', { class: 'ibtn sm', type: 'button', 'aria-label': 'Hatayein', html: svg('trash'), onclick: onDelete }));
}
function openBookmarks() {
  const draw = () => {
    openSheet('Bookmarks', bookmarks.length
      ? bookmarks.map((b) => listRow(b, () => { bookmarks = bookmarks.filter((x) => x !== b); store.set('eb.bm', bookmarks); draw(); render(); }))
      : h('div', { class: 'empty' }, 'Abhi koi bookmark nahi. Kisi page par ⭐ dabayein.'));
  }; draw();
}
function openHistory() {
  const draw = () => {
    const nodes = [];
    if (historyList.length) {
      nodes.push(h('button', { class: 'btn danger', type: 'button', onclick: () => { historyList = []; store.set('eb.hist', []); draw(); } }, 'Poori history saaf karein'));
      let lastDay = '';
      historyList.slice(0, 150).forEach((it) => {
        const day = new Date(it.t).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
        if (day !== lastDay) { nodes.push(h('div', { class: 'sec' }, day)); lastDay = day; }
        nodes.push(listRow(it, () => { historyList = historyList.filter((x) => x !== it); store.set('eb.hist', historyList); draw(); }));
      });
    } else nodes.push(h('div', { class: 'empty' }, 'History khaali hai.'));
    openSheet('History', nodes);
  }; draw();
}
function openSettings() {
  const seg = h('div', { class: 'seg' });
  [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].forEach(([k, label]) =>
    seg.append(h('button', { type: 'button', class: themePref === k ? 'on' : '', onclick: () => {
      themePref = k; store.set('eb.theme', k); applyTheme(); $$('button', seg).forEach((b) => b.classList.toggle('on', b === seg.children[['auto', 'light', 'dark'].indexOf(k)]));
    } }, label)));
  const sel = h('select', { 'aria-label': 'Search engine', onchange: (e) => { engine = e.target.value; store.set('eb.engine', engine); toast('Search engine: ' + ENGINES[engine][0]); } },
    Object.entries(ENGINES).map(([k, v]) => h('option', { value: k, ...(k === engine ? { selected: '' } : {}) }, v[0])));
  openSheet('Settings',
    h('div', { class: 'fld' }, h('span', {}, 'Theme'), seg),
    h('div', { class: 'fld' }, h('span', {}, 'Search engine'), sel),
    h('div', { class: 'sec' }, 'Privacy'),
    h('button', { class: 'btn danger', type: 'button', onclick: () => { historyList = []; store.set('eb.hist', []); toast('History saaf ho gayi'); } }, 'History saaf karein'),
    h('button', { class: 'btn danger', type: 'button', onclick: () => { bookmarks = []; store.set('eb.bm', []); render(); toast('Bookmarks hata diye'); } }, 'Bookmarks hatayein'),
    h('div', { class: 'sec' }, 'Jaankari'),
    h('p', { class: 'empty', style: 'padding:6px 8px;text-align:left' },
      'E-Browser pages ko apne server ke through kholta hai taaki zyadatar sites tab ke andar chal sakein. Login/cookies save nahi hoti, isliye banking jaise login-wale sites ke liye "Real browser me kholein" use karein.'));
}

/* ---------- install (PWA) ---------- */
let deferredPrompt = null;
const dismissed = () => sess.get('eb.installDismissed') === '1';
function installUI() {
  const show = !standalone();
  $('#installBtn').hidden = !show;
  $('#menuInstall').hidden = !show;
  $('#installBar').hidden = !show || dismissed();
  $('#homeInstall').hidden = !show;
}
async function doInstall() {
  if (deferredPrompt) {
    const p = deferredPrompt; deferredPrompt = null;
    try { await p.prompt(); const r = await p.userChoice; if (r.outcome === 'accepted') toast('Install ho raha hai…'); } catch {}
    installUI(); return;
  }
  if (standalone()) { toast('E-Browser pehle se installed hai ✅'); return; }
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua);
  let steps;
  if (ios) steps = ['Safari me neeche ya upar <b>Share</b> (⬆︎) button dabayein', '<b>Add to Home Screen</b> chunein', '<b>Add</b> dabayein - E-Browser icon home screen par aa jayega'];
  else if (android) steps = ['Chrome me upar right <b>⋮</b> menu kholein', '<b>Install app</b> (ya <b>Add to Home screen</b>) chunein', '<b>Install</b> dabayein'];
  else steps = ['Address bar ke right me <b>Install</b> icon (⊕) dhoondhein', 'Ya browser menu → <b>Install E-Browser</b> / <b>Apps → Install this site as an app</b>', '<b>Install</b> dabayein'];
  openSheet('E-Browser install karein',
    h('div', { class: 'help' },
      h('p', {}, 'Is browser ne abhi automatic install prompt nahi diya. In steps se install karein:'),
      h('ol', {}, steps.map((s) => h('li', { html: s }))),
      h('p', {}, location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname)
        ? '⚠️ Install ke liye site HTTPS par honi chahiye.' : 'Install hone ke baad app full screen me khulega.')));
}
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installUI(); });
addEventListener('appinstalled', () => { deferredPrompt = null; installUI(); toast('E-Browser install ho gaya! 🎉'); });
matchMedia('(display-mode: standalone)').addEventListener?.('change', installUI);
['#installBtn', '#installBarBtn', '#homeInstallBtn'].forEach((s) => $(s).addEventListener('click', doInstall));
$('#installBarClose').onclick = () => { sess.set('eb.installDismissed', '1'); installUI(); };

/* ---------- keyboard / back button ---------- */
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); closeSheet(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); addr.focus(); }
});
history.pushState({ eb: 1 }, '');
addEventListener('popstate', () => {
  history.pushState({ eb: 1 }, '');
  if (!$('#sheet').hidden) return closeSheet();
  if (!$('#menu').hidden) return closeMenu();
  const t = cur(); if (t && t.idx > 0) go(t, -1);
  else if (tabs.length > 1) closeTab(activeId);
});

/* ---------- boot ---------- */
applyTheme();
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

(function boot() {
  const saved = store.get('eb.tabs', null);
  const q = new URLSearchParams(location.search);
  if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
    saved.tabs.slice(0, 20).forEach((s) => {
      const hist = Array.isArray(s.hist) && s.hist.length ? s.hist.filter((x) => typeof x === 'string') : [''];
      tabs.push({ id: ++uid, hist, idx: Math.max(0, Math.min(s.idx | 0, hist.length - 1)), title: String(s.title || ''), iframe: null, loading: false });
    });
    activeId = tabs[Math.max(0, Math.min(saved.active, tabs.length - 1))].id;
  } else { tabs.push({ id: ++uid, hist: [''], idx: 0, title: '', iframe: null, loading: false }); activeId = tabs[0].id; }
  const open = q.get('u') || q.get('q');
  if (open) createTab(parseInput(open));
  else if (q.get('new') === '1') createTab('');
  else switchTo(activeId);
  history.replaceState({ eb: 1 }, '', '/');
  installUI();
})();
})();
