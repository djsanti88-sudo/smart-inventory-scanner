---
name: warn-daily-cap-double-charge
enabled: true
event: file
conditions:
  - field: new_text
    operator: regex_match
    pattern: checkAndIncrementDaily
---

**Daily-cap trap (Lesson L12).** `checkAndIncrementDaily` is the LEGACY lookup-mode gate and a side-effecting check: calling it on two paths of one request double-bills the cap (this bit the project on 2026-07-02). Do NOT add new callers. The correct charge point is `chargeDailySlot`, called exactly ONCE per genuine paid compute, INSIDE the paid path, after the decode-cache peek. Verify you are not introducing a second charge path for one request.
