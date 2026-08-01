import { constants, lstatSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

type StoredValue = null | boolean | number | string | StoredValue[] | { [key: string]: StoredValue };
type StoredRecord = Record<string, StoredValue>;
interface StoredEnvelope { version: 1; values: StoredRecord }

export type AtomicPageOptions<T> = {
  offset: number;
  limit: number;
  filter?: (item: T) => boolean;
  visible?: (item: T) => boolean;
  compare: (left: T, right: T) => number;
  groupBy?: (item: T) => string;
  collapseBy?: (item: T) => string;
  versionOf?: (item: T) => number;
  baseItems?: readonly T[];
};
export type AtomicPage<T> = { items: T[]; origins: Array<"base" | "stored">; total: number; groupTotals: Record<string, number> };
export interface AtomicTransaction { get<T>(key: string): Promise<T | undefined>; scanPage?<T>(key: string, options: AtomicPageOptions<T>): Promise<AtomicPage<T>>; set<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<void> }
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
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; try { await mkdir(directory); } catch (mkdirError: unknown) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; } }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("identity-import path is a reparse or symlink path");
}

async function recheckPhysicalRoot(root: string): Promise<string> {
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
  return child;
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
  private working: StoredRecord | undefined;
  constructor(private readonly initial: StoredRecord) {}
  private get values(): StoredRecord { return this.working ?? this.initial; }
  private writable(): StoredRecord { if (!this.working) this.working = clone(this.initial); return this.working; }
  async get<T>(key: string): Promise<T | undefined> { return clone(this.values[key]) as T | undefined; }
  async scanPage<T>(key: string, options: AtomicPageOptions<T>): Promise<AtomicPage<T>> {
    if (!Number.isSafeInteger(options.offset) || options.offset < 0 || !Number.isSafeInteger(options.limit) || options.limit <= 0 || options.limit > 1_000) throw new Error("atomic page bounds are invalid");
    const stored = Array.isArray(this.values[key]) ? this.values[key] as T[] : [];
    type PageEntry = { item: T; origin: "base" | "stored" };
    let source: Iterable<PageEntry>;
    if (options.collapseBy) {
      const merged = new Map<string, PageEntry>();
      for (const item of options.baseItems ?? []) {
        if (options.filter && !options.filter(item)) continue;
        const family = options.collapseBy(item), current = merged.get(family);
        if (!current || (options.versionOf?.(item) ?? 0) > (options.versionOf?.(current.item) ?? 0)) merged.set(family, { item, origin: "base" });
      }
      const durable = new Map<string, PageEntry>();
      for (const item of stored) {
        if (options.filter && !options.filter(item)) continue;
        const family = options.collapseBy(item), current = durable.get(family);
        if (!current || (options.versionOf?.(item) ?? 0) > (options.versionOf?.(current.item) ?? 0)) durable.set(family, { item, origin: "stored" });
      }
      // Stored state is authoritative over configured base state, including tombstones.
      for (const [family, entry] of durable) merged.set(family, entry);
      source = merged.values();
    } else {
      source = (function* () { for (const item of options.baseItems ?? []) yield { item, origin: "base" as const }; for (const item of stored) yield { item, origin: "stored" as const }; })();
    }
    const groupTotals: Record<string, number> = {}, retained: PageEntry[] = [], retainCount = options.offset + options.limit;
    let total = 0;
    for (const entry of source) {
      const item = entry.item;
      if (!options.collapseBy && options.filter && !options.filter(item)) continue;
      const group = options.groupBy?.(item); if (group !== undefined) groupTotals[group] = (groupTotals[group] ?? 0) + 1;
      if (options.visible && !options.visible(item)) continue;
      total += 1;
      let low = 0, high = retained.length;
      while (low < high) { const middle = (low + high) >>> 1; if (options.compare(retained[middle]!.item, item) <= 0) low = middle + 1; else high = middle; }
      retained.splice(low, 0, entry); if (retained.length > retainCount) retained.pop();
    }
    const selected = retained.slice(options.offset, options.offset + options.limit);
    return { items: clone(selected.map((entry) => entry.item)), origins: selected.map((entry) => entry.origin), total, groupTotals };
  }
  async set<T>(key: string, value: T): Promise<void> { this.writable()[key] = clone(value) as StoredValue; }
  async delete(key: string): Promise<void> { if (key in this.values) delete this.writable()[key]; }
  get changed(): boolean { return Boolean(this.working); }
  get snapshot(): StoredRecord { return this.values; }
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
  return { async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> { const previous = mutex; let release: () => void = () => {}; mutex = new Promise<void>((resolve) => { release = resolve; }); await previous; try { const transaction = new MapTransaction(values); const result = await fn(transaction); if (transaction.changed) values = transaction.snapshot; return result; } finally { release(); } } };
}

export function createFileAtomicLocalStorage({ root, io = {} }: { root: string; io?: FileStorageHooks }): AtomicLocalStorage {
  const safeRoot = assertConfiguredRoot(root);
  return { async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> { const canonicalRoot = await recheckPhysicalRoot(safeRoot); return withMutex(canonicalRoot, async () => { const statePath = path.join(canonicalRoot, "identity-local-storage.json"); await recheckPhysicalRoot(canonicalRoot); const values = await readState(statePath);
    const transaction = new MapTransaction(values), result = await fn(transaction);
    if (transaction.changed) { await recheckPhysicalRoot(canonicalRoot); await assertStateFile(statePath); const temp = path.join(canonicalRoot, `identity-local-storage.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`); try { await (io.writeTemp ?? syncFile)(temp, JSON.stringify({ version: schemaVersion, values: transaction.snapshot } satisfies StoredEnvelope)); await (io.replace ?? rename)(temp, statePath); await (io.syncDirectory ?? syncDirectory)(canonicalRoot); } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; } }
    return result; }); } };
}
