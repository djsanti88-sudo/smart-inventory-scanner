import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

function waitForChildLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) { child.stdout.off("data", onData); resolve(); }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => { if (!output.includes(expected)) reject(new Error(`child exited ${code}: ${output}`)); });
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let errorOutput = "";
    child.stderr.on("data", (chunk: Buffer) => { errorOutput += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${errorOutput}`)));
  });
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
  it("does not materialize an absent file root for a read-only preview page", async () => {
    const root = testRoot();
    const storage = createFileAtomicLocalStorage({ root });

    await expect(storage.read!((transaction) => transaction.scanPage!("identity-links", {
      offset: 0,
      limit: 25,
      filter: () => true,
      visible: () => true,
      compare: () => 0,
      physical: { kind: "identity-links", businessId: "shop-a", mode: "current" },
    }))).resolves.toMatchObject({ items: [], total: 0 });

    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invokes an absent-root mutation callback and its external validation side effect exactly once", async () => {
    const root = testRoot();
    let callbacks = 0, validations = 0;

    await createFileAtomicLocalStorage({ root }).transaction(async (transaction) => {
      callbacks += 1;
      validations += await Promise.resolve(1);
      await transaction.set("record", { value: "committed" });
    });

    expect({ callbacks, validations }).toEqual({ callbacks: 1, validations: 1 });
    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.get("record"))).resolves.toEqual({ value: "committed" });
  });

  it("coordinates physical-root aliases and keeps Linux distinct-case child roots independent", async () => {
    const root = testRoot();
    const alias = process.platform === "win32"
      ? path.join(path.dirname(root).toUpperCase(), path.basename(root).toUpperCase())
      : path.join(root, ".");
    const first = createFileAtomicLocalStorage({ root });
    const second = createFileAtomicLocalStorage({ root: alias });

    await first.transaction((transaction) => transaction.set("first", { value: 1 }));
    await second.transaction((transaction) => transaction.set("second", { value: 2 }));
    await expect(first.read!((transaction) => transaction.get("second"))).resolves.toEqual({ value: 2 });
    await expect(second.read!((transaction) => transaction.get("first"))).resolves.toEqual({ value: 1 });

    let arriveAtStart: (() => void) | undefined;
    const start = new Promise<void>((resolve) => { arriveAtStart = resolve; });
    let waiting = 0;
    let confirmBothWaiting: (() => void) | undefined;
    const bothWaiting = new Promise<void>((resolve) => { confirmBothWaiting = resolve; });
    const overlap = async (storage: typeof first, key: string) => {
      waiting += 1;
      if (waiting === 2) confirmBothWaiting?.();
      await start;
      await storage.transaction(async (transaction) => {
        const shared = (await transaction.get<Record<string, string>>("overlap")) ?? {};
        shared[key] = key;
        await transaction.set("overlap", shared);
      });
    };
    const both = Promise.all([overlap(first, "first"), overlap(second, "second")]);
    await bothWaiting;
    arriveAtStart?.();
    await both;
    await expect(first.read!((transaction) => transaction.get("overlap"))).resolves.toEqual({ first: "first", second: "second" });

    if (process.platform !== "win32") {
      const lower = testRoot();
      const upper = path.join(storageBase, `${path.basename(lower).toUpperCase()}-CASE`);
      ownedRoots.push(upper);
      const entered: string[] = [];
      let release: (() => void) | undefined;
      const bothEntered = new Promise<void>((resolve) => { release = resolve; });
      const waitForBoth = Promise.race([
        bothEntered,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("distinct case roots shared a mutex")), 250)),
      ]);
      const run = (candidate: string, key: string) => createFileAtomicLocalStorage({ root: candidate }).transaction(async (transaction) => {
        entered.push(key);
        if (entered.length === 2) release?.();
        await waitForBoth;
        await transaction.set(key, { value: key });
      });
      await Promise.all([run(lower, "lower"), run(upper, "upper")]);
      await expect(createFileAtomicLocalStorage({ root: lower }).read!((transaction) => transaction.get("lower"))).resolves.toEqual({ value: "lower" });
      await expect(createFileAtomicLocalStorage({ root: upper }).read!((transaction) => transaction.get("upper"))).resolves.toEqual({ value: "upper" });
    }
  });

  it("performs an initialized-root preview read without creating a lock or cache file", async () => {
    const root = testRoot();
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", []));
    const before = await readdir(root);
    const storage = createFileAtomicLocalStorage({ root });

    await expect(storage.read!((transaction) => transaction.scanPage!("identity-links", {
      offset: 0,
      limit: 25,
      filter: () => true,
      compare: () => 0,
      physical: { kind: "identity-links", businessId: "shop-a", mode: "current" },
    }))).resolves.toMatchObject({ items: [], total: 0 });

    expect(await readdir(root)).toEqual(before);
    expect(before).not.toContain("identity-local-storage.lock");
  });

  it("serializes two independent Node writers without losing an update or deleting the live generation", async () => {
    const root = testRoot();
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("cross-process", {}));
    const barrier = path.join(root, "cross-process.start");
    const modulePath = path.resolve(process.cwd(), "src/server/identity/atomicLocalStorage.ts");
    const childProgram = `
      import { access } from "node:fs/promises";
      import { pathToFileURL } from "node:url";
      const [modulePath, root, barrier, itemKey] = process.argv.slice(1);
      const { createFileAtomicLocalStorage } = await import(pathToFileURL(modulePath).href);
      process.stdout.write("READY\\n");
      while (true) { try { await access(barrier); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
      await createFileAtomicLocalStorage({ root }).transaction(async (transaction) => {
        const current = (await transaction.get("cross-process")) ?? {};
        await new Promise((resolve) => setTimeout(resolve, 50));
        current[itemKey] = itemKey;
        await transaction.set("cross-process", current);
      });
      process.stdout.write("DONE\\n");
    `;
    const children = ["first", "second"].map((itemKey) => spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", childProgram, modulePath, root, barrier, itemKey], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }));
    const exits = children.map(waitForChildExit);
    await Promise.all(children.map((child) => waitForChildLine(child, "READY")));
    await writeFile(barrier, "start", "utf8");
    await Promise.all(exits);

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.get("cross-process"))).resolves.toEqual({ first: "first", second: "second" });
    const manifest = JSON.parse(await readFile(path.join(root, "identity-local-storage.json"), "utf8"));
    const names = await readdir(root);
    expect(names.some((name) => name.startsWith(`identity-local-storage.${manifest.generation}.`))).toBe(true);
    expect(names).not.toContain("identity-local-storage.lock");
  });

  it("serializes two absent-root writers against the locked latest snapshot with one callback each", async () => {
    const root = testRoot(), barrier = path.join(storageBase, `first-writers-${randomUUID()}.start`);
    ownedRoots.push(barrier);
    const modulePath = path.resolve(process.cwd(), "src/server/identity/atomicLocalStorage.ts");
    const childProgram = `
      import { access } from "node:fs/promises";
      import { pathToFileURL } from "node:url";
      const [modulePath, root, barrier, itemKey] = process.argv.slice(1);
      const { createFileAtomicLocalStorage } = await import(pathToFileURL(modulePath).href);
      process.stdout.write("READY\\n");
      while (true) { try { await access(barrier); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
      let callbacks = 0;
      await createFileAtomicLocalStorage({ root }).transaction(async (transaction) => {
        callbacks += 1;
        const current = (await transaction.get("shared-first-write")) ?? {};
        current[itemKey] = itemKey;
        await transaction.set("shared-first-write", current);
      });
      if (callbacks !== 1) throw new Error("callback_count:" + callbacks);
    `;
    const children = ["first", "second"].map((itemKey) => spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", childProgram, modulePath, root, barrier, itemKey], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }));
    const exits = children.map(waitForChildExit);
    await Promise.all(children.map((child) => waitForChildLine(child, "READY")));
    await writeFile(barrier, "start", "utf8");
    await Promise.all(exits);

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.get("shared-first-write"))).resolves.toEqual({ first: "first", second: "second" });
  });

  it("bounds a cold 500-configured plus 500-durable authoritative page to two immutable index/data files and 25 records", async () => {
    const root = testRoot();
    const configured = Array.from({ length: 500 }, (_, index) => {
      const value = `c-${String(index).padStart(3, "0")}`;
      return { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: value, targetProductId: `configured-${value}`, status: "approved", version: 1 };
    });
    const durable = Array.from({ length: 500 }, (_, index) => {
      const value = `d-${String(index).padStart(3, "0")}`;
      return { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: value, targetProductId: `durable-${value}`, status: "approved", version: 1 };
    });
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", durable));
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); } } });

    const page = await storage.read!((transaction) => transaction.scanPage!("identity-links", {
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

    expect(page.total).toBe(1_000);
    expect(page.items).toHaveLength(25);
    expect(new Set(reads.filter((read) => !read.filePath.endsWith("identity-local-storage.json")).map((read) => read.filePath)).size).toBeLessThanOrEqual(2);
    expect(reads.reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(25);
    expect(await readdir(root)).not.toContain("identity-local-storage.lock");
  });

  it("resolves 25 scattered exact link families from at most one immutable index and one data file", async () => {
    const root = testRoot();
    const links = Array.from({ length: 500 }, (_, index) => {
      const value = String(index).padStart(3, "0");
      return { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: value, targetProductId: `tire-${value}`, status: "approved", version: 1 };
    });
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", links));
    const families = links.filter((_link, index) => index % 20 === 0).slice(0, 25).map((link) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]));
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); } } });

    const page = await storage.read!((transaction) => transaction.scanPage!("identity-links", {
      offset: 0,
      limit: 25,
      filter: (link: typeof links[number]) => link.businessId === "shop-a",
      visible: (link) => families.includes(JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue])),
      compare: (left, right) => left.normalizedValue.localeCompare(right.normalizedValue),
      collapseBy: (link) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]),
      versionOf: (link) => link.version,
      physical: { kind: "identity-links", businessId: "shop-a", mode: "families", families },
    }));

    expect(page.items).toHaveLength(25);
    expect(new Set(reads.filter((read) => !read.filePath.endsWith("identity-local-storage.json")).map((read) => read.filePath)).size).toBeLessThanOrEqual(2);
    expect(reads.reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(25);
  });

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

  it("rejects a manifest generation change observed immediately before swap", async () => {
    const root = testRoot(), statePath = path.join(root, "identity-local-storage.json");
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "before" }));
    const originalManifest = await readFile(statePath, "utf8");
    const racingManifest = JSON.stringify({ version: 2, generation: randomUUID() });
    const racing = createFileAtomicLocalStorage({
      root,
      io: {
        writeTemp: async (tempPath, body) => {
          await writeFile(tempPath, body, "utf8");
          await writeFile(statePath, racingManifest, "utf8");
        },
      },
    });

    await expect(racing.transaction((transaction) => transaction.set("record", { value: "after" }))).rejects.toThrow("identity_storage_manifest_conflict");
    await writeFile(statePath, originalManifest, "utf8");
    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.get("record"))).resolves.toEqual({ value: "before" });
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

  it("pins a reader generation while two writers publish and clean up newer generations", async () => {
    const root = testRoot(), release = path.join(root, "reader.release"), resultPath = path.join(root, "reader.result.json");
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "before" }));
    const modulePath = path.resolve(process.cwd(), "src/server/identity/atomicLocalStorage.ts");
    const childProgram = `
      import { access, writeFile } from "node:fs/promises";
      import { pathToFileURL } from "node:url";
      const [modulePath, root, release, resultPath] = process.argv.slice(1);
      const { createFileAtomicLocalStorage } = await import(pathToFileURL(modulePath).href);
      const storage = createFileAtomicLocalStorage({ root });
      let result;
      try { result = { value: await storage.read(async (transaction) => {
        process.stdout.write("READY\\n");
        while (true) { try { await access(release); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
        return transaction.get("record");
      }) }; }
      catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      await writeFile(resultPath, JSON.stringify(result), "utf8");
    `;
    const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", childProgram, modulePath, root, release, resultPath], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    const exit = waitForChildExit(child);
    await waitForChildLine(child, "READY");
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "after-1" }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "after-2" }));
    await writeFile(release, "continue", "utf8");
    await exit;

    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ value: { value: "before" } });
  });

  it("publishes a reader pin from a synced non-matching temp while cleanup advances generations", async () => {
    const root = testRoot(), release = path.join(root, "pin-publish.release"), resultPath = path.join(root, "pin-publish.result.json");
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "before" }));
    const modulePath = path.resolve(process.cwd(), "src/server/identity/atomicLocalStorage.ts");
    const childProgram = `
      import { access, writeFile } from "node:fs/promises";
      import { pathToFileURL } from "node:url";
      const [modulePath, root, release, resultPath] = process.argv.slice(1);
      const { createFileAtomicLocalStorage } = await import(pathToFileURL(modulePath).href);
      let paused = false, result;
      const storage = createFileAtomicLocalStorage({ root, io: { beforeReaderPinPublish: async (filePath) => {
        if (paused) return;
        paused = true;
        process.stdout.write("PIN_TEMP_SYNCED:" + filePath + "\\n");
        while (true) { try { await access(release); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
      } } });
      try { result = { value: await storage.read((transaction) => transaction.get("record")) }; }
      catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      await writeFile(resultPath, JSON.stringify(result), "utf8");
    `;
    const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", childProgram, modulePath, root, release, resultPath], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    const exit = waitForChildExit(child);
    await waitForChildLine(child, "PIN_TEMP_SYNCED:");
    const duringPublication = await readdir(root);
    expect(duringPublication.some((name) => name.includes("reader-pin") && name.endsWith(".tmp"))).toBe(true);
    expect(duringPublication.some((name) => name.endsWith(".pin"))).toBe(false);

    for (const value of ["after-1", "after-2", "after-3"]) {
      await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value }));
    }
    await writeFile(release, "continue", "utf8");
    await exit;

    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ value: { value: "after-3" } });
    expect((await readdir(root)).filter((name) => name.includes("reader") && (name.endsWith(".pin") || name.endsWith(".tmp")))).toEqual([]);
  });

  it("removes an abandoned dead-process reader pin during locked generation cleanup", async () => {
    const root = testRoot(), statePath = path.join(root, "identity-local-storage.json");
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "before" }));
    const generation = JSON.parse(await readFile(statePath, "utf8")).generation as string, token = randomUUID();
    const pinPath = path.join(root, `identity-local-storage.reader.${generation}.${token}.pin`);
    await writeFile(pinPath, JSON.stringify({ token, pid: 2_147_483_647, generation }), "utf8");

    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "after-1" }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "after-2" }));

    await expect(access(pinPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes explicit schema, merge, and order versions with the immutable exact-link index", async () => {
    const root = testRoot();
    const link = { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: "001", targetProductId: "tire-001", status: "approved", version: 1 };
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", [link]));
    const indexName = (await readdir(root)).find((name) => name.includes(".links.") && name.endsWith(".exact.index.json"));

    expect(indexName).toBeDefined();
    const index = JSON.parse(await readFile(path.join(root, indexName!), "utf8"));
    expect(index).toMatchObject({
      schemaVersion: 1,
      mergeAlgorithmVersion: "identity-links-merge-v1",
      orderAlgorithmVersion: "identity-links-order-v1",
      businessId: "shop-a",
    });
  });

  it("fails an oversized exact-link record before publishing its generation", async () => {
    const root = testRoot();
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "before" }));
    const oversized = { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: "001", targetProductId: "tire-001", status: "approved", version: 1, evidence: "x".repeat(4_000) };

    await expect(createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", [oversized]))).rejects.toThrow("identity_storage_exact_record_too_large");
    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.get("record"))).resolves.toEqual({ value: "before" });
  });

  it.each([1, 2, 3, 4])("recovers after interruption following immutable generation file write %s without publishing a partial generation", async (failAt) => {
    const root = testRoot();
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "before" }));
    const links = Array.from({ length: 30 }, (_, index) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: String(index).padStart(3, "0"), targetProductId: `tire-${index}`, status: "approved", version: 1 }));
    let writes = 0;
    const interrupted = createFileAtomicLocalStorage({
      root,
      io: {
        afterGenerationFileWrite: async () => {
          writes += 1;
          if (writes === failAt) throw new Error(`generation interruption ${failAt}`);
        },
      },
    });

    await expect(interrupted.transaction(async (transaction) => {
      await transaction.set("record", { value: "partial" });
      await transaction.set("identity-links", links);
    })).rejects.toThrow(`generation interruption ${failAt}`);
    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.get("record"))).resolves.toEqual({ value: "before" });

    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "after" }));
    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.get("record"))).resolves.toEqual({ value: "after" });
    const liveManifest = JSON.parse(await readFile(path.join(root, "identity-local-storage.json"), "utf8"));
    expect((await readdir(root)).some((name) => name.startsWith(`identity-local-storage.${liveManifest.generation}.`))).toBe(true);
  });

  it("reports an indeterminate committed result after a post-swap directory-sync failure and makes retry idempotent", async () => {
    const root = testRoot();
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "before" }));
    let syncs = 0;
    const failing = createFileAtomicLocalStorage({
      root,
      io: {
        syncDirectory: async () => {
          syncs += 1;
          if (syncs === 2) throw new Error("post-swap disk I/O failed");
        },
      },
    });

    await expect(failing.transaction((transaction) => transaction.set("record", { value: "after" }))).rejects.toThrow(/identity_storage_commit_indeterminate/);
    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.get("record"))).resolves.toEqual({ value: "after" });
    await expect(createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("record", { value: "after" }))).resolves.toBeUndefined();
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
