// tireSizeNormalizer.ts (Phase 10) - pure, deterministic tire-size parsing. No AI, no network, no guess.
// Accepts the common tire-size shapes and emits ONE canonical string (e.g. "P225/60R18 103H" or
// "225/60R18"), or null when no confident size is found. Numeric-only shorthands are range-guarded so a
// random number can never be read as a size (project rule: prefer blank/unknown over a wrong guess).

export type TireSizeMatch = {
  /** Canonical size string, optionally with a trailing " <load><speed>" (e.g. "225/60R18 103H"). */
  canonical: string;
  /** Raw matched size substring from the input (used to strip it out of a description). */
  raw: string;
  /** Raw matched load-index + speed-rating substring, if present (e.g. "103H" / "121/118S"). */
  rawLoadSpeed?: string;
};

// Metric / P-metric / LT / ST: P225/65ZR18, 225/60R18, LT285/55R20, 295/75R22.5 (decimal rim ok).
const METRIC = /(P|LT|ST)?\s*(\d{3})\s*\/\s*(\d{2})\s*(ZR|R)\s*(\d{2}(?:\.\d)?)/i;
// Flotation: 35X12.50R20 (the middle is a decimal; construction letter optional). A construction
// prefix (LT/P/ST) can sit directly attached to the flotation number ("LT33X12.50R20") - mirrors
// METRIC's optional (P|LT|ST)? so the prefix is captured as PART of the size, never left dangling
// in the surrounding text to leak into a model/description field.
const FLOTATION = /(P|LT|ST)?\s*(\d{2})\s*X\s*(\d{1,2}\.\d{1,2})\s*(?:ZR|R|-)?\s*(\d{2}(?:\.\d)?)/i;
// Commercial without an aspect slash: 11R22.5 (decimal rim required to avoid false positives).
const COMMERCIAL = /(\d{2,3})\s*(ZR|R)\s*(\d{2}\.\d)/i;
// Space-separated shorthand: "225 60 18".
const SPACED = /\b(\d{3})\s+(\d{2})\s+(\d{2})\b/;
// Space-separated shorthand with an explicit R before the rim: "205 50 R17".
const SPACED_R = /\b(\d{3})\s+(\d{2})\s+(?:ZR|R)\s*(\d{2}(?:\.\d)?)\b/i;
// Separator-free shorthand: "2256018".
const NOSEP = /\b(\d{7})\b/;

// Plausible-size ranges - guard the digit-only shorthands so arbitrary numbers are not read as sizes.
const okWidth = (w: number) => w >= 125 && w <= 395;
const okAspect = (a: number) => a >= 20 && a <= 90;
const okRim = (r: number) => r >= 8 && r <= 30;

// Load index (2-3 digits, optionally dual NNN/NNN) followed by a single speed-rating letter.
const LOAD_SPEED = /(\d{2,3}(?:\/\d{2,3})?)\s*([A-Z])\b/gi;
// Standard speed-rating letters. Excludes I, O (not used), X and Z (Z is carried inside the size as ZR).
const SPEED_LETTERS = new Set("ABCDEFGHJKLMNPQRSTUVWY".split(""));

function findLoadSpeed(remainder: string): { canonical: string; raw: string } | null {
  for (const m of remainder.matchAll(LOAD_SPEED)) {
    const speed = m[2].toUpperCase();
    if (SPEED_LETTERS.has(speed)) return { canonical: `${m[1]}${speed}`, raw: m[0] };
  }
  return null;
}

function withLoadSpeed(base: string, input: string, rawSize: string): TireSizeMatch {
  // Remove the size span first so the size's own digits / "R" cannot be misread as load index or speed.
  const ls = findLoadSpeed(input.replace(rawSize, " "));
  return { canonical: ls ? `${base} ${ls.canonical}` : base, raw: rawSize, rawLoadSpeed: ls?.raw };
}

/** Find a tire size anywhere in the input and return its canonical form + raw spans, or null. */
export function matchTireSize(input: string | null | undefined): TireSizeMatch | null {
  if (!input) return null;
  const s = input.trim();
  if (!s) return null;

  let m = METRIC.exec(s);
  if (m) {
    const prefix = (m[1] ?? "").toUpperCase();
    return withLoadSpeed(`${prefix}${m[2]}/${m[3]}${m[4].toUpperCase()}${m[5]}`, s, m[0]);
  }

  m = FLOTATION.exec(s);
  if (m) {
    const prefix = (m[1] ?? "").toUpperCase();
    return withLoadSpeed(`${prefix}${m[2]}X${m[3]}R${m[4]}`, s, m[0]);
  }

  m = COMMERCIAL.exec(s);
  if (m) return withLoadSpeed(`${m[1]}${m[2].toUpperCase()}${m[3]}`, s, m[0]);

  m = SPACED_R.exec(s);
  if (m && okWidth(Number(m[1])) && okAspect(Number(m[2])) && okRim(Number(m[3]))) {
    return withLoadSpeed(`${m[1]}/${m[2]}R${m[3]}`, s, m[0]);
  }

  m = SPACED.exec(s);
  if (m && okWidth(Number(m[1])) && okAspect(Number(m[2])) && okRim(Number(m[3]))) {
    return withLoadSpeed(`${m[1]}/${m[2]}R${m[3]}`, s, m[0]);
  }

  m = NOSEP.exec(s);
  if (m) {
    const d = m[1];
    const [w, a, r] = [d.slice(0, 3), d.slice(3, 5), d.slice(5, 7)];
    if (okWidth(Number(w)) && okAspect(Number(a)) && okRim(Number(r))) {
      return { canonical: `${w}/${a}R${r}`, raw: m[0] };
    }
  }

  return null;
}

/** Canonical tire size, or null when no confident size is found. */
export function normalizeTireSize(input: string | null | undefined): string | null {
  return matchTireSize(input)?.canonical ?? null;
}

/**
 * PLAIN size digits for quick filtering: the SIZE ONLY (width+aspect+rim), digits run together with no
 * letters, slashes, dots or spaces, and WITHOUT the load index / speed rating. Owner request: filter a tire
 * fast by typing plain numbers. e.g. "255/55R19 111 V" -> "2555519", "P225/60R18 103H" -> "2256018".
 * Returns "" when no confident tire size is found (never guesses a size from arbitrary text).
 */
export function plainTireSizeDigits(input: string | null | undefined): string {
  const m = matchTireSize(input);
  if (!m) return "";
  // canonical may carry a trailing " <load><speed>" (e.g. "225/60R18 103H") - keep only the size span.
  const sizeOnly = m.canonical.split(" ")[0];
  return sizeOnly.replace(/[^0-9]/g, "");
}
