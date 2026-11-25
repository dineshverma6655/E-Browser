# E-Browser

Installable (PWA) mobile browser. Zero dependencies, Node 18+.

## Chalane ka tarika (PC par)
```
cd e-browser
node server.js        # http://localhost:4000
```

## Phone par install karwane ke liye (HTTPS zaroori hai)
Phone me "Install" tabhi aata hai jab site **HTTPS** par ho. Options:
- **Testing:** `cloudflared tunnel --url http://localhost:4000` (ya ngrok) -> jo https link mile use phone me kholein.
- **Hosting:** Render / Railway / Fly.io par deploy karein (Start command: `node server.js`, port `PORT` env se aata hai).

## Security
- Server private/local IPs ko block karta hai (SSRF guard). `ALLOW_PRIVATE=1` sirf local testing ke liye.
- Per-IP rate limit laga hai. Public server par isse open-proxy ki tarah abuse ho sakta hai, isliye zarurat ho to login/allow-list jodein.
