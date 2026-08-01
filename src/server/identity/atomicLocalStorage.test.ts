import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileAtomicLocalStorage, createMemoryAtomicLocalStorage } from "./atomicLocalStorage";

const storageBase = path.resolve(process.cwd(), ".tmp", "identity-import");
const ownedRoots: string[] = [];

function testRoot(): string {
  const root = path.resolve(storageBase, `atomic-${randomUUID()}`);
  ownedRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    ownedRoots.splice(0).map(async (root) => {
      if (path.dirname(root) !== storageBase) throw new Error("refusing to remove a non-test identity root");
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("createFileAtomicLocalStorage", () => {
  it("reads only one indexed review page and its summaries for 100 durable reviews", async () => {
    const root = testRoot();
    const reviews = Array.from({ length: 100 }, (_, index) => ({
      reviewId: `review-${String(index).padStart(3, "0")}`,
      businessId: "shop-a",
      decision: { kind: index % 2 === 0 ? "review" : "abstain" },
    }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-reviews", reviews));
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); } } });

    const page = await storage.transaction(async (transaction) => transaction.scanPage!("identity-reviews", {
      offset: 25,
      limit: 25,
      filter: (review: typeof reviews[number]) => review.businessId === "shop-a",
      visible: (review) => review.decision.kind === "review",
      compare: (left, right) => left.reviewId.localeCompare(right.reviewId),
      groupBy: (review) => review.decision.kind,
      physical: { kind: "identity-reviews", businessId: "shop-a", bucket: "review" },
    }));

    expect(page.items).toHaveLength(25);
    expect(page.items[0]).toMatchObject({ reviewId: "review-050" });
    expect(page).toMatchObject({ total: 50, groupTotals: { review: 50, abstain: 50 } });
    expect(reads.some((read) => read.filePath.endsWith(".state.json"))).toBe(false);
    expect(reads.reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(25);
    expect(reads.reduce((total, read) => total + read.bytes, 0)).toBeLessThanOrEqual(64 * 1024);
    expect(reads).toHaveLength(3);
  });

  it("reads only bounded current-link pages for 500 durable identity families", async () => {
    const root = testRoot();
    const links = Array.from({ length: 500 }, (_, index) => {
      const value = String(index).padStart(3, "0");
      return { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: value, targetProductId: `tire-${value}`, status: "approved", version: 1 };
    });
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", links));
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); } } });

    const page = await storage.transaction(async (transaction) => transaction.scanPage!("identity-links", {
      offset: 25,
      limit: 25,
      filter: (link: typeof links[number]) => link.businessId === "shop-a",
      compare: (left, right) => left.normalizedValue.localeCompare(right.normalizedValue),
      collapseBy: (link) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]),
      versionOf: (link) => link.version,
      physical: { kind: "identity-links", businessId: "shop-a", mode: "current" },
    }));

    expect(page.items).toHaveLength(25);
    expect(page.items[0]).toMatchObject({ normalizedValue: "025" });
    expect(page.total).toBe(500);
    expect(reads.some((read) => read.filePath.endsWith(".state.json"))).toBe(false);
    expect(reads.reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(25);
    expect(reads.reduce((total, read) => total + read.bytes, 0)).toBeLessThanOrEqual(64 * 1024);
    expect(reads).toHaveLength(3);
  });

  it("reads only one approved-link page for 500 durable approved families", async () => {
    const root = testRoot();
    const links = Array.from({ length: 500 }, (_, index) => {
      const value = String(index).padStart(3, "0");
      return { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: value, targetProductId: `tire-${value}`, status: "approved", version: 1 };
    });
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", links));
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); } } });

    const page = await storage.transaction(async (transaction) => transaction.scanPage!("identity-links", {
      offset: 25,
      limit: 25,
      baseItems: [],
      filter: (link: typeof links[number]) => link.businessId === "shop-a",
      visible: (link) => link.status === "approved",
      compare: (left, right) => left.normalizedValue.localeCompare(right.normalizedValue),
      collapseBy: (link) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]),
      versionOf: (link) => link.version,
      physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" },
    }));

    expect(page.items).toHaveLength(25);
    expect(page.items[0]).toMatchObject({ normalizedValue: "025" });
    expect(page.total).toBe(500);
    expect(reads.some((read) => read.filePath.endsWith(".state.json"))).toBe(false);
    expect(reads.reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(25);
    expect(reads.reduce((total, read) => total + read.bytes, 0)).toBeLessThanOrEqual(64 * 1024);
    expect(reads).toHaveLength(3);
  });

  it("keeps durable tombstones authoritative over 500 configured links without reading the durable envelope", async () => {
    const root = testRoot();
    const configured = Array.from({ length: 500 }, (_, index) => {
      const value = String(index).padStart(3, "0");
      return { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: value, targetProductId: `configured-${value}`, status: "approved", version: 1 };
    });
    const durable = [
      { ...configured[0]!, status: "revoked", version: 2 },
      { ...configured[0]!, normalizedValue: "000a", targetProductId: "durable-new", version: 1 },
    ];
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", durable));
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); } } });

    const page = await storage.transaction(async (transaction) => transaction.scanPage!("identity-links", {
      offset: 0,
      limit: 25,
      baseItems: configured,
      filter: (link: typeof configured[number]) => link.businessId === "shop-a",
      visible: (link) => link.status === "approved",
      compare: (left, right) => left.normalizedValue.localeCompare(right.normalizedValue),
      collapseBy: (link) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]),
      versionOf: (link) => link.version,
      physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" },
    }));

    expect(page.total).toBe(500);
    expect(page.items).not.toContainEqual(expect.objectContaining({ normalizedValue: "000" }));
    expect(page.items).toContainEqual(expect.objectContaining({ normalizedValue: "000a", targetProductId: "durable-new" }));
    expect(page.origins[page.items.findIndex((link) => link.normalizedValue === "000a")]).toBe("stored");
    expect(reads.some((read) => read.filePath.endsWith(".state.json"))).toBe(false);
    expect(reads.reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(25);
  });

  it("migrates a v1 envelope once and reconstructs bounded pages without rereading legacy state", async () => {
    const root = testRoot();
    await mkdir(root, { recursive: true });
    const reviews = Array.from({ length: 100 }, (_, index) => ({ reviewId: `review-${String(index).padStart(3, "0")}`, businessId: "shop-a", decision: { kind: "review" } }));
    await writeFile(path.join(root, "identity-local-storage.json"), JSON.stringify({ version: 1, values: { "identity-reviews": reviews, preserved: { value: true } } }), "utf8");
    const first = createFileAtomicLocalStorage({ root });
    await expect(first.transaction((transaction) => transaction.get("preserved"))).resolves.toEqual({ value: true });
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const recovered = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); } } });

    const page = await recovered.transaction((transaction) => transaction.scanPage!("identity-reviews", {
      offset: 75,
      limit: 25,
      filter: (review: typeof reviews[number]) => review.businessId === "shop-a",
      compare: (left, right) => left.reviewId.localeCompare(right.reviewId),
      groupBy: (review) => review.decision.kind,
      physical: { kind: "identity-reviews", businessId: "shop-a" },
    }));

    expect(page.items[0]).toMatchObject({ reviewId: "review-075" });
    expect(reads.some((read) => read.filePath.endsWith(".state.json"))).toBe(false);
    expect(reads.reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(25);
  });

  it("refuses a root outside the repository-local identity-import directory", () => {
    expect(() => createFileAtomicLocalStorage({ root: path.resolve(process.cwd(), ".tmp", "elsewhere") })).toThrow(
      /identity-import/,
    );
  });

  it("commits concurrent transactions without losing a write", async () => {
    const storage = createFileAtomicLocalStorage({ root: testRoot() });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        storage.transaction(async (transaction) => transaction.set(`item-${index}`, { index })),
      ),
    );

    const items = await storage.transaction(async (transaction) =>
      Promise.all(Array.from({ length: 20 }, (_, index) => transaction.get<{ index: number }>(`item-${index}`))),
    );
    expect(items.map((item) => item?.index)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it("serializes two adapters addressed to the same Windows directory through case aliases", async () => {
    const root = testRoot();
    const caseAlias = path.join(storageBase, path.basename(root).toUpperCase());
    const first = createFileAtomicLocalStorage({ root });
    const second = createFileAtomicLocalStorage({ root: caseAlias });
    await Promise.all([
      first.transaction((transaction) => transaction.set("first", true)),
      second.transaction((transaction) => transaction.set("second", true)),
    ]);

    await expect(first.transaction(async (transaction) => [await transaction.get("first"), await transaction.get("second")])).resolves.toEqual([true, true]);
  });

  it("survives reconstruction using an atomic same-directory replacement", async () => {
    const root = testRoot();
    const first = createFileAtomicLocalStorage({ root });
    await first.transaction(async (transaction) => transaction.set("run", { state: "applied" }));

    const second = createFileAtomicLocalStorage({ root });
    await expect(second.transaction((transaction) => transaction.get("run"))).resolves.toEqual({ state: "applied" });
    await expect(access(path.join(root, "identity-local-storage.json"))).resolves.toBeUndefined();
  });

  it("rolls back a failed memory transaction and does not expose callback mutations", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await storage.transaction((transaction) => transaction.set("record", { values: ["original"] }));
    await expect(
      storage.transaction(async (transaction) => {
        const record = await transaction.get<{ values: string[] }>("record");
        if (!record) throw new Error("missing record");
        record.values.push("mutated");
        await transaction.set("record", record);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    await expect(storage.transaction((transaction) => transaction.get("record"))).resolves.toEqual({ values: ["original"] });
  });

  it("rejects a symlinked child and corrupt parsed state", async () => {
    const root = testRoot();
    const outside = path.resolve(storageBase, `outside-${randomUUID()}`);
    ownedRoots.push(outside);
    await mkdir(outside, { recursive: true });
    await rm(root, { recursive: true, force: true });
    await symlink(outside, root, "junction");
    expect(() => createFileAtomicLocalStorage({ root })).toThrow(/reparse|symlink|identity-import/i);

    const corrupt = testRoot();
    await mkdir(corrupt, { recursive: true });
    await writeFile(path.join(corrupt, "identity-local-storage.json"), JSON.stringify(["not", "state"]), "utf8");
    await expect(createFileAtomicLocalStorage({ root: corrupt }).transaction(async () => undefined)).rejects.toThrow(
      /identity_storage_corrupt/,
    );
  });

  it("rejects a symlinked state file before reading it", async () => {
    const root = testRoot();
    const outside = path.resolve(storageBase, `state-outside-${randomUUID()}`);
    ownedRoots.push(outside);
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, "identity-local-storage.json"), "junction");

    await expect(createFileAtomicLocalStorage({ root }).transaction(async () => undefined)).rejects.toThrow(/reparse|symlink/i);
  });

  it("creates a missing repository-local identity-import base before creating its child", async () => {
    const fakeRepository = path.resolve(storageBase, `clean-repository-${randomUUID()}`);
    const fakeRoot = path.join(fakeRepository, ".tmp", "identity-import", "run-a");
    ownedRoots.push(fakeRepository);
    await mkdir(fakeRepository, { recursive: true });
    const cwd = process.cwd;
    process.cwd = () => fakeRepository;
    try {
      const storage = createFileAtomicLocalStorage({ root: fakeRoot });
      await storage.transaction((transaction) => transaction.set("created", true));
      await expect(access(path.join(fakeRoot, "identity-local-storage.json"))).resolves.toBeUndefined();
    } finally {
      process.cwd = cwd;
    }
  });

  it.each(["write", "rename"] as const)("cleans an incomplete temporary state file when %s fails", async (phase) => {
    const root = testRoot();
    const storage = createFileAtomicLocalStorage({
      root,
      io: phase === "write"
        ? { writeTemp: async (temp) => { await writeFile(temp, "partial", "utf8"); throw new Error("write failed"); } }
        : { replace: async () => { throw new Error("rename failed"); } },
    });

    await expect(storage.transaction((transaction) => transaction.set("record", true))).rejects.toThrow(`${phase} failed`);
    await expect(readdir(root)).resolves.not.toContainEqual(expect.stringMatching(/\.tmp$/));
  });

  it("keeps the previous generation authoritative when the manifest swap fails", async () => {
    const root = testRoot();
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "before" }));
    const failing = createFileAtomicLocalStorage({ root, io: { replace: async () => { throw new Error("manifest swap failed"); } } });

    await expect(failing.transaction((transaction) => transaction.set("record", { value: "after" }))).rejects.toThrow("manifest swap failed");

    const recovered = createFileAtomicLocalStorage({ root });
    await expect(recovered.transaction((transaction) => transaction.get("record"))).resolves.toEqual({ value: "before" });
  });

  it("retains only the current and previous immutable generations after successful commits", async () => {
    const root = testRoot();
    const storage = createFileAtomicLocalStorage({ root });
    await storage.transaction((transaction) => transaction.set("record", { value: 1 }));
    await storage.transaction((transaction) => transaction.set("record", { value: 2 }));
    await storage.transaction((transaction) => transaction.set("record", { value: 3 }));

    const generations = new Set((await readdir(root)).map((name) => /^identity-local-storage\.([a-f0-9-]{36})\..+\.json$/.exec(name)?.[1]).filter(Boolean));
    expect(generations.size).toBeLessThanOrEqual(2);
    await expect(createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.get("record"))).resolves.toEqual({ value: 3 });
  });

  it("propagates a real directory sync I/O error after replacement", async () => {
    const root = testRoot();
    const storage = createFileAtomicLocalStorage({
      root,
      io: { syncDirectory: async () => { const error = new Error("disk I/O failed") as NodeJS.ErrnoException; error.code = "EIO"; throw error; } },
    });

    await expect(storage.transaction((transaction) => transaction.set("record", true))).rejects.toThrow("disk I/O failed");
  });
});
