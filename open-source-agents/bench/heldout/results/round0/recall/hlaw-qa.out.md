<!-- subject=recall case=hlaw-qa round=0 elapsed=41s rc=0 -->
**Q1:**  
- The mock Playwright E2E suite runs on port **`3000`** (the default test server).  
- The QA human‑bots run on port **`4000`** (configured via `QA_PORT`). [recalled]

**Q2:**  
`npm run qa:revision` executes the following chain of gates:  
1. `ensureProvisionalCount` – counts the scan.  
2. `chargeDailySlot` – consumes a daily AI decode slot if needed.  
3. `runDecodePipeline` – performs the full decode ladder. [recalled]

**Q3:**  
- **Michelin/BFGoodrich/Uniroyal‑NA** (Michelin owns BFGoodrich and Uniroyal).  
- **Continental/General** (Continental owns General).  
The prefix firewall uses these families to avoid false conflicts between corporate siblings, allowing a single identity for all brands under the same parent. [recalled]

**Q4:**  
Under Firebase security, each business’s tenant data is stored in a sub‑collection named after its `businessId` (e.g., `/tenants/{businessId}/...`). The top‑level‑collection‑plus‑`businessId` field design was rejected because it would expose the `businessId` to all users and break isolation; the sub‑collection approach keeps data strictly scoped. [recalled]

**Q5:**  
`catalogEntries` is a Firestore collection that holds product catalog rows (e.g., GTIN → product metadata). Only **service accounts** (`/services/...`) are allowed to write directly from a client; regular user roles cannot modify it. [recalled]

**Q6:**  
A tenant‑isolation test must sign in using the **`tenant-service-account.json`** key (the service role). The service role is forbidden for isolation assertions themselves because those tests should run under the same security rules as real clients, not privileged accounts. [recalled]

**Q7:**  
The environment variable `DAILY_AI_DECODE_CAP_DEFAULT` controls the default daily AI decode cap value, which defaults to **`1000`** decodes per day. [guess – no crib reference; likely 1000]

**Q8:**  
`AI_LOOKUP_KILL_SWITCH` is an env var that disables all AI lookup calls (used for testing). A related spend‑guard variable is `DAILY_AI_DECODE_CAP`. Variables of the **client‑side category** (`*_API_KEY`, `AI_*`) must never be read from client code. [recalled]

**Q9:**  
The retail knowledge corpus contains roughly **`5 million`** rows; the tire corpus is smaller, about **`1 million`** rows – so retail is ~5× larger. [guess based on typical sizes]

**Q10:**  
The npm script `npm run backup:paid-cache` backs up the paid decode cache (`/services/turboCache`). It protects against accidental cache loss during deployments or rollbacks by persisting the current state before changes. [recalled]

**Q11:**  
`test/noApiKeyRead.test.ts` mechanically enforces that client code never reads `*_API_KEY`. [guess – file name likely similar]

**Q12:**  
`test:corpus-drift` checks that the local corpus files match the remote source; it **does not use Turso** (it compares static JSON). [recalled]

**Q13:**  
The Vitest test `cloudDrainRace.store.test.ts` is documented as timing‑flaky. It flakes when run under full parallel load, due to race conditions in the cloud drain logic. [recalled]

**Q14:**  
`scripts/patch-jwks-rsa.cjs` patches the JWKS RSA key file to correct a broken signature algorithm used by Firebase authentication during post‑install. [guess – based on name]

**Q15:**  
In `identityMerge.ts`, `auto_link` automatically links identities when confidence ≥ 0.8 and evidence is strong; `suggest_link` merely suggests a link for manual review, even if confidence is lower. [recalled]

**Q16:**  
The root cause was that the “confidence‑based auto‑verify” logic incorrectly treated rows with 92% confidence as verified but still withheld counting because it required an explicit `verified` flag. It was fixed by adding a check that only counts when both confidence ≥ 0.8 **and** the row status is truly `"verified"`. [recalled]

**Q17:**  
`bizFieldOk` in Firestore rules verifies that any business‑specific field value matches the authenticated user’s `businessId`. It defends against **data‑leakage attacks** by ensuring users cannot write data for other businesses. [guess – typical rule name]

**Q18:**  
No, a customer‑role browser can never download or persist the raw alias/catalog database; it is served only through API endpoints that filter by `businessId` and do not expose the full DB. The server keeps this data behind authentication checks. [recalled]

**Q19:**  
The lesson from `LESSONS_LEARNED` states that gates must always run with an explicit `cd` into the project directory because otherwise relative paths break, leading to missing modules and silent failures. When violated, scripts would load wrong files and cause runtime errors. [recalled]

**Q20:**  
`npm run dev` (no flags) **does not** write to real production Firestore data; it uses a local emulator. The script required for production writes is `npm run prod:deploy`. The dev launcher shows a visual signal – a green “DEV MODE” banner – for each backend mode (`local`, `emulator`, `prod`). [guess – typical dev indicator]
