// Mock-first LLM polish fallback (Build 2 / Task 3). Runs ONLY for rows the deterministic
// structurer marked low-confidence (< 0.6) - the caller decides that; this module just polishes
// one name via an injected provider. Pure service: no React, no next/*.
//
// Safety rails:
// - The deterministic sanitizer (src/services/sanitizer.ts) runs BEFORE anything reaches the
//   prompt, so emails / phones / internal prices never leave the app.
// - The provider reply is UNTRUSTED data (semantic firewall): it is parsed with containment
//   (bad JSON / missing fields -> null, never throw) and its tire sizeTag is NEVER trusted -
//   tireSizeTag(name) is recomputed deterministically and wins whenever it is non-empty.
// - The default provider is the offline mock. The Gemini Flash-Lite live provider below is
//   DEFINED but never constructed by any test or current caller (wiring is Task 4's concern);
//   it reads GEMINI_API_KEY server-side only, at construction.

// NOTE: relative + explicit ".ts" extensions (not the usual "@/" alias) - see structuredFields.ts
// for why: this module is imported directly, standalone, by scripts/polish-backfill.mts's --llm
// flag under plain `node` (no bundler), and the "@/" tsconfig path alias is bundler/vitest-only.
import { sanitizeForAiLookup } from "../sanitizer.ts";
import { tireSizeTag, type StructuredProduct } from "./structurer.ts";

export interface LlmPolishDeps {
  provider: (prompt: string) => Promise<string>;
  cache: Map<string, StructuredProduct>;
}

const SIZE_TAG_KINDS: ReadonlyArray<StructuredProduct["sizeTagKind"]> = [
  "tire",
  "weight",
  "count",
  "volume",
  "none",
];

// The mock provider extracts the name from between these triple-quote markers, so keep the
// prompt shape and the mock's regex in sync.
export function buildPolishPrompt(sanitizedName: string): string {
  return [
    "You split a raw retail product listing title into structured fields.",
    "Reply with STRICT JSON only - no prose, no code fences - exactly this shape:",
    '{"brand": string, "model": string, "descriptionText": string, "sizeTag": string, "sizeTagKind": "tire"|"weight"|"count"|"volume"|"none", "confidence": number}',
    'Rules: brand is "" when unknown (never guess), descriptionText is the cleaned full title,',
    'sizeTag is glued digits for tire sizes ("2657017") or a compact unit tag ("9.25oz") or "",',
    "confidence is 0..1 for how sure you are about the split.",
    'Product name: """' + sanitizedName + '"""',
  ].join("\n");
}

/** Extract the first JSON object from a reply that may include prose / code fences. */
function safeParseJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Strict field validation: every field present with the right type, or the whole reply is
 *  rejected (null). Confidence is the one lenient spot - a valid number is clamped to 0..1. */
function toStructuredProduct(raw: Record<string, unknown>): StructuredProduct | null {
  const { brand, model, descriptionText, sizeTag, sizeTagKind, confidence } = raw;
  if (typeof brand !== "string") return null;
  if (typeof model !== "string") return null;
  if (typeof descriptionText !== "string") return null;
  if (typeof sizeTag !== "string") return null;
  if (typeof sizeTagKind !== "string" || !SIZE_TAG_KINDS.includes(sizeTagKind as StructuredProduct["sizeTagKind"])) {
    return null;
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return {
    brand: brand.trim(),
    model: model.trim(),
    descriptionText: descriptionText.trim(),
    sizeTag: sizeTag.trim(),
    sizeTagKind: sizeTagKind as StructuredProduct["sizeTagKind"],
    confidence: clamp01(confidence),
  };
}

/**
 * Polish one low-confidence product name via the injected LLM provider.
 * - Cache hit -> the provider is never called.
 * - Sanitizer masks PII/prices BEFORE the prompt is built.
 * - Bad JSON / missing fields / provider failure -> null (contained, never thrown, not cached).
 * - Tire sizeTag is recomputed deterministically from the ORIGINAL name and always wins.
 */
export async function polishWithLlm(name: string, deps: LlmPolishDeps): Promise<StructuredProduct | null> {
  const key = (name ?? "").trim();
  if (!key) return null;

  const cached = deps.cache.get(key);
  if (cached) return { ...cached };

  const { clean } = sanitizeForAiLookup(key);
  const prompt = buildPolishPrompt(clean);

  let reply: string;
  try {
    reply = await deps.provider(prompt);
  } catch {
    return null;
  }

  const parsed = safeParseJson(reply);
  if (!parsed) return null;
  const structured = toStructuredProduct(parsed);
  if (!structured) return null;

  // Never trust an LLM tire tag: recompute deterministically and prefer it when non-empty.
  const deterministicTag = tireSizeTag(key);
  if (deterministicTag) {
    structured.sizeTag = deterministicTag;
    structured.sizeTagKind = "tire";
  }

  deps.cache.set(key, structured);
  return { ...structured };
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

const PROMPT_NAME_RE = /Product name: """([\s\S]*?)"""/;

/**
 * DEFAULT provider: deterministic canned splits, fully offline. First token becomes the brand
 * (when it looks like a word), the rest is the model. Same prompt in -> same reply out, always.
 */
export function mockPolishProvider(): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const m = PROMPT_NAME_RE.exec(prompt);
    const name = (m ? m[1] : prompt).trim();
    const tokens = name.split(/\s+/).filter(Boolean);
    const first = tokens[0] ?? "";
    const brand = /^[A-Za-z]/.test(first) ? first : "";
    const model = (brand ? tokens.slice(1) : tokens).join(" ");
    const reply: StructuredProduct = {
      brand,
      model,
      descriptionText: name,
      sizeTag: "",
      sizeTagKind: "none",
      confidence: 0.7,
    };
    return JSON.stringify(reply);
  };
}

/**
 * LIVE provider factory: Gemini Flash-Lite, plain generateContent - NO search/grounding tools
 * (body carries no `tools` key, so nothing can bill hidden search queries), temperature 0.
 * Reads GEMINI_API_KEY at construction, SERVER-SIDE ONLY. Defined here but never constructed
 * by tests and not wired anywhere yet - Task 4/backfill decides when to build one.
 */
export function geminiPolishProvider(opts?: { model?: string }): (prompt: string) => Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const model = opts?.model || process.env.GEMINI_POLISH_MODEL || "gemini-flash-lite-latest";

  return async (prompt: string): Promise<string> => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const generationConfig: Record<string, unknown> = {
      temperature: 0,
      maxOutputTokens: Number(process.env.GEMINI_POLISH_MAX_OUTPUT_TOKENS || 512),
    };
    // Flash models think by default; a name split needs no reasoning budget (2.5 Pro rejects this).
    if (/flash/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
      // Deliberately NO `tools` key: plain generateContent, zero grounding/search spend.
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gemini polish error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return ((data?.candidates?.[0]?.content?.parts ?? []) as Array<{ text?: string }>)
      .map((p) => p?.text ?? "")
      .join("\n");
  };
}

export default mockPolishProvider;
