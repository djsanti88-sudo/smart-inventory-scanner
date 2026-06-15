import type { AiLookupResult, CodeType, DecodeDecision, EvidenceResult, ProviderEvidence } from "@/types";
import { decideDecode, isUsableProductName } from "@/services/ai/decode";
import { verifyEvidence } from "@/services/ai/evidenceVerifier";

// Decode orchestration with a HARD time budget + full concurrency. Owner rule: if the budget fires
// before we have a completed answer, ALL pending work is aborted and the code is routed to Needs
// Review (untrusted) - we never return a partial/best-so-far product on timeout.

export interface DecodeProvider {
  name: string;
  lookup: (signal: AbortSignal) => Promise<AiLookupResult>;
}

export interface DecodeEnrich {
  result: AiLookupResult | null;
  evidence: EvidenceResult;
}

export interface DecodeRunParams {
  code: string;
  codeType: CodeType;
  confidenceThreshold: number;
  providers: DecodeProvider[];
  enrich?: (signal: AbortSignal) => Promise<DecodeEnrich>;
  budgetMs?: number;
  providerTimeoutMs?: number;
  pageTimeoutMs?: number;
  trustedHosts?: string[];
  // Fast path (default): early-exit as soon as ANY provider returns a usable product name (trust-the-AI).
  // Fallback path sets this true: only a fully app-VERIFIED decision (exact code in strong evidence)
  // stops the wait early - so a hard-failed barcode's deeper, slower decode is trustworthy, not a guess.
  requireVerifiedEarlyExit?: boolean;
}

// Per-provider/per-source outcome - so failures are SURFACED, never hidden behind a generic message.
export type ProviderStatusCode = "ok" | "no_match" | "skipped" | "rate_limited" | "timeout" | "error";
export interface ProviderStatus {
  provider: string;
  status: ProviderStatusCode;
  latencyMs: number;
  errorCode?: string; // safe code only (e.g. "429", "timeout", "500") - never a key or stack trace
  sourceUrlsReturned: number;
  exactCodeFound: boolean;
  identityFound: boolean;
}

export interface DecodeRunResult {
  providerNames: string[];
  results: AiLookupResult[];
  evidences: EvidenceResult[];
  providerStatuses: ProviderStatus[];
  decision: DecodeDecision;
  timedOut: boolean;
  latencyMs: number;
}

/** Map a thrown provider error to a safe status + code. Never includes secrets or stack traces. */
function classifyProviderError(msg: string): { status: ProviderStatusCode; errorCode?: string } {
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/i.test(msg)) return { status: "rate_limited", errorCode: "429" };
  if (/timeout|aborted|abort/i.test(msg)) return { status: "timeout", errorCode: "timeout" };
  const m = msg.match(/\b(4\d\d|5\d\d)\b/);
  return { status: "error", errorCode: m?.[1] };
}

function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal): Promise<T> {
  const c = new AbortController();
  const merged = AbortSignal.any([parent, c.signal]);
  const t = setTimeout(() => c.abort(new Error("per-call-timeout")), ms);
  return fn(merged).finally(() => clearTimeout(t));
}

function evidenceOf(r: AiLookupResult): ProviderEvidence {
  return {
    sourceUrls: r.sourceUrls ?? [],
    sourceSnippets: r.sourceSnippets ?? [],
    groundingChunks: r.groundingChunks ?? [],
    exactCodeEvidence: r.exactCodeEvidence,
  };
}

function timedOutDecision(ms: number): DecodeDecision {
  return {
    status: "needs_review",
    confidence: 0,
    reason: `Live decode exceeded the ${ms}ms time budget - routed to Needs Review (untrusted; no partial result is saved).`,
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "weak", confidence: 0, reason: "timeout", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
  };
}

