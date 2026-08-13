import { loadCorpusFixtures } from "../boss-barcode-corpus/fixtures.mjs";

export const PREVIEW_LANES = 20;
export const previewBusinessId = (runId, lane) => `${runId}-lane-${String(lane).padStart(2, "0")}`;
export const previewUid = (runId, lane) => `${runId}-user-${String(lane).padStart(2, "0")}`;
export const previewEmail = (runId, lane) => `${runId}-lane-${String(lane).padStart(2, "0")}@preview-cert.invalid`;
export const previewPassword = "PreviewCert-LocalSecret-Only-2026!";

/** Keep every spelling of a canonical code in one lane, so the browser proof detects alias
 * fragmentation instead of merely proving that isolated spellings can resolve. */
export function previewLaneFixtures(lane) {
  if (!Number.isInteger(lane) || lane < 0 || lane >= PREVIEW_LANES) throw new Error("Preview lane is invalid.");
  const fixture = loadCorpusFixtures();
  const spellings = new Map();
  for (const row of fixture.routeSpellings) {
    const list = spellings.get(row.canonicalKey) ?? [];
    list.push(row.code); spellings.set(row.canonicalKey, list);
  }
  // Canonical units are the atomic scheduling unit. Round-robin assignment keeps group counts
  // balanced (difference <= 1) while every spelling remains in exactly one tenant lane.
  const groups = fixture.canonicalUnits
    .map((unit) => ({ ...unit, spellings: spellings.get(unit.canonicalKey) ?? [] }))
    .filter((_unit, index) => index % PREVIEW_LANES === lane);
  if (groups.some((group) => group.spellings.length === 0)) throw new Error("Pinned Preview fixture lost an admitted spelling.");
  const uiSpellings = groups.flatMap((group) => group.spellings);
  if (uiSpellings.length > 1_000) throw new Error("Preview lane exceeds the 1000-spelling safety ceiling.");
  return { manifest: fixture.manifest, groups, uiSpellings };
}
