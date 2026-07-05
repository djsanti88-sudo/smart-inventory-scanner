// Junk-page rejection for Fetch V2 - runs BEFORE any product extraction. Reuses the production
// firewall (isUsableProductName / looksRecycledUpc / looksInvalidating - battle-hardened by the
// 2026-07-04 dry run) and adds the explicit hard-reject rules from the Fetch V2 spec.
import { isUsableProductName } from "@/services/ai/decode";
import { looksInvalidating, looksRecycledUpc } from "@/services/ai/evidenceVerifier";

export interface PageInput {
  url: string;
  title: string;
  text?: string;
}

export interface JunkVerdict {
  rejected: boolean;
  reasons: string[];
}

// Search/echo/no-result pages, incl. the specific hosts caught in the dry run.
const SEARCH_TITLE_RE = /^search for:|suchergebnisse|search results?|results? for\b|^upc database\b|^codecheck\b/i;
const NOT_FOUND_RE =
  /not able to find|product not found|no products? (?:were )?found|no results?\b|nothing found|invalid (?:upc|ean|barcode)|not found in our database|does not exist in/i;
const HOST_GUARDS: Array<{ host: RegExp; path?: RegExp; titleEcho?: boolean; reason: string }> = [
  { host: /barcode-list\./i, path: /search/i, reason: "barcode-list.com search-echo page" },
  { host: /codecheck\./i, path: /search|product\.search/i, reason: "codecheck.info search page" },
  // Only the echo pattern is junk; a real upcdatabase product page stays a supporting source.
  { host: /upcdatabase\./i, titleEcho: true, reason: "upcdatabase title-echo page" },
];

function digitVariants(code: string): string[] {
  const d = (code ?? "").replace(/\D/g, "");
  if (d.length < 8) return [code].filter(Boolean);
  return [...new Set([d, d.replace(/^0+/, ""), d.padStart(13, "0"), d.padStart(14, "0")])];
}

function codeIn(text: string, code: string): boolean {
  const t = text ?? "";
  return digitVariants(code).some((v) => v && new RegExp(`(?<![0-9])${v}(?![0-9])`).test(t.replace(/[\s-]/g, "")));
}

// ---- Shared identity-name firewall (used for page-extracted AND snippet-derived names) --------
const GENERIC_NAME_RE = /^(nutrition facts?|ingredients?|products?|details?|specifications?|description|overview|reviews?|home)$/i;
// Store-nav, marketing, price-comparison, and download shapes are never product identities
// (200-run live wrongs: "Jetzt günstig kaufen", "Compare prices in United States", "[PDF] ... Free Download").
const NAV_NAME_RE =
  /\bproduct details?\b|^my store\b|\bshop all\b|\bstore locator\b|\bcompare prices?\b|\bprice comparison\b|\bg(?:ü|u)nstig\b|\bkaufen\b|\bfree download\b|^\[?pdf\]?\b|\bsal(?:ī|i)dzin\w*\b|\bcenas\b|\bcompare precios?\b|\bcompre barato\b|\bprecios? bajos?\b|\bupc lookup\b|\bean lookup\b|\bbarcode lookup\b|\bitem\s*#\b|\bupc code\b|^model type\b|\bachetez\b|\bacheter\b|\ben ligne\b|\bhammerpreis\b|\bbei uns\b|\bbuy online\b/i;

/** True when a name can serve as a product identity (not a code echo, nav label, or shop-speak). */
export function usableIdentityName(name: string, code: string): boolean {
  const n = (name ?? "").trim();
  if (!n || GENERIC_NAME_RE.test(n) || NAV_NAME_RE.test(n)) return false;
  if (n.replace(/[\s\-_.]/g, "").toUpperCase() === (code ?? "").replace(/[\s\-_.]/g, "").toUpperCase()) return false;
  return isUsableProductName(n, code);
}

/** Default shop names and nav labels are not brands ("My Store", "Products"...). */
export function cleanBrand(brand: string): string {
  const b = (brand ?? "").trim();
  return !b || NAV_NAME_RE.test(b) || GENERIC_NAME_RE.test(b) ? "" : b;
}

/** Hard junk verdict. A rejected page must never contribute identity OR evidence. */
export function evaluatePageJunk(page: PageInput, code: string): JunkVerdict {
  const reasons: string[] = [];
  const title = (page.title ?? "").trim();
  const text = page.text ?? "";

  if (SEARCH_TITLE_RE.test(title)) reasons.push(`search/echo title: "${title.slice(0, 60)}"`);
  if (!isUsableProductName(title, code)) reasons.push("title fails production junk firewall (unusable as identity)");
  if (looksRecycledUpc(title) || looksRecycledUpc(text)) reasons.push("recycled-UPC / nutrition-DB page markers");
  if (looksInvalidating(text)) reasons.push("page text invalidates the code (not a valid / did you mean / no such product)");
  if (NOT_FOUND_RE.test(text) || NOT_FOUND_RE.test(title)) reasons.push("no-result / not-found page");

  let host = "";
  let path = "";
  try {
    const u = new URL(page.url);
    host = u.hostname;
    path = u.pathname + u.search;
  } catch { /* unparseable URL: no host guard */ }
  for (const g of HOST_GUARDS) {
    if (!g.host.test(host)) continue;
    if (g.path && !g.path.test(path)) continue;
    if (g.titleEcho && !(codeIn(title, code) || SEARCH_TITLE_RE.test(title))) continue;
    reasons.push(g.reason);
  }

  // "Code appears only in the URL" - only decidable when we actually have page text.
  if (text && codeIn(page.url, code) && !codeIn(title, code) && !codeIn(text, code)) {
    reasons.push("code appears ONLY in the url, not in page content");
  }

  return { rejected: reasons.length > 0, reasons };
}