export async function runDecode(p: DecodeRunParams): Promise<DecodeRunResult> {
  const budgetMs = p.budgetMs ?? 13_000;
  const providerTimeoutMs = p.providerTimeoutMs ?? 10_000;
  const pageTimeoutMs = p.pageTimeoutMs ?? 8_000;
  const start = Date.now();

  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new Error("budget")), budgetMs);

  const results: AiLookupResult[] = [];
  const evidences: EvidenceResult[] = [];
  const providerNames: string[] = [];
  const providerStatuses: ProviderStatus[] = [];

  let resolveConfident: () => void = () => {};
  const confident = new Promise<void>((res) => (resolveConfident = res));
  const recheck = () => {
    if (results.length === 0) return;
    // SPEED + trust-the-AI (fast path): stop as soon as ANY provider returns a usable product name. We
    // do NOT wait for the slow page-fetch/cross-check to "fully verify" - that was the ~8s tail. The app
    // still records evidence for catalog metadata, and the client routes conflicts/no-product to review.
    // Fallback path (requireVerifiedEarlyExit) skips this shortcut and waits for VERIFIED evidence.
    if (!p.requireVerifiedEarlyExit && results.some((r) => isUsableProductName(r.productName))) {
      resolveConfident();
      return;
    }
    const d = decideDecode({ codeType: p.codeType, results, evidences, confidenceThreshold: p.confidenceThreshold });
    if (d.status === "verified") resolveConfident(); // a fully-verified hit -> stop waiting early
  };

  const tasks: Promise<unknown>[] = p.providers.map((prov) => {
    const tStart = Date.now();
    return withTimeout((s) => prov.lookup(s), providerTimeoutMs, budget.signal)
      .then((r) => {
        results.push(r);
        providerNames.push(prov.name);
        const ev = verifyEvidence(p.code, p.codeType, evidenceOf(r), { trustedHosts: p.trustedHosts ?? [] });
        evidences.push(ev);
        const identityFound = isUsableProductName(r.productName);
        providerStatuses.push({
          provider: prov.name,
          status: identityFound ? "ok" : "no_match",
          latencyMs: Date.now() - tStart,
          sourceUrlsReturned: (r.sourceUrls ?? []).length,
          exactCodeFound: ev.verified,
          identityFound,
        });
        recheck();
      })
      .catch((err) => {
        // Do NOT swallow: capture WHY (rate_limited / timeout / error) so the UI can be honest.
        const { status, errorCode } = classifyProviderError(String((err as Error)?.message ?? err ?? ""));
        providerStatuses.push({
          provider: prov.name,
          status,
          latencyMs: Date.now() - tStart,
          errorCode,
          sourceUrlsReturned: 0,
          exactCodeFound: false,
          identityFound: false,
        });
      });
  });

  if (p.enrich) {
    const enrich = p.enrich;
    const tStart = Date.now();
    tasks.push(
      withTimeout((s) => enrich(s), pageTimeoutMs, budget.signal)
        .then((e) => {
          if (e.result) {
            results.unshift(e.result);
            providerNames.unshift("page-fetch");
            evidences.unshift(e.evidence);
          } else {
            evidences.unshift(e.evidence);
          }
          const identityFound = !!e.result && isUsableProductName(e.result.productName);
          providerStatuses.push({
            provider: "page-fetch",
            status: identityFound ? "ok" : "no_match",
            latencyMs: Date.now() - tStart,
            sourceUrlsReturned: (e.result?.sourceUrls ?? []).length,
            exactCodeFound: e.evidence.verified,
            identityFound,
          });
          recheck();
        })
        .catch((err) => {
          const { status, errorCode } = classifyProviderError(String((err as Error)?.message ?? err ?? ""));
          providerStatuses.push({
            provider: "page-fetch",
            status,
            latencyMs: Date.now() - tStart,
            errorCode,
            sourceUrlsReturned: 0,
            exactCodeFound: false,
            identityFound: false,
          });
        }),
    );
  }

  const allDone = Promise.allSettled(tasks);
  const budgetHit = new Promise<"budget">((res) => budget.signal.addEventListener("abort", () => res("budget")));

  const winner = await Promise.race([confident.then(() => "ok" as const), allDone.then(() => "ok" as const), budgetHit]);
  clearTimeout(timer);
  budget.abort(); // cancel any stragglers regardless of outcome

  const latencyMs = Date.now() - start;

  if (winner === "budget") {
    // Owner rule: timeout is untrusted -> Needs Review, never a partial product.
    return { providerNames, results, evidences, providerStatuses, decision: timedOutDecision(budgetMs), timedOut: true, latencyMs };
  }

  const decision = decideDecode({ codeType: p.codeType, results, evidences, confidenceThreshold: p.confidenceThreshold });
  return { providerNames, results, evidences, providerStatuses, decision, timedOut: false, latencyMs };
}
