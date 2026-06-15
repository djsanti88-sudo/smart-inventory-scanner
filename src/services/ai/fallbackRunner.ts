import type { AiLookupResult, EvidenceResult } from "@/types";

// Generic "race several finders, first usable result wins" runner for the Stage-2 fallback. Kept out
// of the Next route so it is unit-testable. Owner rules it satisfies:
//  - finders run CONCURRENTLY (not one-after-another) so a hard-failed barcode does not wait 60s+
//  - the FIRST finder that returns a usable hit wins and the losers are ABORTED (save time + credits)
//  - a hard cap aborts everything so the fallback can never run unbounded
//  - a finder that throws or returns null never rejects the race; if all miss, resolve null

export interface FinderHit {
  result: AiLookupResult;
  evidence: EvidenceResult;
  providerName: string;
}

export interface Finder {
  name: string;
  run: (signal: AbortSignal) => Promise<FinderHit | null>;
}

export interface RaceOutcome {
  hit: FinderHit | null;
  timedOut: boolean;
}

export async function raceFinders(finders: Finder[], opts: { hardCapMs: number; signal?: AbortSignal }): Promise<RaceOutcome> {
  if (finders.length === 0) return { hit: null, timedOut: false };

  const ac = new AbortController();
  const onParentAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onParentAbort);

  let timedOut = false;
  let settle: (v: FinderHit | null) => void = () => {};
  const race = new Promise<FinderHit | null>((resolve) => {
    settle = resolve;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
    settle(null);
  }, opts.hardCapMs);

  let remaining = finders.length;
  for (const f of finders) {
    // Start every finder NOW (concurrently). First usable hit settles the race; the rest get aborted.
    Promise.resolve()
      .then(() => f.run(ac.signal))
      .then((v) => {
        if (v && v.result) settle(v);
        else if (--remaining === 0) settle(null);
      })
      .catch(() => {
        if (--remaining === 0) settle(null);
      });
  }

  try {
    const hit = await race;
    return { hit, timedOut };
  } finally {
    clearTimeout(timer);
    ac.abort(); // stop the losers regardless of how we resolved
    opts.signal?.removeEventListener("abort", onParentAbort);
  }
}
