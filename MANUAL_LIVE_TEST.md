# Manual Live AI Decode Test

Automated tests NEVER call live Gemini/OpenAI (they mock the provider routes; the Playwright
webServer runs with `IS_E2E=1`). Use this checklist to do ONE controlled real decode by hand.

## 1. Configure keys (server-side only)
Edit `.env.local` (gitignored, never committed). At minimum set one provider key:

```
GEMINI_API_KEY=your_real_gemini_key
# optional second provider for true cross-checking:
OPENAI_API_KEY=your_real_openai_key

# aggressive dev defaults (already the defaults if unset):
ENABLE_LIVE_AI_LOOKUP=true
ENABLE_AUTO_DECODE_ON_SCAN=true
ENABLE_GEMINI_LOOKUP=true
ENABLE_OPENAI_LOOKUP=true
ENABLE_PREMIUM_MODEL_FALLBACK=true
AI_LOOKUP_MODE=aggressive
AI_LOOKUP_DAILY_LIMIT=100

# only needed if you later add a test that may call live providers:
LIVE_AI_TEST=1
```

Restart the dev server after editing env: stop it, then `npm run dev`.

## 2. Verify the app sees the keys
1. Open http://localhost:3000 and log in.
2. Go to **Settings -> Live AI status**. Confirm:
   - Gemini live lookup: **On (key configured)** (and/or OpenAI).
   - Mode: **aggressive**, Auto decode on scan: **On**.
   - If it says "Missing GEMINI_API_KEY", the key didn't load - check `.env.local` and restart, then
     click **Refresh status**.
3. Turn **Enable AI lookup for unknown codes** = On (top of the AI lookup section).

## 3. Run the live decode on 878106003504
1. Go to **Scan**. Confirm the header shows **Auto decode on scan: On**.
2. Click the scan box and type or scan: `878106003504` then Enter.
3. Watch the **Live Scan Feed** row:
   - It first shows **Decoding with AI...**
   - Then it updates to **Verified AI Decode**, **Suggested**, **Conflict**, or **Needs review**
     (after the attempt) - never stuck on a passive "Unknown".
4. Open **Needs Review** for that code and confirm it shows:
   - Gemini / OpenAI (and premium, if it escalated) under Provider.
   - The suggested product, Source URLs, Evidence strength, and `app-verified: yes/no`.
   - The reason, and an **Approve suggestion** / **Link** button.
5. If you approve it, the alias is saved. Re-scan `878106003504` - it now counts instantly and
   makes **zero** AI calls (deterministic local alias).

## 4. Safety
- Keys are read server-side only (proven by `src/services/keySafety.test.ts`); they never reach the
  browser bundle.
- The daily cap, circuit breaker, and the **Emergency stop** toggle (Settings -> Live AI status) all
  block calls with a clear reason. Use Emergency stop to halt all AI instantly.
- Do not run uncontrolled live loops. One scan = at most: Gemini x2, OpenAI x2, premium x1.
