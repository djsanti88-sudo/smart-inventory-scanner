import { randomUUID } from "node:crypto";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
});
