import "server-only";
import { lookupTirePrefix } from "@/services/tire/tirePrefixLookup";

/**
 * A6 tire-prefix steering (owner-ratified 2026-07-15; AM-3 HARDENED gate - the amendment SUPERSEDES
 * the original task's "any strong hint" rule).
 *
 * TRUE BLAST RADIUS OF A FALSE STEER (read before touching the thresholds below): steering empties
 * BOTH free rungs (UPCitemdb, Open Food Facts) for the code. In the pipeline, an empty free-rung run
 * yields `freeRun.outcome === undefined`, which routes straight into the TOTAL-MISS branch:
 * `chargePaidSlot()` (when `paidWorkPossible`) followed by the FULL PAID LADDER (Go-UPC -> Fetch V2 ->
 * GPT). A false steer therefore does not just cost two free lookups - it can burn a real daily-cap
 * paid slot and a full paid ladder run on a code that a free rung might otherwise have suggested for
 * $0. The gate below is deliberately conservative because of this: it requires BOTH (a) a STRONG
 * tire-prefix hint (never weak-only - a weak prefix is not evidence enough to forgo a free lookup) AND
 * (b) a matched prefix of AT LEAST 8 DIGITS. The 8-digit floor exists because many strong-weighted GS1
 * COMPANY prefixes are only 6-7 digits and are shared across an entire corporate family (e.g. "086699"
 * = Michelin/BFGoodrich/Uniroyal) - a non-tire product from a company that also happens to share that
 * short numeric prefix range would otherwise be wrongly steered away from a free rung that might have
 * resolved it. An 8+ digit match is specific enough to the tire manufacturer's actual product-code
 * space that this false-positive class does not apply.
 *
 * Proven basis for steering at all: UPCitemdb/OpenFoodFactsProvider have NEVER returned a tire across
 * every benchmark run to date - so skipping them for a code we are highly confident is a tire saves
 * the shared 90/day UPCitemdb quota (for codes that can actually hit) and 1-2s of latency, with no
 * loss of recall for tires specifically.
 */
export function steerFreeRungs(code: string): { skip: boolean; reason: string } {
  const match = lookupTirePrefix(code);
  if (!match) return { skip: false, reason: "" };
  const hasStrongHint = match.brands.some((h) => h.weight === "strong");
  const prefixLongEnough = match.prefix.length >= 8;
  if (!hasStrongHint || !prefixLongEnough) return { skip: false, reason: "" };
  const brandName = match.brands.find((h) => h.weight === "strong")?.brand ?? match.brands[0].brand;
  return {
    skip: true,
    reason: `free rungs skipped: tire-prefix steering (${match.prefix} -> ${brandName}; UPCitemdb/OpenFoodFacts never stock tires)`,
  };
}
