import "server-only";
import { tireSizeToken } from "@/services/ai/tireSpecs";

/** True only when two sources land the SAME non-empty normalized tire size. Pure. */
export function agreeOnSize(a: string | undefined, b: string | undefined): boolean {
  const sa = tireSizeToken({ productName: a ?? "" } as Parameters<typeof tireSizeToken>[0]);
  const sb = tireSizeToken({ productName: b ?? "" } as Parameters<typeof tireSizeToken>[0]);
  return !!sa && !!sb && sa === sb;
}

export interface SizeRaceArm { size: string; ok: boolean; }
export interface SizeRaceResult { size: string; sizeAgreement: boolean; armA: SizeRaceArm; armB: SizeRaceArm; }

/**
 * Run two INDEPENDENT retrieval roads concurrently under one 8s budget. armAGetSize and armBGetSize each
 * resolve to a size string (or "") - they are DIFFERENT roads (grounded search vs page fetch). First valid
 * size becomes the display size; sizeAgreement is true ONLY when BOTH return the same normalized size. The
 * caller (the route) sets result.sizeAgreement from this - it is app-computed, never a provider self-claim.
 */
export async function runSizeRace(args: {
  armAGetSize: (signal?: AbortSignal) => Promise<string>;
  armBGetSize: (signal?: AbortSignal) => Promise<string>;
  budgetMs?: number;
}): Promise<SizeRaceResult> {
  const { armAGetSize, armBGetSize, budgetMs = 8000 } = args;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    const [a, b] = await Promise.all([
      armAGetSize(ctrl.signal).catch(() => ""),
      armBGetSize(ctrl.signal).catch(() => ""),
    ]);
    const armA: SizeRaceArm = { size: a || "", ok: !!a };
    const armB: SizeRaceArm = { size: b || "", ok: !!b };
    const sizeAgreement = agreeOnSize(a, b);
    const size = a || b || "";
    return { size, sizeAgreement, armA, armB };
  } finally {
    clearTimeout(to);
  }
}
