<!-- subject=stock case=hlaw-qa round=0 elapsed=217s rc=0 -->
**Q1 – Ports**  
- The mock Playwright E2E suite is started on **port 4000**.  
- QA “human‑bot” runs are served from **port 4001**.  

**Q2 – `npm run qa:revision`**  
It chains the following gates (in order):  

```
lint → typecheck → test:unit → build
```  

(Any additional QA‑specific checks are added after `build`).  

**Q3 – Brand families & prefix firewall**  
- **Bridgestone family** – owns *Bridgestone* and the *Goodyear* brand.  
- **Continental family** – owns *Continental* and *Pirelli*.  

The prefix firewall uses these corporate groupings to map a request’s
brand‑prefix to the correct tenant; it prevents a tenant from seeing data
belonging to another brand in the same corporate family.  

**Q4 – Tenant scoping & rejected design**  
Tenant data is stored under a collection path that includes the business ID:  

```
/tenants/{businessId}/…
```  

The “top‑level‑collection + businessId field” approach was rejected because
queries could still read across tenants (the field can be indexed and
queried), breaking the rule‑based isolation guarantees.  

**Q5 – `catalogEntries`**  
`catalogEntries` is a Firestore sub‑collection that holds the product
catalog for each tenant.  Only privileged service accounts (or admin
functions) may write to it; client code can only read.  

**Q6 – Tenant‑isolation test sign‑in**  
The isolation tests must sign in as a **tenant‑specific user** via Firebase
Auth custom tokens.  The service role is forbidden because it bypasses
the security rules that the test is meant to exercise.  

**Q7 – AI decode cap env var**  
`AI_DECODE_DAILY_CAP` controls the daily limit; its default value is **2000**.  

**Q8 – `AI_LOOKUP_KILL_SWITCH` & spend‑guard**  
`AI_LOOKUP_KILL_SWITCH` disables all AI lookup calls.  A related guard
variable is `AI_SPEND_GUARD`.  Secret variables such as API keys,
database credentials, and any `*_API_KEY` must never be exposed to
client code.  

**Q9 – Corpus sizes**  
- Retail knowledge corpus ≈ **1 million rows**.  
- Tire corpus ≈ **200 k rows** (roughly one‑fifth the size of retail).  

**Q10 – Paid‑decode cache backup**  
The script is `npm run backup-paid-decode-cache`.  It protects against
cache eviction or server restarts that would otherwise lose the cached
decodes.  

**Q11 – Client API key guard test**  
`__tests__/noApiKeyRead.test.ts` mechanically asserts that client code
never accesses any variable ending in `*_API_KEY`.  

**Q12 – `test:corpus-drift`**  
It verifies that the corpus size and structure match the expected
baseline.  It does **not** use Turso; it reads from the local test
database only.  

**Q13 – Timing‑flaky Vitest test**  
The documented flaky test is `vitest.test('async delay', …)`.  It flakes
when run on CI with high latency or limited CPU, causing the timeout to
exceed the expected window.  

**Q14 – `scripts/patch-jwks-rsa.cjs`**  
This post‑install script patches the Firebase JWKS RSA key set so that
the emulator can validate tokens without hitting the live JWKS endpoint,
avoiding network failures during local runs.  

**Q15 – `auto_link` vs `suggest_link`**  
In `identityMerge.ts`:  

- **`auto_link`** automatically creates a link when the incoming
identity is unique and passes all validation checks.  
- **`suggest_link`** records a potential link but requires explicit user
confirmation before it becomes active.  

**Q16 – Confidence‑based auto‑verify bug**  
Root cause: the confidence threshold was computed incorrectly, so rows
with 92 % still fell below the “counted” cutoff.  The fix was to correct
the threshold logic and add a unit test that verifies the boundary
value.  

**Q17 – `bizFieldOk` rule**  
`bizFieldOk` ensures that the business field in a document matches the
tenant’s ID.  It defends against NoSQL‑injection style attacks by
preventing an attacker from forging a document with another tenant’s
ID.  

**Q18 – Alias/catalog data exposure**  
No – a customer‑role browser can never download or persist the raw
alias/catalog database.  The data is served exclusively through API
endpoints that enforce Firestore rules; only server‑side code has direct
access to the full collection.  

**Q19 – Lesson from LESSONS_LEARNED**  
Gates must always be run with an explicit `cd` into the project
directory because environment variables and relative paths are resolved
relative to the current working directory.  When this rule was violated,
the tests ran against a stale or wrong configuration, causing random
failures.  

**Q20 – `npm run dev` & production writes**  
`npm run dev` (without flags) never writes to real production Firestore;
it always uses the local emulator.  To write to prod you would need
`npm run dev --prod` or a separate script such as `npm run deploy`.  
The dev launcher shows a visual banner: **“DEV – Emulator”** for the
emulator mode and **“PROD – Live”** when the production backend is
selected.
