# Firecrawl usage guide (saved 2026-07-04, owner-provided)

> API keys are NEVER stored in this file - they live in `.env.local` as `FIRECRAWL_API_KEY_1..N`
> (server-side only, rotation via `firecrawlKeysFromEnv`). The session key that arrived with this
> document was moved there.

Firecrawl gives agents and apps web context: search first, scrape clean content, interact with
live pages when plain extraction is not enough.

## How THIS project uses it (Fetch V2 doctrine - surgical, cheapest-possible)
- `POST /v2/search` (2 credits): quoted exact-match "CODE" escalation ONLY when Brave's free
  results carry no code. Snippets only - the result list itself is the evidence.
- `POST /v2/scrape` (1 credit, `proxy:"basic"`, `formats:["rawHtml"]`): LAST resort, max 1 per
  code, only for a decisive bot-blocked candidate. NEVER whole-site crawls, NEVER LLM-extract
  formats (5 credits), NEVER stealth proxy unless a specific case demands it.
- Key rotation on 402/429 across `FIRECRAWL_API_KEY_1..N`; a fully exhausted key set degrades
  cleanly to Brave-only (never throws into the scan flow).
- Budget guard: every batch script hard-caps credits (`FC_CREDIT_CAP` env).

## Install (full CLI + skills, optional)
```bash
npx -y firecrawl-cli@latest init --all --browser
```
Gives: CLI tools (`firecrawl search|scrape|interact|ask|docs-search`), CLI skills, build skills,
workflow skills, and browser auth.

## REST API (what our code uses - no install needed)
- Base: `https://api.firecrawl.dev/v2` - Auth: `Authorization: Bearer fc-...`
- `POST /search` {query, limit} - discovery by query; quoted query = exact-match contract
- `POST /scrape` {url, formats, onlyMainContent, proxy} - one URL to markdown/rawHtml
- `POST /interact` - browser actions (clicks/forms) when extraction is not enough
- `POST /support/ask` {question, jobId?} - AI support diagnoses a failing call from job logs
- `POST /support/docs-search` {question} - grounded answers from Firecrawl docs
- Docs: https://docs.firecrawl.dev

## Getting keys (Path D summary)
Browser sign-in at https://www.firecrawl.dev/signin - or agent flow: generate PKCE params, human
opens `firecrawl.dev/cli-auth?...`, agent polls `POST /api/auth/cli/status` for the key.
Keyless free tier exists (rate-limited fallback): same endpoints without the Authorization header;
MCP at `https://mcp.firecrawl.dev/v2/mcp`.

## Useful facts
- `firecrawl ask` with a failing jobId beats guessing at errors.
- Search+scrape+interact work keyless (rate-limited); crawl/map/agent need a key.
- Full skill segments: CLI skills (run commands now), build skills (wire API into product code),
  workflow skills (finished deliverables).
