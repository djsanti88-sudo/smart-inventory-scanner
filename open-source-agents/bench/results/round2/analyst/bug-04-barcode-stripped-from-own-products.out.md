<!-- subject=analyst case=bug-04-barcode-stripped-from-own-products round=2 elapsed=221s rc=0 -->
**TRACE:**  
1. *stripSensitive* on `{ cleanCode:"123", idempotencyKey:"abc", other:"x" }`  
   - `Object.entries` → `[["cleanCode","123"], ["idempotencyKey","abc"], ["other","x"]]`  
   - `isSensitiveKey("cleanCode")` → true → skip  
   - `isSensitiveKey("idempotencyKey")` → true → skip  
   - Result: `{ other:"x" }` (missing both keys)  

2. *stripSensitive* on `[ { cleanCode:"123", idempotencyKey:"abc" }, { foo:"bar"} ]`  
   - Array branch → map each element  
   - First element → same as above → `{}`  
   - Second element → `{ foo:"bar" }`  
   - Result: `[ {}, { foo:"bar"} ]` (first element lost both keys)  

**SYNTAX‑FILTER:** No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration.  

**VERDICT:** FLAWED – SENSITIVE_FIELDS incorrectly lists fields that are also safe for customers.  

**FINDINGS:**  
1. **[Correctness & data integrity]** `stripSensitive` removes `cleanCode` and `idempotencyKey` from customer‑visible objects, causing loss of required review/scan‑event data.  
   - *Failure scenario:* Starting state `{ cleanCode:"123", idempotencyKey:"abc" }`; action `stripSensitive(...)`; wrong outcome: `{}` (keys missing); expected: preserve them.  
   - *Evidence:* SENSITIVE_FIELDS contains `"cleanCode","clean_code"` and `"idempotencyKey","idempotency_key"`; CUSTOMER_SAFE_REVIEW_FIELDS and CUSTOMER_SAFE_SCANEVENT_FIELDS list those keys as safe.  

2. **[Security & tenancy]** The contradictory lists mean that sensitive‑field filtering can unintentionally expose or hide data, violating the intended separation between platform‑only and customer‑visible fields.  
   - *Failure scenario:* Same as above; `stripSensitive` drops keys that should be transmitted to customers.  
   - *Evidence:* SENSITIVE_FIELDS includes `"cleanCode","clean_code"` and `"idempotencyKey","idempotency_key"`, yet those keys appear in the allowlists for review and scan‑event data.  

**QUESTIONS:**  
- What business rule determines whether `cleanCode` or `idempotencyKey` should be considered sensitive?  
- Is there an intended distinction between “sensitive” and “allowlisted” that is not reflected in this module?
