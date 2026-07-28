# Case: hlaw-qa (20 NEW held-out questions, zero overlap with bench/cases/law-qa.md)

## Task prompt (what the subject model sees)
Answer each question about the Scanbin inventory project precisely and concisely.

## Questions (shown to subject)
Q1: What port does the mock Playwright E2E suite run on, and what port do the QA human-bots run on?

Q2: What does `npm run qa:revision` actually run (list the gates it chains)?

Q3: Name two brand families the app models as evidenced corporate ownership (one company owning multiple tire brands), and why does this matter for the prefix firewall?

Q4: Under the Firebase security model, how is a business's tenant data scoped in Firestore, and why was a top-level-collection-plus-`businessId`-field design rejected?

Q5: What is `catalogEntries` and who is allowed to write to it directly from a client?

Q6: What must a Firestore tenant-isolation test use to sign in, and why is the service role forbidden for the isolation assertions themselves?

Q7: What environment variable controls the daily AI decode cap's default value, and what is that default?

Q8: What is `AI_LOOKUP_KILL_SWITCH` (name a related spend-guard env var) and what category of variables must never be read from client code?

Q9: What is the approximate size (row count order of magnitude) of the retail knowledge corpus, and roughly how does it compare to the tire corpus?

Q10: Which npm script backs up the paid decode cache, and why does that backup exist (what does it protect against)?

Q11: What test file mechanically enforces that client code never reads `*_API_KEY`?

Q12: What does `test:corpus-drift` check, and does it use Turso?

Q13: Which known Vitest test is documented as timing-flaky, and under what condition does it flake?

Q14: What does the `postinstall` script `scripts/patch-jwks-rsa.cjs` fix?

Q15: When merging decode identities, what distinguishes `auto_link` from `suggest_link` in `identityMerge.ts`?

Q16: What was the root cause of the "confidence-based auto-verify" era bug where a review row showed "92%" but was still held from counting, and how was it fixed?

Q17: What is `bizFieldOk` in the Firestore rules, and what class of attack does it defend against as "defense in depth"?

Q18: Trap question: can a customer-role browser ever download or persist the raw alias/catalog database? What mechanism keeps that data server-side?

Q19: What lesson (from LESSONS_LEARNED) explains why gates must always be run with an explicit `cd` into the project directory, and what happened when that rule was violated?

Q20: Trap question: does `npm run dev` (no flags) ever write to real production Firestore data? Which script would be required for that, and what visual signal does the dev launcher show for each backend mode?

