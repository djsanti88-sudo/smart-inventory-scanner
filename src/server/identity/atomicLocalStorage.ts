import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

type StoredValue = null | boolean | number | string | StoredValue[] | { [key: string]: StoredValue };
type StoredRecord = Record<string, StoredValue>;
interface StoredEnvelope { version: 1; values: StoredRecord }

export interface AtomicTransaction { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<void> }
export interface AtomicLocalStorage { transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> }

const rootMutexes = new Map<string, Promise<void>>();
const schemaVersion = 1;

function clone<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T; }
function plainRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function storageRoot(): string { return path.resolve(process.cwd(), ".tmp", "identity-import"); }
function mutexKey(root: string): string { return path.normalize(root).toLocaleLowerCase("en-US"); }
function corrupt(): Error { return new Error("identity_storage_corrupt"); }

function assertPhysicalRoot(root: string): string {
  const base = storageRoot();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== base || !path.basename(resolved)) throw new Error(`Local identity storage root must be a direct child of ${base}`);
  const baseStat = lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error("identity-import base is a reparse or symlink path");
  const canonicalBase = realpathSync(base);
  if (path.normalize(path.dirname(resolved)).toLocaleLowerCase("en-US") !== path.normalize(canonicalBase).toLocaleLowerCase("en-US")) throw new Error("identity-import root escaped approved base");
  try {
    const child = lstatSync(resolved);
    if (!child.isDirectory() || child.isSymbolicLink()) throw new Error("identity-import child is a reparse or symlink path");
    if (path.dirname(realpathSync(resolved)).toLocaleLowerCase("en-US") !== canonicalBase.toLocaleLowerCase("en-US")) throw new Error("identity-import child escaped approved base");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolved;
}

async function recheckPhysicalRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const base = await realpath(storageRoot());
  const child = await realpath(root);
  const lowerBase = path.normalize(base).toLocaleLowerCase("en-US");
  if (path.dirname(child).toLocaleLowerCase("en-US") !== lowerBase) throw new Error("identity-import child escaped approved base");
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("identity-import child is a reparse or symlink path");
}

async function withMutex<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = mutexKey(root), previous = rootMutexes.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current); rootMutexes.set(key, queued); await previous;
  try { return await action(); } finally { release(); if (rootMutexes.get(key) === queued) rootMutexes.delete(key); }
}

class MapTransaction implements AtomicTransaction {
  private dirty = false;
  constructor(private readonly values: StoredRecord) {}
  async get<T>(key: string): Promise<T | undefined> { return clone(this.values[key]) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.values[key] = clone(value) as StoredValue; this.dirty = true; }
  async delete(key: string): Promise<void> { if (key in this.values) { delete this.values[key]; this.dirty = true; } }
  get changed(): boolean { return this.dirty; }
}

function parseEnvelope(input: string): StoredRecord {
  let parsed: unknown; try { parsed = JSON.parse(input); } catch { throw corrupt(); }
  if (!plainRecord(parsed) || parsed.version !== schemaVersion || !plainRecord(parsed.values)) throw corrupt();
  return parsed.values as StoredRecord;
}
async function syncFile(filePath: string, body: string): Promise<void> { const handle = await open(filePath, "w"); try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); } }
async function syncDirectory(directory: string): Promise<void> { try { const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } } catch { /* Windows/filesystems may not support directory fsync. */ } }

export function createMemoryAtomicLocalStorage(): AtomicLocalStorage {
  let values: StoredRecord = {}, mutex = Promise.resolve();
  return { async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> { const previous = mutex; let release: () => void = () => {}; mutex = new Promise<void>((resolve) => { release = resolve; }); await previous; try { const working = clone(values); const transaction = new MapTransaction(working); const result = await fn(transaction); if (transaction.changed) values = working; return result; } finally { release(); } } };
}

export function createFileAtomicLocalStorage({ root }: { root: string }): AtomicLocalStorage {
  const safeRoot = assertPhysicalRoot(root), statePath = path.join(safeRoot, "identity-local-storage.json");
  return { async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> { return withMutex(safeRoot, async () => { await recheckPhysicalRoot(safeRoot); let values: StoredRecord = {}; try { values = parseEnvelope(await readFile(statePath, "utf8")); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const transaction = new MapTransaction(values), result = await fn(transaction);
    if (transaction.changed) { await recheckPhysicalRoot(safeRoot); const temp = path.join(safeRoot, `identity-local-storage.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`); await syncFile(temp, JSON.stringify({ version: schemaVersion, values } satisfies StoredEnvelope)); await rename(temp, statePath); await syncDirectory(safeRoot); }
    return result; }); } };
}
