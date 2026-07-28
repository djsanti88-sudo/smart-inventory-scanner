<!-- subject=analyst case=hbug-04-share-route-raw-env-bypass round=0 elapsed=157s rc=0 -->
**TRACE:**  
1. **Security bypass scenario** – request body `{"sessionId":"S123"}` with header `IS_E2E=1`.  
   * `POST` → `declaredLength` 0 → skip size check.  
   * `rawBody = await request.text()` → `"{"sessionId":"S123"}"`.  
   * JSON parse → `body.sessionId="S123"`, `body.businessId=undefined`.  
   * `sessionId = stringField(body.sessionId)` → `"S123"` (valid).  
   * `requestedBusinessId = stringField(body.businessId)` → `""`.  
   * `authBypass = process.env.IS_E2E === "1" || !isLiveAuth();` → **true**.  
   * Skip authentication block (`if (!authBypass)`).  
   * `businessId = requestedBusinessId || "demo-business"` → `"demo-business"`.  
   * `fallbackReport` built, `reportSnapshot = normalizeBossReportSnapshot(fallbackReport)` executed.  
   * `token = await mintShareToken(...)` – token minted for demo business without any credential check.  
   * Response JSON contains the token and URL.

2. **Unhandled‑exception scenario** – request body `{"sessionId":"S123","idToken":"tkn","businessId":"B1","reportSnapshot":{}}`.  
   * `authBypass` false (no IS_E2E, live auth).  
   * Verify ID token → `uid="u1"`.  
   * Membership check passes.  
   * `reportSnapshot = normalizeBossReportSnapshot({})` – assumed to throw an error.  
   * No surrounding try/catch; exception propagates to the framework → 500 Internal Server Error with no JSON body.

**SYNTAX‑FILTER:**  
No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration.

**VERDICT:** FLAWED – found security and failure‑mode defects that violate the project laws.

**FINDINGS:**

1. **[Critical] Security bypass in production** – The `authBypass` expression (`process.env.IS_E2E === "1" || !isLiveAuth()`) can evaluate to true when `IS_E2E=1` is accidentally set or when `isLiveAuth()` returns false due to misconfiguration. In that case the route skips all authentication and membership checks, allowing any caller with a valid `sessionId` to mint a share token for the demo business (or the supplied business if present).  
   * **Scenario** – Starting state: production environment where `process.env.IS_E2E="1"` is set. Action: POST request containing only `"sessionId":"S123"`. Wrong outcome: route returns a valid token and URL without requiring an ID token or verifying membership. Expected outcome: 401 “Sign in required.”  
   * **Evidence line** – `const authBypass = process.env.IS_E2E === "1" || !isLiveAuth();`.

2. **[High] Unhandled exception from snapshot normalization / token minting** – The code calls `normalizeBossReportSnapshot(body.reportSnapshot ?? fallbackReport)` and then `mintShareToken(...)` without any try/catch. If either function throws (e.g., due to an invalid snapshot shape or internal auth error), the request fails with a generic 500 Internal Server Error and no JSON body, violating honesty and failure‑mode expectations.  
   * **Scenario** – Starting state: valid authentication and membership. Action: POST request where `body.reportSnapshot` is `{}` which causes `normalizeBossReportSnapshot` to throw. Wrong outcome: server returns HTTP 500 with no error message. Expected outcome: 400 “Invalid request body.” or 503 “Server auth is not configured.”  
   * **Evidence lines** – `const reportSnapshot = normalizeBossReportSnapshot(body.reportSnapshot ?? fallbackReport);` and `const token = await mintShareToken(...);`.

**QUESTIONS:**  

- What exact logic does `isLiveAuth()` implement? Is it guaranteed to return true in production, or can misconfiguration cause false?  
- Does `normalizeBossReportSnapshot` throw on malformed snapshots, and if so, are those errors caught elsewhere?  
- Does `mintShareToken` ever reject or throw under normal operation (e.g., invalid businessId or sessionId)? If yes, how should the route handle such failures?
