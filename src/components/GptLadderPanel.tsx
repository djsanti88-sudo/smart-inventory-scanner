"use client";

import type { AiStatus } from "@/types";

// Task 6: compact GPT-5.5 ladder spend/call status for the Settings "Live AI status" section.
// Presentational only - reads the already-fetched aiStatus.gptLadder (populated by GET
// /api/ai-lookup via refreshAiStatus). Renders nothing until the first successful refresh.
// Copy rule: no em dash or en dash, plain punctuation only.
export function GptLadderPanel({ gptLadder }: { gptLadder: AiStatus["gptLadder"] }) {
  if (!gptLadder) return null;
  const { spentTodayUsd, capUsd, callsToday, enabled } = gptLadder;
  return (
    <p className="text-sm text-zinc-600" data-testid="gpt-ladder-status">
      GPT ladder today: ${spentTodayUsd.toFixed(2)} of ${capUsd.toFixed(2)}, {callsToday} calls,{" "}
      {enabled ? "Enabled" : "Blocked"}.
    </p>
  );
}
