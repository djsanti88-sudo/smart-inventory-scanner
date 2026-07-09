"use client";

// Task 8: the Settings "Fast AI lookup" row must tell the truth about the decode ladder. Gemini is
// permanently OUT of decode (MASTER BASELINE v1: corpus -> Go-UPC -> Fetch V2 -> GPT only) - it is
// enrichment only. geminiConfigured still reflects whether GEMINI_API_KEY is present server-side
// (kept for the autoDecode gate and for enrichment use), but the label must not imply Gemini
// participates in deciding a scanned code's identity.
// Copy rule: no em dash or en dash, plain punctuation only.
export function GeminiStatusRow({
  geminiConfigured,
}: {
  geminiConfigured: boolean;
  geminiUsedForDecode?: boolean;
}) {
  return (
    <span
      className={`text-sm ${geminiConfigured ? "text-green-700" : "text-red-700"}`}
      data-testid="gemini-status"
    >
      Gemini: not used for decode (enrichment only). {geminiConfigured ? "key configured." : "key missing."}
    </span>
  );
}
