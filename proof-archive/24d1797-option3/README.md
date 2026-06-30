# Option 3 proof archive — commit `24d1797`

**Commit:** `24d179700990dd4528cde0ec9b98d680aae7b0fa` (`24d1797`)
**Message:** `feat(decode): add safe non-public suggestion and provisional count flow`
**Branch:** `repair/baseline-v1-plus-reviewed-good-work` (candidate worktree `C:\tmp\inventory-release-repair`)
**Status:** local only — **NOT pushed, NOT deployed, no production writes.**

This folder archives the live Playwright proof for the Option 3 work (the non-public "Suggested" decode
display + provisional count, plus the unchanged Verified tier). Originals were copied here, not moved.

## What each screenshot proves

| File | Proves |
|---|---|
| `phase1-x004-suggestion-on-scan-row.png` | **Phase 1 (display):** the FNSKU `X004DY7YUT` shows its decoded product ("NatureBell Magnesium Glycinate (suggested)") on the scan row instead of `Product: -`, while NOT counting (Your counts = 0). |
| `phase2-x004-provisional-count-qty2.png` | **Phase 2 (provisional count):** `X004DY7YUT` scanned twice -> "Counted: NatureBell... New quantity 2", Status **Suggested**, Needs Review still 1. Re-scan increments the SAME product (no duplicate); stays unverified + reviewable. |
| `phase2-full-matrix-water-nutella-x004.png` | **Full matrix:** NatureBell (FNSKU) qty 2 **Suggested** + Member's Mark Water `078742051451` (UPC) qty 1 **Verified** + Nutella `3017620422003` (EAN) qty 1 **Verified** — public auto-count unchanged. |
| `water-decoded-and-counted.png` | Earlier proof: water UPC decodes + auto-counts (Verified tier). |
| `multi-scan-decode-count-proof.png` | Earlier proof: water + Nutella decode + auto-count. |

## Safety shape proven
- Weak non-public suggestion **counts provisionally** but is **never** a verified product or approved alias
  (`verified:false`, `provisional:true`) until a human confirms it -> **Velvet Torch poison stays dead**.
- Re-scan dedup (no duplicate rows); human approval upgrades to Known with **no double-count**; non-public
  codes are **shop-local only** (no global cross-shop catalog write). Public UPC/EAN/GTIN behavior unchanged.

## Test results at commit `24d1797`
- `npx vitest run` -> **799 passed**, 30 skipped, **0 failed**
- `npx tsc --noEmit` -> **exit 0** (clean)
- `npx next build` -> **exit 0** (clean)
- `git diff --check` -> clean; no secrets / generated artifacts staged.

## Boundaries honored
No deploy. No push. No production writes. The candidate worktree is clean and the commit is local on its branch.
