/**
 * E-Browser server (zero dependencies, Node 18+)
 *  - serves the PWA from /public
 *  - /proxy?url=...   : fetches a page, strips frame-blocking headers, rewrites it so it
 *                       can be shown inside E-Browser tabs (links/forms stay inside the browser)
 *  - /suggest?q=...   : search suggestions
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');

const PORT = process.env.PORT || 4000;
const PUBLIC = path.join(__dirname, 'public');
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1'; // keep OFF on a public server
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 E-Browser/1.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ---------- tiny per-IP rate limiter ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(ip, rec);
  return rec.n > 240;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 120000) hits.delete(k); }, 60000).unref();

/* ---------- SSRF guard ---------- */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}
async function assertPublic(u) {
  if (ALLOW_PRIVATE) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error('Private addresses are blocked'); return; }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private addresses are blocked');
}

/* ---------- script injected into every proxied HTML page ---------- */
function clientScript(realUrl, origin) {
  return `<script>(function(){
var REAL=${JSON.stringify(realUrl)},ORIGIN=${JSON.stringify(origin)};
function send(m){try{m.eb=1;parent.postMessage(m,'*')}catch(e){}}
function abs(u){try{return new URL(u,document.baseURI).href}catch(e){return null}}
function web(u){return u&&/^https?:/i.test(u)}
document.addEventListener('click',function(e){
  if(e.defaultPrevented)return;
  var a=e.target&&e.target.closest?e.target.closest('a[href],area[href]'):null; if(!a)return;
  var h=a.getAttribute('href')||'';
  if(h.charAt(0)==='#'){e.preventDefault();var id=decodeURIComponent(h.slice(1));var el=id&&(document.getElementById(id)||document.getElementsByName(id)[0]);if(el)el.scrollIntoView();else if(!id)scrollTo(0,0);return}
  if(/^(mailto|tel|sms|intent|market|whatsapp):/i.test(h)){e.preventDefault();send({type:'external',url:a.href});return}
  if(/^javascript:/i.test(h))return;
  var u=abs(h); if(!web(u))return;
  e.preventDefault();
  if(a.target==='_blank'||e.ctrlKey||e.metaKey||e.shiftKey)send({type:'newtab',url:u});else send({type:'nav',url:u});
},true);
document.addEventListener('submit',function(e){
  var f=e.target; if(!f||e.defaultPrevented)return;
  var action=abs(f.getAttribute('action')||'')||REAL;
  if(!web(action))return;
  var method=String(f.getAttribute('method')||'get').toLowerCase();
  if(method==='get'){
    e.preventDefault();
    var u=new URL(action),fd=new FormData(f);u.search='';
    fd.forEach(function(v,k){if(typeof v==='string')u.searchParams.append(k,v)});
    send({type:e.submitter&&f.target==='_blank'?'newtab':'nav',url:u.href});
  }else{
    f.setAttribute('action',ORIGIN+'/proxy?url='+encodeURIComponent(action));
    f.removeAttribute('target');
  }
},true);
window.open=function(u){var x=u&&abs(u);if(web(x))send({type:'newtab',url:x});return null};
function loaded(){send({type:'loaded',url:REAL,title:document.title||''})}
document.addEventListener('DOMContentLoaded',loaded);window.addEventListener('load',loaded);
})();</script>`;
}

