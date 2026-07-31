import { constants, lstatSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
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

type FileStorageHooks = { writeTemp?: (filePath: string, body: string) => Promise<void>; replace?: (tempPath: string, statePath: string) => Promise<void>; syncDirectory?: (directory: string) => Promise<void> };

function assertConfiguredRoot(root: string): string {
  const base = storageRoot();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== base || !path.basename(resolved)) throw new Error(`Local identity storage root must be a direct child of ${base}`);
  for (const directory of [path.dirname(base), base, resolved]) {
    try { const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("identity-import path is a reparse or symlink path"); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return resolved;
}

async function ensureDirectory(directory: string): Promise<void> {
  try { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("identity-import path is a reparse or symlink path"); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(directory); }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("identity-import path is a reparse or symlink path");
}

async function recheckPhysicalRoot(root: string): Promise<void> {
  const configuredBase = storageRoot();
  await ensureDirectory(path.dirname(configuredBase));
  await ensureDirectory(configuredBase);
  await ensureDirectory(root);
  const base = await realpath(configuredBase);
  const child = await realpath(root);
  const lowerBase = path.normalize(base).toLocaleLowerCase("en-US");
  if (path.dirname(child).toLocaleLowerCase("en-US") !== lowerBase) throw new Error("identity-import child escaped approved base");
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("identity-import child is a reparse or symlink path");
}

async function assertStateFile(statePath: string): Promise<void> {
  try {
    const stat = await lstat(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("identity-local-storage state is a reparse or symlink path");
  } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
async function syncFile(filePath: string, body: string): Promise<void> { const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); } }
async function readState(statePath: string): Promise<StoredRecord> {
  await assertStateFile(statePath);
  let handle;
  try { handle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  try { return parseEnvelope(await handle.readFile({ encoding: "utf8" })); } finally { await handle.close(); }
}
const directorySyncUnsupportedCodes = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EISDIR"]);
async function syncDirectory(directory: string): Promise<void> {
  try { const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error: unknown) {
    if (directorySyncUnsupportedCodes.has((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

export function createMemoryAtomicLocalStorage(): AtomicLocalStorage {
  let values: StoredRecord = {}, mutex = Promise.resolve();
  return { async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> { const previous = mutex; let release: () => void = () => {}; mutex = new Promise<void>((resolve) => { release = resolve; }); await previous; try { const working = clone(values); const transaction = new MapTransaction(working); const result = await fn(transaction); if (transaction.changed) values = working; return result; } finally { release(); } } };
}

export function createFileAtomicLocalStorage({ root, io = {} }: { root: string; io?: FileStorageHooks }): AtomicLocalStorage {
  const safeRoot = assertConfiguredRoot(root), statePath = path.join(safeRoot, "identity-local-storage.json");
  return { async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> { return withMutex(safeRoot, async () => { await recheckPhysicalRoot(safeRoot); const values = await readState(statePath);
    const transaction = new MapTransaction(values), result = await fn(transaction);
    if (transaction.changed) { await recheckPhysicalRoot(safeRoot); await assertStateFile(statePath); const temp = path.join(safeRoot, `identity-local-storage.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`); try { await (io.writeTemp ?? syncFile)(temp, JSON.stringify({ version: schemaVersion, values } satisfies StoredEnvelope)); await (io.replace ?? rename)(temp, statePath); await (io.syncDirectory ?? syncDirectory)(safeRoot); } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; } }
    return result; }); } };
}
