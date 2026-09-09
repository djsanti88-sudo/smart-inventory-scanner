import { describe, it, expect } from "vitest";
import { requiresOwnerPin } from "./destructiveGuard";

describe("requiresOwnerPin", () => {
  it("gates every destructive action when a PIN is set", () => {
    expect(requiresOwnerPin("markWrong", true)).toBe(true);
    expect(requiresOwnerPin("removeFromCount", true)).toBe(true);
    expect(requiresOwnerPin("clearCache", true)).toBe(true);
  });
  it("does not gate when no PIN is set (falls back to confirm, owner never locked out)", () => {
    expect(requiresOwnerPin("markWrong", false)).toBe(false);
    expect(requiresOwnerPin("clearCache", false)).toBe(false);
  });
});
