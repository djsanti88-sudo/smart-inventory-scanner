import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type StoredValue = null | boolean | number | string | StoredValue[] | { [key: string]: StoredValue };
type StoredRecord = Record<string, StoredValue>;

export interface AtomicTransaction {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AtomicLocalStorage {
  transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T>;
}

const rootMutexes = new Map<string, Promise<void>>();

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function storageRoot(): string {
  return path.resolve(process.cwd(), ".tmp", "identity-import");
}

function assertSafeRoot(root: string): string {
  const resolvedRoot = path.resolve(root);
  const approvedBase = storageRoot();
  if (path.dirname(resolvedRoot) !== approvedBase || !path.basename(resolvedRoot)) {
    throw new Error(`Local identity storage root must be a direct child of ${approvedBase}`);
  }
  return resolvedRoot;
}

async function withMutex<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = rootMutexes.get(root) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  rootMutexes.set(root, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (rootMutexes.get(root) === queued) rootMutexes.delete(root);
  }
}

class MapTransaction implements AtomicTransaction {
  private dirty = false;

  constructor(private readonly values: StoredRecord) {}

  async get<T>(key: string): Promise<T | undefined> {
    return clone(this.values[key]) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values[key] = clone(value) as StoredValue;
    this.dirty = true;
  }

  async delete(key: string): Promise<void> {
    if (key in this.values) {
      delete this.values[key];
      this.dirty = true;
    }
  }

  get changed(): boolean {
    return this.dirty;
  }
}

export function createMemoryAtomicLocalStorage(): AtomicLocalStorage {
  const values: StoredRecord = {};
  let mutex = Promise.resolve();
  return {
    async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> {
      const previous = mutex;
      let release: () => void = () => undefined;
      mutex = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(new MapTransaction(values));
      } finally {
        release();
      }
    },
  };
}

export function createFileAtomicLocalStorage({ root }: { root: string }): AtomicLocalStorage {
  const safeRoot = assertSafeRoot(root);
  const statePath = path.join(safeRoot, "identity-local-storage.json");

  return {
    async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> {
      return withMutex(safeRoot, async () => {
        await mkdir(safeRoot, { recursive: true });
        let values: StoredRecord = {};
        try {
          values = JSON.parse(await readFile(statePath, "utf8")) as StoredRecord;
        } catch (error: unknown) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        }
        const transaction = new MapTransaction(values);
        const result = await fn(transaction);
        if (transaction.changed) {
          const tempPath = path.join(safeRoot, `identity-local-storage.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
          await writeFile(tempPath, JSON.stringify(values), "utf8");
          await rename(tempPath, statePath);
        }
        return result;
      });
    },
  };
}
