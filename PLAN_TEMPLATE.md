# Plan Structure (template)

Use this structure for EVERY plan in this project. The goal: a plan that is **self-contained** -
a person or another AI can read it cold (without the codebase) and give useful feedback. Always put
the Problem / Context first so it can be pasted into another AI for review.

Copy the sections below into `plans/<date>-<slug>.md` for each new plan.

---

## 1. Problem / Context  (write this so a stranger AI understands it with zero prior context)
- What the app is (one or two sentences).
- What is broken or missing, in plain language.
- The concrete symptoms (with real numbers / observed behavior).
- Why it matters / the goal in one sentence.

## 2. Current behavior
- How the relevant part works today, step by step.

## 3. Goals / Success criteria  (measurable)
- Bullet list of "done means ..." with numbers where possible (latency, pass/fail, etc.).

## 4. Constraints / non-negotiables
- What must NOT break. Rules to honor. Safety/cost limits.

## 5. Proposed changes  (the actual plan)
- Grouped work items (A, B, C...). Each item: what + why, briefly.

## 6. Files to touch
- Specific paths; note new files.

## 7. Testing strategy  (multiple angles - required before delivery)
- Unit (mocked), integration/E2E (mocked), and live verification across DIFFERENT inputs.
- State how success is measured for each.

## 8. Risks / trade-offs
- Honest list, with mitigations.

## 9. Out of scope
- What this plan deliberately does not do.
