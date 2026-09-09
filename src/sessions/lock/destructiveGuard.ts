// Which destructive actions require the owner PIN before proceeding. Reuses the existing ownerPin
// hash machinery (settings.ownerPinHash, verifyOwnerPin in the store). When no PIN is set, we do NOT
// gate (the action still shows its window.confirm) so a PIN-less owner is never locked out - matching
// the SessionLockControl philosophy that a forgotten/absent PIN can never trap a count.

export type DestructiveAction = "markWrong" | "removeFromCount" | "clearCache";

export function requiresOwnerPin(action: DestructiveAction, hasPin: boolean): boolean {
  void action; // all three are equally destructive; the gate is uniform when a PIN exists
  return hasPin;
}
