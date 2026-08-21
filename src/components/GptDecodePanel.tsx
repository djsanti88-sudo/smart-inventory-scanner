"use client";

import type { AiStatus } from "@/types";

// Task 6: compact GPT-5.4 mini spend/call status for the Settings "Live AI status" section.
// Presentational only - reads the already-fetched aiStatus.gptDecode (populated by GET
// /api/ai-lookup via refreshAiStatus). Renders nothing until the first successful refresh.
// Copy rule: no em dash or en dash, plain punctuation only.
export function GptDecodePanel({ gptDecode }: { gptDecode: AiStatus["gptDecode"] }) {
  if (!gptDecode) return null;
  const { spentTodayUsd, capUsd, callsToday, enabled } = gptDecode;
  const blockedReason = spentTodayUsd + 0.39 > capUsd ? "daily cap reached" : "no key";
  return (
    <p className="text-sm text-zinc-600" data-testid="gpt-decode-status">
      GPT decode today: ${spentTodayUsd.toFixed(2)} of ${capUsd.toFixed(2)}, {callsToday} calls,{" "}
      {enabled ? "Enabled" : `Blocked (${blockedReason})`}.
    </p>
  );
}
