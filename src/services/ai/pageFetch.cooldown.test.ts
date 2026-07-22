import { describe, it, expect, beforeEach } from "vitest";
import { fetchPages, hostOnCooldown, setHostCooldown, resetHostCooldowns, type FetchImpl } from "@/services/ai/pageFetch";

beforeEach(() => resetHostCooldowns());

describe("host cooldown", () => {
  it("is set manually and expires after 10 minutes", () => {
    const t0 = 1_000_000;
    setHostCooldown("https://go-upc.com/search?q=1", t0);
    expect(hostOnCooldown("https://go-upc.com/other", t0 + 1)).toBe(true);
    expect(hostOnCooldown("https://go-upc.com/other", t0 + 10 * 60_000 + 1)).toBe(false);
    expect(hostOnCooldown("https://upcitemdb.com/upc/1", t0 + 1)).toBe(false);
  });

  it("fetchPages skips cooled-down hosts without calling fetch", async () => {
    const calls: string[] = [];
    const impl: FetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => "<html>x</html>" }; };
    setHostCooldown("https://go-upc.com/x");
    await fetchPages(["https://go-upc.com/search?q=1", "https://upcitemdb.com/upc/1"], { fetchImpl: impl });
    expect(calls).toEqual(["https://upcitemdb.com/upc/1"]);
  });

  it("a doubly rate-limited host lands on cooldown", async () => {
    const impl: FetchImpl = async () => ({ ok: false, status: 429, text: async () => "" });
    await fetchPages(["https://go-upc.com/search?q=1"], { fetchImpl: impl, backoffMs: 1 });
    expect(hostOnCooldown("https://go-upc.com/anything")).toBe(true);
  });
});
