# P2P Duo — Snapchat-Style 1-on-1 Private Mobile Call & Ephemeral Chat

Next.js aur PeerJS par bana **Ultra-Private 1-on-1 Mobile App**. Isme koi database ya chat history store nahi hoti — bilkul **Snapchat** ki tarah kaam karta hai.

---

## 🔒 Snapchat-Style Privacy Features

1. **Ephemeral Chat (Chat Band = Sab Saaf)**:
   - Chat history disk ya database par save **nahi** hoti (RAM/Memory-only).
   - Jaise hi aap chat drawer band karenge ya browser/app band karenge, saare messages **permanently wipe** ho jayenge.
   - Header me ek **"Trash" (Saaf Karein)** button bhi hai jisse 1-tap me chat turant gayab ho sakti hai.

2. **1-Time View Photos (Snapchat Style)**:
   - Photo bhejte samay **"1"** (View Once) badge default on rehta hai.
   - Partner ko *"📷 Photo Dekhein (1 baar khulegi)"* ka card dikhta hai.
   - Tap karne par photo full-screen khulti hai.
   - Jaise hi partner photo band karega, photo **hamesha ke liye expire ho jayegi aur phone ki memory se permanently destroy ho jayegi**.

3. **Permanent 1-Time Link (Connection Hamesha Rahega)**:
   - Har user ka apna permanent code hota hai (e.g. `P2P-849201`).
   - Sirf 1 baar code daal kar pair karna hota hai.
   - Iske baad phone switch off ho ya restart ho, dono devices hamesha **permanently connected** rahenge.

4. **Encrypted Video Calls & Mobile-First Controls**:
   - Live P2P video call (PeerJS DTLS/SRTP).
   - Front/Back camera flip button.
   - Floating Picture-in-Picture (PIP) self-view.
   - Mic Mute / Video Off controls.

---

## 🗄️ PostgreSQL (kya store hota hai)

| Table | Kaam |
|---|---|
| `users` | Device ID + secret ka **hash** (koi aur us ID ko hijack nahi kar sakta) |
| `pairings` | Permanent 1-to-1 pair (UNIQUE — ek banda sirf ek partner) |
| `pending_messages` | Partner offline ho to message tab tak, delivery ke turant baad **delete** (max 24h) |
| `call_logs` | Missed / declined / completed calls + duration |
| `push_subscriptions` | App band ho tab bhi call/message notification |

Chat history kabhi DB me save nahi hoti. Tables Prisma migrations se banti hain (`prisma/schema.prisma`).

## 🚀 Vercel par deploy (Render ki zaroorat nahi)

Poora app (pages + API) ek hi Vercel project me chalta hai. Koi alag backend server nahi hai.

1. Supabase me tables banayein (ek baar, apne computer se): `.env` me `DATABASE_URL` rakhein, phir `npm run db:deploy`.
2. https://pusher.com par free **Channels** app banayein (realtime ke liye). Cluster yaad rakhein.
3. Vercel > Project > Settings > Environment Variables me `env.txt` ke saare variable paste karein
   (`PUSHER_APP_ID`, `PUSHER_SECRET`, `NEXT_PUBLIC_PUSHER_KEY`, `NEXT_PUBLIC_PUSHER_CLUSTER` bhi bharein).
4. Redeploy. Settings panel me Database / Cloud / Push / Realtime sab "OK" dikhna chahiye.

Tips:
- `DATABASE_URL` me Supabase ka **Transaction pooler** (port `6543`) use karein: serverless me connections jaldi khatam hote hain.
- `NEXT_PUBLIC_*` variables badalne ke baad Vercel me **redeploy** zaroori hai.
- Pusher keys na hon to app phir bhi chalta hai, bas calls/messages 5 second tak late aate hain.
- Call signaling free PeerJS Cloud se hoti hai; video/audio/data direct peer-to-peer rehta hai.

## 💻 Local

1. `.env` banayein (`.env.example` dekhein), `npm run db:deploy`, `npm run vapid`.
2. `npm run dev` -> http://localhost:3000

Mobile data / strict NAT par call ke liye TURN server (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`) lagana padega. Mic/camera/push ke liye production me **HTTPS** zaroori hai.

Schema badalna ho to `prisma/schema.prisma` edit karke `npm run db:migrate` chalayein.
