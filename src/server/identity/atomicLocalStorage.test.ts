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

async function withHangGuard<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} did not occur`)), 1_000);
  });
  try { return await Promise.race([promise, guard]); }
  finally { if (timeout) clearTimeout(timeout); }
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

  it("coordinates adapters sharing a normalized root and keeps POSIX distinct-case child roots independent", async () => {
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

    let signalSecondMutexAttempted: (() => void) | undefined;
    const secondMutexAttempted = new Promise<void>((resolve) => { signalSecondMutexAttempted = resolve; });
    let signalSecondMutexAcquired: (() => void) | undefined;
    const secondMutexAcquired = new Promise<void>((resolve) => { signalSecondMutexAcquired = resolve; });
    let secondHasMutex = false;
    const overlappingSecond = createFileAtomicLocalStorage({
      root: alias,
      io: {
        beforeMutexAcquire: () => { signalSecondMutexAttempted?.(); },
        afterMutexAcquire: () => { secondHasMutex = true; signalSecondMutexAcquired?.(); },
      },
    });

    let signalFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => { signalFirstEntered = resolve; });
    let releaseFirst: (() => void) | undefined;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstAttempt = first.transaction(async (transaction) => {
      const shared = (await transaction.get<Record<string, string>>("overlap")) ?? {};
      signalFirstEntered?.();
      await firstRelease;
      shared.first = "first";
      await transaction.set("overlap", shared);
    });
    await firstEntered;

    let secondCallbackEntered = false;
    const secondAttempt = overlappingSecond.transaction(async (transaction) => {
      secondCallbackEntered = true;
      const shared = (await transaction.get<Record<string, string>>("overlap")) ?? {};
      shared.second = "second";
      await transaction.set("overlap", shared);
    });
    let hookFailure: unknown;
    try {
      await withHangGuard(secondMutexAttempted, "second beforeMutexAcquire hook");
      expect(secondHasMutex).toBe(false);
      expect(secondCallbackEntered).toBe(false);
    } catch (error) {
      hookFailure = error;
    }
    releaseFirst?.();
    await Promise.all([firstAttempt, secondAttempt]);
    if (hookFailure) throw hookFailure;
    await withHangGuard(secondMutexAcquired, "second afterMutexAcquire hook");
    expect(secondHasMutex).toBe(true);
    expect(secondCallbackEntered).toBe(true);
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
    expect(reads.some((read) => read.filePath.includes("exact.descriptor"))).toBe(false);
    expect(reads.filter((read) => read.filePath.endsWith(".exact.data.json")).reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(25);
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
    expect(reads.some((read) => read.filePath.includes("exact.descriptor"))).toBe(true);
    expect(reads.filter((read) => read.filePath.endsWith(".exact.data.json")).reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(25);
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
    const probes: number[] = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); }, observeSeek: (probe) => { probes.push(probe.pageNumber); } } });

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

  it("seeks a review cursor near row 500 through its file directory without reading state", async () => {
    const root = testRoot();
    const reviews = Array.from({ length: 550 }, (_, index) => ({
      reviewId: `review-${String(index).padStart(3, "0")}`,
      businessId: "shop-a",
      decision: { kind: "review" },
    }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-reviews", reviews));
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const probes: number[] = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); }, observeSeek: (probe) => { probes.push(probe.pageNumber); } } });

    const page = await storage.read!((transaction) => transaction.scanPage!("identity-reviews", {
      after: { reviewId: "review-499" },
      isAfter: (review: typeof reviews[number], after) => review.reviewId.localeCompare(after.reviewId) > 0,
      limit: 26,
      filter: (review: typeof reviews[number]) => review.businessId === "shop-a",
      visible: (review) => review.decision.kind === "review",
      compare: (left, right) => left.reviewId.localeCompare(right.reviewId),
      groupBy: (review) => review.decision.kind,
      physical: { kind: "identity-reviews", businessId: "shop-a", bucket: "review" },
    }));

    expect(page.items.map((review) => review.reviewId)).toEqual(Array.from({ length: 26 }, (_, index) => `review-${String(index + 500).padStart(3, "0")}`));
    expect(reads.some((read) => read.filePath.endsWith(".state.json"))).toBe(false);
    expect(reads.reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(50);
    expect(probes).toHaveLength(4);
    expect(probes).toEqual([11, 17, 20, 19]);
  });

  it("seeks current and authoritative link cursors near row 500 without state fallback", async () => {
    const root = testRoot();
    const links = Array.from({ length: 550 }, (_, index) => {
      const value = String(index).padStart(3, "0");
      return { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: value, targetProductId: `durable-${value}`, status: "approved", version: 1 };
    });
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", links));
    const familyKey = (link: typeof links[number]) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);
    const after = { normalizedValue: "499", familyKey: familyKey(links[499]!) };
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); } } });
    const options = {
      after,
      isAfter: (link: typeof links[number], cursor: typeof after) => link.normalizedValue.localeCompare(cursor.normalizedValue) > 0 || (link.normalizedValue === cursor.normalizedValue && familyKey(link).localeCompare(cursor.familyKey) > 0),
      limit: 26,
      filter: (link: typeof links[number]) => link.businessId === "shop-a",
      visible: (link: typeof links[number]) => link.status === "approved",
      compare: (left: typeof links[number], right: typeof links[number]) => left.normalizedValue.localeCompare(right.normalizedValue) || familyKey(left).localeCompare(familyKey(right)),
      collapseBy: familyKey,
      versionOf: (link: typeof links[number]) => link.version,
    };
    const current = await storage.read!((transaction) => transaction.scanPage!("identity-links", { ...options, physical: { kind: "identity-links", businessId: "shop-a", mode: "current" } }));
    const authoritative = await storage.read!((transaction) => transaction.scanPage!("identity-links", { ...options, baseItems: [{ ...links[500]!, targetProductId: "configured-ignored" }], physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" } }));
    expect(current.items.map((link) => link.normalizedValue)).toEqual(Array.from({ length: 26 }, (_, index) => String(index + 500).padStart(3, "0")));
    expect(authoritative.items[0]).toMatchObject({ normalizedValue: "500", targetProductId: "durable-500" });
    expect(reads.some((read) => read.filePath.endsWith(".state.json"))).toBe(false);
    expect(reads.filter((read) => read.filePath.endsWith(".exact.data.json")).reduce((total, read) => total + read.records, 0)).toBeLessThanOrEqual(26);
  });

  it("merges configured links after a cursor with durable tombstones through bounded hash probes", async () => {
    const root = testRoot();
    const configured = Array.from({ length: 550 }, (_, index) => {
      const value = String(index).padStart(3, "0");
      return { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: value, targetProductId: `configured-${value}`, status: "approved", version: 1 };
    });
    const durable = configured.map((link) => ({ ...link, targetProductId: `durable-${link.normalizedValue}`, version: 2 }));
    durable[500] = { ...durable[500]!, status: "revoked" };
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", durable));
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const probes: number[] = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); }, observeSeek: (probe) => { probes.push(probe.pageNumber); } } });
    const familyKey = (link: typeof configured[number]) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);
    const after = { normalizedValue: "499", familyKey: familyKey(configured[499]!) };

    const page = await storage.read!((transaction) => transaction.scanPage!("identity-links", {
      after, limit: 26, baseItems: configured,
      isAfter: (link: typeof configured[number], cursor: typeof after) => link.normalizedValue > cursor.normalizedValue || (link.normalizedValue === cursor.normalizedValue && familyKey(link) > cursor.familyKey),
      filter: (link: typeof configured[number]) => link.businessId === "shop-a", visible: (link) => link.status === "approved",
      compare: (left, right) => left.normalizedValue < right.normalizedValue ? -1 : left.normalizedValue > right.normalizedValue ? 1 : familyKey(left) < familyKey(right) ? -1 : familyKey(left) > familyKey(right) ? 1 : 0,
      collapseBy: familyKey, versionOf: (link) => link.version,
      physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" },
    }));

    expect(page.items.map((link: typeof configured[number]) => link.normalizedValue)).toEqual(Array.from({ length: 26 }, (_, index) => String(index + 501).padStart(3, "0")));
    expect(page.origins).toEqual(Array.from({ length: 26 }, () => "stored"));
    expect(reads.some((read) => read.filePath.endsWith(".state.json"))).toBe(false);
    expect(reads.filter((read) => read.filePath.includes("exact.data"))).toHaveLength(0);
    expect(probes.length).toBeLessThanOrEqual(6);
  });

  it("applies an authoritative offset after interleaving configured and durable links", async () => {
    const root = testRoot();
    const configured = ["001", "003", "005", "007"].map((normalizedValue) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "configured", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue, targetProductId: `configured-${normalizedValue}`, status: "approved", version: 1 }));
    const durable = ["000", "002", "004", "006", "008"].map((normalizedValue) => ({ ...configured[0]!, vendorId: "durable", normalizedValue, targetProductId: `durable-${normalizedValue}` }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", durable));
    const family = (link: typeof configured[number]) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);

    const page = await createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", {
      offset: 3, limit: 3, baseItems: configured,
      filter: (link: typeof configured[number]) => link.businessId === "shop-a", visible: (link) => link.status === "approved",
      compare: (left, right) => left.normalizedValue < right.normalizedValue ? -1 : left.normalizedValue > right.normalizedValue ? 1 : family(left) < family(right) ? -1 : 1,
      collapseBy: family, versionOf: (link) => link.version,
      physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" },
    }));

    expect(page.items.map((link) => link.normalizedValue)).toEqual(["003", "004", "005"]);
    expect(page.origins).toEqual(["base", "stored", "base"]);
    expect(page.total).toBe(9);
  });

  it("continues through more than one lookahead page of tombstones before returning later durable approvals", async () => {
    const root = testRoot();
    const configured = Array.from({ length: 70 }, (_, index) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: String(index).padStart(3, "0"), targetProductId: `configured-${index}`, status: "approved", version: 1 }));
    const durable = configured.map((link, index) => ({ ...link, targetProductId: `durable-${index}`, status: index < 55 ? "revoked" : "approved", version: 2 }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", durable));
    const family = (link: typeof configured[number]) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);
    const seeks: number[] = [];
    const storage = createFileAtomicLocalStorage({ root, io: { observeSeek: ({ pageNumber }) => { seeks.push(pageNumber); } } });
    const after = { normalizedValue: "-1", familyKey: "" };

    const page = await storage.read!((transaction) => transaction.scanPage!("identity-links", {
      after, isAfter: (link: typeof configured[number], cursor: typeof after) => link.normalizedValue > cursor.normalizedValue || (link.normalizedValue === cursor.normalizedValue && family(link) > cursor.familyKey),
      limit: 6, baseItems: configured, filter: (link: typeof configured[number]) => link.businessId === "shop-a", visible: (link) => link.status === "approved",
      compare: (left, right) => left.normalizedValue < right.normalizedValue ? -1 : left.normalizedValue > right.normalizedValue ? 1 : 0,
      collapseBy: family, versionOf: (link) => link.version,
      physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" },
    }));

    expect(page.items.map((link) => link.normalizedValue)).toEqual(["055", "056", "057", "058", "059", "060"]);
    expect(page.origins).toEqual(["stored", "stored", "stored", "stored", "stored", "stored"]);
    expect(page.total).toBe(15);
    expect(seeks.length).toBeGreaterThan(0);
    expect(seeks.length).toBeLessThanOrEqual(6);
  });

  it("reports the same exact authoritative total on every page", async () => {
    const root = testRoot();
    const configured = ["001", "002", "003", "004"].map((normalizedValue) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue, targetProductId: `configured-${normalizedValue}`, status: normalizedValue === "004" ? "revoked" : "approved", version: 1 }));
    const durable = [{ ...configured[1]!, status: "revoked", version: 2 }, { ...configured[2]!, targetProductId: "durable-003", status: "approved", version: 2 }, { ...configured[0]!, normalizedValue: "005", targetProductId: "durable-005", status: "approved", version: 2 }];
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", durable));
    const family = (link: typeof configured[number]) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);
    const options = { limit: 2, baseItems: configured, filter: (link: typeof configured[number]) => link.businessId === "shop-a", visible: (link: typeof configured[number]) => link.status === "approved", compare: (left: typeof configured[number], right: typeof configured[number]) => left.normalizedValue < right.normalizedValue ? -1 : left.normalizedValue > right.normalizedValue ? 1 : 0, collapseBy: family, versionOf: (link: typeof configured[number]) => link.version, physical: { kind: "identity-links" as const, businessId: "shop-a", mode: "authoritative" as const } };
    const storage = createFileAtomicLocalStorage({ root });
    const first = await storage.read!((transaction) => transaction.scanPage!("identity-links", options));
    const after = { normalizedValue: first.items[1]!.normalizedValue, familyKey: family(first.items[1]!) };
    const second = await storage.read!((transaction) => transaction.scanPage!("identity-links", { ...options, after, isAfter: (link, cursor) => link.normalizedValue > cursor.normalizedValue || (link.normalizedValue === cursor.normalizedValue && family(link) > cursor.familyKey) }));

    expect(first.items.map((link) => link.normalizedValue)).toEqual(["001", "003"]);
    expect(second.items.map((link) => link.normalizedValue)).toEqual(["005"]);
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
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
    expect(reads.some((read) => read.filePath.endsWith(".exact.data.json"))).toBe(false);
    expect(reads.filter((read) => read.filePath.includes(".approved.") && !read.filePath.includes(".summary.")).length).toBe(1);
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

  it("serializes two adapters addressed to the same configured directory", async () => {
    const root = testRoot();
    const first = createFileAtomicLocalStorage({ root });
    const second = createFileAtomicLocalStorage({ root });
    await Promise.all([
      first.transaction((transaction) => transaction.set("first", true)),
      second.transaction((transaction) => transaction.set("second", true)),
    ]);

    await expect(first.transaction(async (transaction) => [await transaction.get("first"), await transaction.get("second")])).resolves.toEqual([true, true]);
  });

  it.skipIf(process.platform !== "win32")("serializes two adapters addressed through Windows case aliases", async () => {
    const root = testRoot();
    const caseAlias = path.join(storageBase, path.basename(root).toUpperCase());
    expect(caseAlias).not.toBe(root);

    const first = createFileAtomicLocalStorage({ root });
    const second = createFileAtomicLocalStorage({ root: caseAlias });
    await Promise.all([
      first.transaction((transaction) => transaction.set("first", true)),
      second.transaction((transaction) => transaction.set("second", true)),
    ]);

    await expect(first.transaction(async (transaction) => [await transaction.get("first"), await transaction.get("second")])).resolves.toEqual([true, true]);
  });

  it.skipIf(process.platform === "win32")("keeps POSIX case-distinct configured directories isolated", async () => {
    const lowerRoot = testRoot();
    const upperRoot = path.join(storageBase, path.basename(lowerRoot).toUpperCase());
    ownedRoots.push(upperRoot);
    expect(upperRoot).not.toBe(lowerRoot);

    const lower = createFileAtomicLocalStorage({ root: lowerRoot });
    const upper = createFileAtomicLocalStorage({ root: upperRoot });
    await Promise.all([
      lower.transaction((transaction) => transaction.set("lower", true)),
      upper.transaction((transaction) => transaction.set("upper", true)),
    ]);

    await expect(lower.transaction(async (transaction) => [await transaction.get("lower"), await transaction.get("upper")])).resolves.toEqual([true, undefined]);
    await expect(upper.transaction(async (transaction) => [await transaction.get("lower"), await transaction.get("upper")])).resolves.toEqual([undefined, true]);
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
      schemaVersion: 3,
      mergeAlgorithmVersion: "identity-links-merge-v1",
      orderAlgorithmVersion: "identity-links-order-v1",
      businessId: "shop-a",
    });
  });

  it("keeps the prior five-field exact-family index readable for exact lookup", async () => {
    const root = testRoot();
    const link = { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: "001", targetProductId: "tire-001", status: "approved", version: 1 };
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", [link]));
    const indexName = (await readdir(root)).find((name) => name.includes(".links.") && name.endsWith(".exact.index.json"));
    const indexPath = path.join(root, indexName!);
    const current = JSON.parse(await readFile(indexPath, "utf8"));
    const descriptorName = (await readdir(root)).find((name) => name.includes(".exact.descriptor.0.json"));
    const descriptors = JSON.parse(await readFile(path.join(root, descriptorName!), "utf8")).items as Array<[string, string, string, string, number, number]>;
    await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, mergeAlgorithmVersion: current.mergeAlgorithmVersion, orderAlgorithmVersion: current.orderAlgorithmVersion, businessId: current.businessId, entries: descriptors.map((entry) => [entry[0], entry[2], entry[3], entry[4], entry[5]]) }), "utf8");
    const family = JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);
    const found = await createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, filter: (item: typeof link) => item.businessId === "shop-a", visible: () => true, compare: (left, right) => left.normalizedValue < right.normalizedValue ? -1 : left.normalizedValue > right.normalizedValue ? 1 : 0, collapseBy: () => family, versionOf: (item) => item.version, physical: { kind: "identity-links", businessId: "shop-a", mode: "families", families: [family] } }));
    expect(found.items).toEqual([link]);
  });

  it.each([1, 2] as const)("uses ordered durable pages for schema-v%s authoritative reads without loading state", async (schemaVersion) => {
    const root = testRoot();
    const configured = { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: "001", targetProductId: "configured", status: "approved", version: 1 };
    const durable = { ...configured, targetProductId: "durable", version: 2 };
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", [durable]));
    const indexName = (await readdir(root)).find((name) => name.includes(".exact.index.json"));
    const indexPath = path.join(root, indexName!);
    const current = JSON.parse(await readFile(indexPath, "utf8"));
    const descriptorName = (await readdir(root)).find((name) => name.includes(".exact.descriptor.0.json"));
    const descriptor = JSON.parse(await readFile(path.join(root, descriptorName!), "utf8")).items[0] as [string, string, string, string, number, number];
    await writeFile(indexPath, JSON.stringify({ schemaVersion, mergeAlgorithmVersion: current.mergeAlgorithmVersion, orderAlgorithmVersion: current.orderAlgorithmVersion, businessId: current.businessId, entries: schemaVersion === 1 ? [[descriptor[0], descriptor[2], descriptor[3], descriptor[4], descriptor[5]]] : [descriptor] }), "utf8");
    const generatedNames = await readdir(root);
    const mergeSummaryName = generatedNames.find((name) => name.includes(".exact.merge-summary.json"));
    await rm(path.join(root, mergeSummaryName!));
    await Promise.all(generatedNames.filter((name) => name.includes(".exact.descriptor.") || name.includes(".exact.merge-membership.") || name.includes(".exact.merge-directory.")).map((name) => rm(path.join(root, name))));
    await Promise.all(generatedNames.filter((name) => name.includes(".links.") && name.endsWith(".summary.json") && !name.includes(".exact.")).map(async (name) => {
      const summaryPath = path.join(root, name), summary = JSON.parse(await readFile(summaryPath, "utf8"));
      summary.schemaVersion = 2;
      for (const directory of Object.values(summary.directories) as Array<Array<Record<string, unknown>>>) for (const boundary of directory) delete boundary.fingerprint;
      await writeFile(summaryPath, JSON.stringify(summary), "utf8");
    }));
    const reads: Array<{ filePath: string; bytes: number; records: number }> = [];
    const family = (link: typeof configured) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);

    const page = await createFileAtomicLocalStorage({ root, io: { observeRead: (read) => { reads.push(read); } } }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, baseItems: [configured], filter: (link: typeof configured) => link.businessId === "shop-a", visible: (link) => link.status === "approved", compare: () => 0, collapseBy: family, versionOf: (link) => link.version, physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" } }));

    expect(page.items).toEqual([durable]);
    expect(reads.some((read) => read.filePath.endsWith(".state.json"))).toBe(false);
  });

  it("rejects a legacy index mixed with unsigned v3 descriptor pages", async () => {
    const root = testRoot();
    const link = { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: "001", targetProductId: "durable", status: "approved", version: 2 };
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", [link]));
    const names = await readdir(root), indexName = names.find((name) => name.includes(".exact.index.json")), descriptorName = names.find((name) => name.includes(".exact.descriptor.0.json")), mergeSummaryName = names.find((name) => name.includes(".exact.merge-summary.json"));
    const indexPath = path.join(root, indexName!), current = JSON.parse(await readFile(indexPath, "utf8"));
    const descriptor = JSON.parse(await readFile(path.join(root, descriptorName!), "utf8")).items[0] as [string, string, string, string, number, number];
    await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, mergeAlgorithmVersion: current.mergeAlgorithmVersion, orderAlgorithmVersion: current.orderAlgorithmVersion, businessId: current.businessId, entries: [[descriptor[0], descriptor[2], descriptor[3], descriptor[4], descriptor[5]]] }), "utf8");
    await rm(path.join(root, mergeSummaryName!));
    await Promise.all(names.filter((name) => name.includes(".exact.merge-membership.") || name.includes(".exact.merge-directory.")).map((name) => rm(path.join(root, name))));
    const family = (item: typeof link) => JSON.stringify([item.businessId, item.sourceSystem, item.vendorId, item.sourceSignature, item.identifierType, item.namespace, item.normalizedValue]);

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, baseItems: [link], filter: () => true, visible: () => true, compare: () => 0, collapseBy: family, versionOf: (item) => item.version, physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" } }))).rejects.toThrow("identity_storage_corrupt");
  });

  it("pages authoritative membership directories beyond the old 7500-family cap", async () => {
    const root = testRoot();
    const configured = Array.from({ length: 8_050 }, (_, index) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: `source-signature-${"x".repeat(32)}`, identifierType: "upc", namespace: "", normalizedValue: String(index).padStart(4, "0"), targetProductId: `configured-${index}`, status: "approved", version: 1 }));
    const durable = configured.map((link, index) => ({ ...link, targetProductId: `durable-${index}`, status: index < 4_000 ? "revoked" : "approved", version: 2 }));
    await expect(createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", durable))).resolves.toBeUndefined();
    const names = await readdir(root);
    const membershipPages = names.filter((name) => name.includes(".exact.merge-membership.") && !name.includes(".summary."));
    const directoryPages = names.filter((name) => name.includes(".exact.merge-directory."));
    expect(membershipPages.length).toBeGreaterThan(1);
    expect(directoryPages.length).toBeGreaterThan(1);
    const family = (link: typeof configured[number]) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);
    const after = { normalizedValue: "8039", familyKey: family(configured[8039]!) };
    const page = await createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { after, isAfter: (link: typeof configured[number], cursor: typeof after) => link.normalizedValue > cursor.normalizedValue || (link.normalizedValue === cursor.normalizedValue && family(link) > cursor.familyKey), limit: 3, baseItems: configured, filter: (link: typeof configured[number]) => link.businessId === "shop-a", visible: (link) => link.status === "approved", compare: (left, right) => left.normalizedValue < right.normalizedValue ? -1 : left.normalizedValue > right.normalizedValue ? 1 : 0, collapseBy: family, versionOf: (link) => link.version, physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" } }));

    expect(page.items.map((link) => link.normalizedValue)).toEqual(["8040", "8041", "8042"]);
    expect(page.total).toBe(4_050);
  });

  it.each(["missing", "tampered"] as const)("fails closed when a merge directory page is %s", async (failure) => {
    const root = testRoot();
    const links = Array.from({ length: 700 }, (_, index) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: String(index).padStart(3, "0"), targetProductId: `tire-${index}`, status: "approved", version: 1 }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", links));
    const directoryName = (await readdir(root)).find((name) => name.includes(".exact.merge-directory.0.json")), directoryPath = path.join(root, directoryName!);
    if (failure === "missing") await rm(directoryPath);
    else { const body = JSON.parse(await readFile(directoryPath, "utf8")); body.items[0][2] = "0".repeat(64); await writeFile(directoryPath, JSON.stringify(body), "utf8"); }
    const family = (link: typeof links[number]) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);
    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, baseItems: links, filter: () => true, visible: () => true, compare: () => 0, collapseBy: family, versionOf: (link) => link.version, physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" } }))).rejects.toThrow("identity_storage_corrupt");
  });

  it.each(["missing", "tampered"] as const)("fails closed when an authoritative membership page is %s", async (failure) => {
    const root = testRoot();
    const configured = Array.from({ length: 30 }, (_, index) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: String(index).padStart(3, "0"), targetProductId: `configured-${index}`, status: "approved", version: 1 }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", configured));
    const membershipName = (await readdir(root)).find((name) => name.includes(".exact.merge-membership.0.json"));
    const membershipPath = path.join(root, membershipName!);
    if (failure === "missing") await rm(membershipPath);
    else { const body = JSON.parse(await readFile(membershipPath, "utf8")); body.items[0][2] = "revoked"; await writeFile(membershipPath, JSON.stringify(body), "utf8"); }
    const family = (link: typeof configured[number]) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, baseItems: configured, filter: () => true, visible: (link: typeof configured[number]) => link.status === "approved", compare: () => 0, collapseBy: family, versionOf: (link) => link.version, physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" } }))).rejects.toThrow("identity_storage_corrupt");
  });

  it("fails closed when current-page metadata is missing beside exact artifacts", async () => {
    const root = testRoot();
    const link = { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: "001", targetProductId: "tire-001", status: "approved", version: 1 };
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", [link]));
    const currentSummaryName = (await readdir(root)).find((name) => name.includes(".links.") && name.endsWith(".summary.json") && !name.includes(".approved.") && !name.includes(".merge-summary."));
    await rm(path.join(root, currentSummaryName!));
    const family = (item: typeof link) => JSON.stringify([item.businessId, item.sourceSystem, item.vendorId, item.sourceSignature, item.identifierType, item.namespace, item.normalizedValue]);

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, baseItems: [link], filter: () => true, visible: () => true, compare: () => 0, collapseBy: family, versionOf: (item) => item.version, physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" } }))).rejects.toThrow("identity_storage_corrupt");
  });

  it("rejects an approved-summary total corruption that keeps the same page count", async () => {
    const root = testRoot();
    const links = Array.from({ length: 30 }, (_, index) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: String(index).padStart(3, "0"), targetProductId: `tire-${index}`, status: "approved", version: 1 }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", links));
    const approvedName = (await readdir(root)).find((name) => name.includes(".approved.summary.json")), approvedPath = path.join(root, approvedName!), summary = JSON.parse(await readFile(approvedPath, "utf8"));
    summary.total = 29;
    await writeFile(approvedPath, JSON.stringify(summary), "utf8");

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, baseItems: [], filter: () => true, visible: () => true, compare: () => 0, physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" } }))).rejects.toThrow("identity_storage_corrupt");
  });

  it.each(["current-target", "approved-status"] as const)("fingerprint-checks a middle link page after %s tampering", async (failure) => {
    const root = testRoot();
    const links = Array.from({ length: 75 }, (_, index) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: String(index).padStart(3, "0"), targetProductId: `tire-${index}`, status: "approved", version: 1 }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", links));
    const pageName = (await readdir(root)).find((name) => failure === "current-target" ? name.includes(".links.") && name.endsWith(".1.json") && !name.includes(".approved.") && !name.includes(".exact.") : name.includes(".approved.1.json"));
    const pagePath = path.join(root, pageName!), page = JSON.parse(await readFile(pagePath, "utf8"));
    if (failure === "current-target") page.items[5].targetProductId = "tampered";
    else page.items[5].status = "revoked";
    await writeFile(pagePath, JSON.stringify(page), "utf8");
    const family = (link: typeof links[number]) => JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);
    const after = { normalizedValue: "024", familyKey: family(links[24]!) };
    const baseItems = failure === "current-target" ? links : [];

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { after, isAfter: (link: typeof links[number], cursor: typeof after) => link.normalizedValue > cursor.normalizedValue, limit: 10, baseItems, filter: () => true, visible: (link) => link.status === "approved", compare: () => 0, collapseBy: family, versionOf: (link) => link.version, physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" } }))).rejects.toThrow("identity_storage_corrupt");
  });

  it("validates tenant artifact coherence before an empty-base authoritative read", async () => {
    const root = testRoot();
    const link = { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: "001", targetProductId: "tire-001", status: "approved", version: 1 };
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", [link]));
    const exactName = (await readdir(root)).find((name) => name.includes(".exact.index.json"));
    await rm(path.join(root, exactName!));

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, baseItems: [], filter: () => true, visible: () => true, compare: () => 0, physical: { kind: "identity-links", businessId: "shop-a", mode: "authoritative" } }))).rejects.toThrow("identity_storage_corrupt");
  });

  it.each(["within", "across"] as const)("rejects duplicate family hashes %s v3 descriptor pages", async (position) => {
    const root = testRoot();
    const links = Array.from({ length: 30 }, (_, index) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: String(index).padStart(3, "0"), targetProductId: `tire-${index}`, status: "approved", version: 1 }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", links));
    const names = await readdir(root), descriptorNames = names.filter((name) => name.includes(".exact.descriptor.")).sort(), firstPath = path.join(root, descriptorNames[0]!);
    const first = JSON.parse(await readFile(firstPath, "utf8"));
    let requestedFamily = first.items[0][1] as string;
    if (position === "within") { first.items[1][0] = first.items[0][0]; await writeFile(firstPath, JSON.stringify(first), "utf8"); }
    else {
      const secondPath = path.join(root, descriptorNames[1]!), second = JSON.parse(await readFile(secondPath, "utf8"));
      second.items[0][0] = first.items.at(-1)[0]; requestedFamily = second.items[0][1] as string;
      await writeFile(secondPath, JSON.stringify(second), "utf8");
      const indexName = names.find((name) => name.includes(".exact.index.json")), indexPath = path.join(root, indexName!), index = JSON.parse(await readFile(indexPath, "utf8"));
      index.descriptorDirectory[1].first[0] = second.items[0][0];
      await writeFile(indexPath, JSON.stringify(index), "utf8");
    }

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, filter: () => true, visible: () => true, compare: () => 0, collapseBy: () => requestedFamily, versionOf: () => 1, physical: { kind: "identity-links", businessId: "shop-a", mode: "families", families: [requestedFamily] } }))).rejects.toThrow("identity_storage_corrupt");
  });

  it("fails closed when a legacy exact index contains two entries for one requested hash", async () => {
    const root = testRoot();
    const links = ["001", "002"].map((normalizedValue) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue, targetProductId: `tire-${normalizedValue}`, status: "approved", version: 1 }));
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", links));
    const indexName = (await readdir(root)).find((name) => name.includes(".exact.index.json"));
    const indexPath = path.join(root, indexName!);
    const current = JSON.parse(await readFile(indexPath, "utf8"));
    const descriptorNames = (await readdir(root)).filter((name) => name.includes(".exact.descriptor."));
    const descriptors = (await Promise.all(descriptorNames.map(async (name) => JSON.parse(await readFile(path.join(root, name), "utf8")).items as Array<[string, string, string, string, number, number]>))).flat();
    descriptors[1]![0] = descriptors[0]![0];
    await writeFile(indexPath, JSON.stringify({ schemaVersion: 2, mergeAlgorithmVersion: current.mergeAlgorithmVersion, orderAlgorithmVersion: current.orderAlgorithmVersion, businessId: current.businessId, entries: descriptors }), "utf8");
    const family = JSON.stringify([links[0]!.businessId, links[0]!.sourceSystem, links[0]!.vendorId, links[0]!.sourceSignature, links[0]!.identifierType, links[0]!.namespace, links[0]!.normalizedValue]);

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, filter: () => true, visible: () => true, compare: () => 0, collapseBy: () => family, versionOf: () => 1, physical: { kind: "identity-links", businessId: "shop-a", mode: "families", families: [family] } }))).rejects.toThrow("identity_storage_corrupt");
  });

  it("fails closed when a v3 exact descriptor disagrees with its payload", async () => {
    const root = testRoot();
    const link = { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: "001", targetProductId: "tire-001", status: "approved", version: 1 };
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", [link]));
    const descriptorName = (await readdir(root)).find((name) => name.includes(".exact.descriptor.0.json"));
    const descriptorPath = path.join(root, descriptorName!);
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.items[0][3] = "wrong-value";
    await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
    const family = JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]);

    await expect(createFileAtomicLocalStorage({ root }).read!((transaction) => transaction.scanPage!("identity-links", { limit: 1, filter: (item: typeof link) => item.businessId === "shop-a", visible: () => true, compare: () => 0, collapseBy: () => family, versionOf: (item) => item.version, physical: { kind: "identity-links", businessId: "shop-a", mode: "families", families: [family] } }))).rejects.toThrow("identity_storage_corrupt");
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
