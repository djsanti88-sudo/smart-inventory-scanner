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
const METRIC = /(?:(?<![A-Z0-9])(P|LT|ST)\s*)?(\d{3})\s*\/\s*(\d{2})\s*(ZR|R)\s*(\d{2}(?:\.\d)?)/i;
// Flotation: 35X12.50R20 (the middle is a decimal; construction letter optional). A construction
// prefix (LT/P/ST) is only consumed when directly attached to the flotation number
// ("LT33X12.50R20"). A separated token ("... model LT 35X12.50R20") is ambiguous and must
// remain available to the surrounding model/description parser.
//
// (Bug 2 fix, owner mandate 2026-07-21): the ZR/R/- separator before the rim is now MANDATORY (was
// optional), matching every real flotation size in the corpus (COMMERCIAL's own comment already notes
// "decimal rim required to avoid false positives" for the same reason). Without it, a bicycle "NN X
// N.NNN" dimension like "16 X 2.125" false-matched by splitting the decimal mid-digit ("2.1" width +
// "25" rim, fabricating "16X2.1R25") - there is no separator there at all for this to require.
const FLOTATION = /(?:(?<![A-Z0-9])(P|LT|ST))?(\d{2})\s*X\s*(\d{1,2}\.\d{1,2})\s*(ZR|R|-)\s*(\d{2}(?:\.\d)?)/i;
// (Bug 2 fix) Plausibility bounds for the flotation match: diameter (the "35" in 35X12.50R20) 22-44in,
// width (the "12.50") 4-18in, rim 8-30in - mirrors structurer.ts's isPlausibleTireSize bounds for the
// exact same shape. Guards a technically-separator-bearing but implausible match.
const okFlotationDiameter = (d: number) => d >= 22 && d <= 44;
const okFlotationWidth = (w: number) => w >= 4 && w <= 18;
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
// Agricultural compound rating. This is deliberately recognized only at the start of the
// post-size suffix passed to findLoadSpeed, so model codes such as RT 955R are never consumed.
const AGRICULTURAL_COMPOUND_LOAD_SPEED = /^\s*(\d{2,3}(?:\/\d{2,3})?(?:A8\/B|D\/A8))\b/i;
// Standard speed-rating letters. Excludes I, O (not used), X and Z (Z is carried inside the size as ZR).
const SPEED_LETTERS = new Set("ABCDEFGHJKLMNPQRSTUVWY".split(""));

function findLoadSpeed(remainder: string): { canonical: string; raw: string } | null {
  const agricultural = AGRICULTURAL_COMPOUND_LOAD_SPEED.exec(remainder);
  if (agricultural) return { canonical: agricultural[1].toUpperCase(), raw: agricultural[0].trim() };

  for (const m of remainder.matchAll(LOAD_SPEED)) {
    const speed = m[2].toUpperCase();
    if (SPEED_LETTERS.has(speed)) return { canonical: `${m[1]}${speed}`, raw: m[0] };
  }
  return null;
}

function withLoadSpeed(base: string, input: string, rawSize: string): TireSizeMatch {
  // A load/speed is a suffix of its size. Looking through the entire remaining description can
  // mistake a model code such as "SU318 H" for "318H" when the actual 111T follows the size.
  const sizeOffset = input.indexOf(rawSize);
  const suffix = sizeOffset >= 0 ? input.slice(sizeOffset + rawSize.length) : "";
  const ls = findLoadSpeed(suffix);
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
  if (m && okFlotationDiameter(Number(m[2])) && okFlotationWidth(Number(m[3])) && okRim(Number(m[5]))) {
    const prefix = (m[1] ?? "").toUpperCase();
    return withLoadSpeed(`${prefix}${m[2]}X${m[3]}R${m[5]}`, s, m[0]);
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
