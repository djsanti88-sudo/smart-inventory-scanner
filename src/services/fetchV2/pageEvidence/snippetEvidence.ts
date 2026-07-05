// Search-index evidence: merchant feeds put barcodes into result titles/snippets even when the
// rendered page never shows them (owner finding 2026-07-04: eBay tire listings). A code-carrying
// snippet is deterministic app-side evidence - the search engine's ranking is never trusted, the
// exact digit-boundary match is ours. Identity comes only from titles that pass the name firewall.
import { cleanProductName } from "@/services/ai/decode";
import { usableIdentityName } from "./junkRules";
import { hasBarcodeLabelContext, hasNegativeContext } from "./association";
import type { DiscoveryCandidate } from "../sources/discovery";

export interface SnippetFinding {
  url: string;
  host: string;
  name: string; // firewall-cleaned identity from the result title ("" if unusable)
  matchedVariant: string;
  labeled: boolean; // true only when a barcode label (UPC/EAN/...) sits near the code
}

function matchIn(text: string, variant: string): boolean {
  if (!variant) return false;
  const raw = text ?? "";
  const squashed = raw.replace(/[\s-]/g, "");
  if (/^\d+$/.test(variant)) {
    const re = new RegExp(`(?<![0-9])${variant}(?![0-9])`);
    // Check the raw text too: squashing can glue adjacent numbers and destroy the boundary.
    return re.test(raw) || re.test(squashed);
  }
  return new RegExp(`(?<![A-Z0-9])${variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Z0-9])`, "i").test(raw);
}

export function snippetFindings(
  candidates: DiscoveryCandidate[],
  variants: string[],
  code: string,
  opts?: { assumeCarrying?: boolean },
): SnippetFinding[] {
  const out: SnippetFinding[] = [];
  // Short digit strings collide with listing IDs, phone numbers, and zips (live: 8-digit codes
  // "matched" real-estate and chess-profile pages). Snippet evidence needs 10+ digits.
  if ((code ?? "").replace(/\D/g, "").length < 10) return out;
  for (const c of candidates) {
    const hay = `${c.title} ${c.snippet}`;
    // assumeCarrying: results of a QUOTED exact-match query matched the code by the search
    // engine's own contract, even when the snippet hides it (canary-proven live 2026-07-04:
    // quoted searches for invented codes return zero results).
    const matched = variants.find((v) => matchIn(hay, v)) ?? (opts?.assumeCarrying ? variants[0] : undefined);
    if (!matched) continue;
    let host = "";
    try { host = new URL(c.url).hostname.toLowerCase(); } catch { continue; }
    const usable = usableIdentityName(c.title, code);
    const labeled = hasBarcodeLabelContext(hay, matched) && !hasNegativeContext(hay, matched);
    out.push({ url: c.url, host, name: usable ? cleanProductName(c.title) : "", matchedVariant: matched, labeled });
  }
  return out;
}
