import "server-only";
import { isGtinShaped, isValidCheckDigit } from "@/services/upc/gtin";

/**
 * L6 (owner-ratified 2026-07-15, Task 12c): a daily cap slot may only be charged when at least one
 * genuinely PAID rung can actually execute for this code. Without ANY provider key configured, the
 * "paid" ladder degrades entirely to free doors (the AM-7 keyless pattern-URL scrape, honest skips)
 * and a total-miss run through it must not eat a cap slot for work that was never actually paid.
 *
 * Mirrors the exact gating each paid rung already applies on its own:
 *  - Go-UPC only runs for a GTIN-shaped code with a VALID GS1 check digit, and only when
 *    GO_UPC_API_KEY is configured (see pipeline.ts's `goUpcCanPay` escalation gate, and
 *    GoUpcProvider.ts / pipeline.ts:668).
 *  - Fetch V2's PAID discovery doors (Brave search, Firecrawl search/scrape) need BRAVE_SEARCH_API_KEY
 *    or FIRECRAWL_API_KEY(_n) (pipeline.ts:234-237, firecrawlProvider.ts's firecrawlKeysFromEnv). The
 *    keyless pattern-URL door (AM-7) is free and runs regardless - it is NOT paid work.
 *  - The GPT-5.5 ladder rung needs OPENAI_API_KEY (pipeline.ts:463/470).
 */
export function paidWorkPossible(code: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const goUpcCanPay = isGtinShaped(code) && isValidCheckDigit(code) && !!env.GO_UPC_API_KEY;
  const fetchV2CanPay = !!env.BRAVE_SEARCH_API_KEY || hasAnyFirecrawlKey(env);
  const gptCanPay = !!env.OPENAI_API_KEY;
  return goUpcCanPay || fetchV2CanPay || gptCanPay;
}

/** Mirrors firecrawlKeysFromEnv's rotation (FIRECRAWL_API_KEY_1..10, falling back to the legacy single key). */
function hasAnyFirecrawlKey(env: NodeJS.ProcessEnv): boolean {
  for (let n = 1; n <= 10; n++) {
    const k = env[`FIRECRAWL_API_KEY_${n}`];
    if (k && k.trim().length > 0) return true;
  }
  const legacy = env.FIRECRAWL_API_KEY;
  return !!legacy && legacy.trim().length > 0;
}