function inject(html, realUrl, origin) {
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '');
  const tag = `<base href="${realUrl.replace(/"/g, '&quot;')}">` + clientScript(realUrl, origin);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + tag + '</head>');
  return '<!doctype html><head><meta charset="utf-8">' + tag + '</head>' + html;
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function errorPage(title, msg, url, origin) {
  return inject(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f7fc;color:#14213d;margin:0;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}
.c{max-width:460px;text-align:center}.i{font-size:54px}h1{font-size:22px;margin:.4em 0}p{color:#51617f;line-height:1.5;word-break:break-word}
button{background:#1a6fe0;color:#fff;border:0;border-radius:12px;padding:12px 20px;font-size:15px;font-weight:600;margin:6px;cursor:pointer}
button.s{background:#e3ecfb;color:#1a4fa3}@media(prefers-color-scheme:dark){body{background:#0c1424;color:#e6edf9}p{color:#9fb0cf}button.s{background:#182540;color:#9cc0ff}}</style></head>
<body><div class="c"><div class="i">🌐</div><h1>${esc(title)}</h1><p>${esc(msg)}</p><p style="font-size:13px">${esc(url || '')}</p>
<button onclick="parent.postMessage({eb:1,type:'reload'},'*')">Dobara try karein</button>
<button class="s" onclick="parent.postMessage({eb:1,type:'external',url:${esc(JSON.stringify(url || ''))}},'*')">Real browser me kholein</button></div></body></html>`,
    url || 'about:blank', origin);
}

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------- /proxy ---------- */
async function handleProxy(req, res, reqUrl, origin) {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  let target = reqUrl.searchParams.get('url') || '';
  if (!/^https?:\/\//i.test(target)) return send(400, errorPage('Galat address', 'Sirf http aur https addresses khul sakte hain.', target, origin));

  let method = req.method; let body = null;
  const ctype = req.headers['content-type'];
  if (method === 'POST') {
    try { body = await readBody(req); } catch (e) { return send(413, errorPage('Request bahut badi hai', e.message, target, origin)); }
  } else if (method !== 'GET' && method !== 'HEAD') {
    return send(405, errorPage('Not allowed', 'Is request type ki ijazat nahi.', target, origin));
  }

  try {
    let cur = new URL(target); let upstream;
    for (let i = 0; i < 8; i++) {
      await assertPublic(cur);
      upstream = await fetch(cur, {
        method, body, redirect: 'manual', signal: AbortSignal.timeout(25000),
        headers: {
          'user-agent': UA,
          accept: req.headers.accept || 'text/html,application/xhtml+xml,*/*;q=0.8',
          'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
          ...(ctype && body ? { 'content-type': ctype } : {}),
        },
      });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
        cur = new URL(upstream.headers.get('location'), cur);
        if (upstream.status !== 307 && upstream.status !== 308) { method = 'GET'; body = null; }
        continue;
      }
      break;
    }
    const finalUrl = cur.href;
    const type = upstream.headers.get('content-type') || '';
    if (/text\/html|application\/xhtml/i.test(type) || (!type && upstream.status >= 400)) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > 12e6) return send(502, errorPage('Page bahut badi hai', 'Yeh page 12MB se bada hai.', finalUrl, origin));
      let cs = (type.match(/charset=([^;]+)/i) || [])[1];
      if (!cs) cs = (buf.subarray(0, 2048).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
      let text; try { text = new TextDecoder(cs || 'utf-8').decode(buf); } catch { text = buf.toString('utf8'); }
      return send(upstream.status >= 500 ? 200 : upstream.status === 404 ? 404 : 200, inject(text, finalUrl, origin));
    }
    // non-HTML (images, pdf, css, video...) – stream through
    const headers = { 'cache-control': 'no-store' };
    for (const h of ['content-type', 'content-disposition', 'content-length', 'accept-ranges']) {
      const v = upstream.headers.get(h); if (v && !(h === 'content-length' && upstream.headers.get('content-encoding'))) headers[h] = v;
    }
    res.writeHead(upstream.status, headers);
    if (!upstream.body || method === 'HEAD') return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'Site ne jawab dene me bahut der lagayi.' :
      /ENOTFOUND|getaddrinfo/.test(String(e.cause || e)) ? 'Yeh website nahi mili. Address check karein.' :
      /Private/.test(e.message) ? 'Yeh address allowed nahi hai.' : 'Page load nahi ho paya: ' + (e.cause?.code || e.message);
    send(502, errorPage('Page nahi khul paya', msg, target, origin));
  }
}

/* ---------- static ---------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname); if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' || rel === '/sw.js' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=86400',
      'service-worker-allowed': '/',
    });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const origin = `${String(proto).split(',')[0]}://${req.headers.host}`;
    const u = new URL(req.url, origin);
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
    if (u.pathname === '/proxy') {
      if (limited(ip)) { res.writeHead(429, { 'content-type': 'text/plain' }); return res.end('Too many requests'); }
      return await handleProxy(req, res, u, origin);
    }
    if (u.pathname === '/suggest') {
      const q = (u.searchParams.get('q') || '').slice(0, 100);
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
      if (!q || limited(ip)) return res.end('[]');
      try {
        const r = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(4000) });
        const j = await r.json(); return res.end(JSON.stringify((j[1] || []).slice(0, 6)));
      } catch { return res.end('[]'); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, u.pathname);
  } catch (e) { res.writeHead(500); res.end('Server error'); }
}).listen(PORT, () => console.log(`E-Browser chal raha hai: http://localhost:${PORT}`));
