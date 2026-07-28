<!-- subject=analyst case=bug-04-barcode-stripped-from-own-products round=4 elapsed=117s rc=0 -->
**TRACE:**  
Take a product object that contains the fields `cleanCode` and `idempotencyKey`, e.g.:

```ts
const prod = {
  id: "p1",
  cleanCode: "ABC123",
  idempotencyKey: "k-xyz",
};
```

Call `stripSensitive(prod)`.

* Line 1: `Array.isArray(value)` → false.  
* Line 2: `value && typeof value === "object"` → true.  
* Loop over entries: first entry `["id", …]` – not sensitive, kept.  
  Second entry `["cleanCode", …]` – `isSensitiveKey("cleanCode")` returns **true** (because `"cleanCode"` is in `SENSITIVE_FIELDS`). The key is skipped.  
  Third entry `["idempotencyKey", …]` – also marked sensitive, so it is skipped.

The returned object contains only `{ id: "p1" }`. The safe fields were removed.

---

**SYNTAX‑FILTER:**  
No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration. All identified defects are about runtime behavior.

---

**VERDICT:** FLAWED – the module incorrectly treats customer‑safe fields as sensitive, causing them to be stripped from any output that should expose them.

---

**FINDINGS:**

1. **[Critical] Safe field `cleanCode` is marked sensitive and thus removed by `stripSensitive`.**  
   *Starting state:* product object containing `"cleanCode":"ABC123"`.  
   *Action sequence:* call `stripSensitive(prod)`.  
   *Wrong outcome:* returned object lacks the `cleanCode` key.  
   *Expected outcome:* `cleanCode` should be preserved for customer‑facing data.  
   *Evidence line:* `export const SENSITIVE_FIELDS = [ … "cleanCode", … ];`

2. **[High] Safe field `idempotencyKey` is also marked sensitive and removed by `stripSensitive`.**  
   *Starting state:* product object containing `"idempotencyKey":"k-xyz"`.  
   *Action sequence:* call `stripSensitive(prod)`.  
   *Wrong outcome:* returned object lacks the `idempotencyKey` key.  
   *Expected outcome:* `idempotencyKey` should be retained for customer‑facing data (e.g., to re‑link provisional placeholders).  
   *Evidence line:* `export const SENSITIVE_FIELDS = [ … "idempotency_key", … ];`

3. **[Medium] `stripSensitive` will strip all properties of a `Date` object, turning it into `{}` and losing the original date value.**  
   *Starting state:* object `{ createdAt: new Date() }`.  
   *Action sequence:* call `stripSensitive(obj)`.  
   *Wrong outcome:* returned object contains `{ createdAt: {} }`.  
   *Expected outcome:* the `Date` should be preserved as a `Date` instance.  
   *Evidence line:* implementation of `stripSensitive`, where an object is processed by iterating over `Object.entries(value)`; for a `Date`, this yields no entries, so `out` remains `{}`.

---

**QUESTIONS:** None – all identified defects are directly provable from the provided code.
