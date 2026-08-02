import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

type StoredValue = null | boolean | number | string | StoredValue[] | { [key: string]: StoredValue };
type StoredRecord = Record<string, StoredValue>;
interface LegacyEnvelope { version: 1; values: StoredRecord }
interface StorageManifest { version: 2; generation: string }
type PageOrigin = "base" | "stored";
type IndexedRecord = Record<string, StoredValue>;

export type AtomicPhysicalPage =
  | { kind: "identity-reviews"; businessId: string; bucket?: string }
  | { kind: "identity-links"; businessId: string; mode: "current" }
  | { kind: "identity-links"; businessId: string; mode: "families"; families: readonly string[] }
  | { kind: "identity-links"; businessId: string; mode: "authoritative" };
export type AtomicPageOptions<T, After = never> = {
  /** Legacy file-index support only; new repository callers use `after`. */
  offset?: number;
  after?: After;
  isAfter?: (item: T, after: After) => boolean;
  limit: number;
  filter?: (item: T) => boolean;
  visible?: (item: T) => boolean;
  compare: (left: T, right: T) => number;
  groupBy?: (item: T) => string;
  collapseBy?: (item: T) => string;
  versionOf?: (item: T) => number;
  baseItems?: readonly T[];
  physical?: AtomicPhysicalPage;
};
export type AtomicPage<T> = { items: T[]; origins: PageOrigin[]; total: number; groupTotals: Record<string, number>; fingerprint?: string };
export interface AtomicTransaction { get<T>(key: string): Promise<T | undefined>; scanPage?<T, After = never>(key: string, options: AtomicPageOptions<T, After>): Promise<AtomicPage<T>>; set<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<void> }
export interface AtomicLocalStorage {
  transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T>;
  read?<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T>;
}

export type FileReadObservation = { filePath: string; bytes: number; records: number };
export type FileStorageHooks = {
  writeTemp?: (filePath: string, body: string) => Promise<void>;
  replace?: (tempPath: string, statePath: string) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<void>;
  observeRead?: (observation: FileReadObservation) => void;
  observeSeek?: (probe: { pageNumber: number; tuple: string[] }) => void;
  beforeMutexAcquire?: (root: string) => void;
  afterMutexAcquire?: (root: string) => void;
  afterGenerationFileWrite?: (filePath: string) => Promise<void>;
  beforeReaderPinPublish?: (filePath: string) => Promise<void>;
};

const rootMutexes = new Map<string, Promise<void>>();
const legacySchemaVersion = 1;
const manifestSchemaVersion = 2;
const recordsPerPage = 25;
const maxIndexFileBytes = 128 * 1024;
const maxExactRecordBytes = Math.floor((64 * 1024) / recordsPerPage);
const generationPattern = /^[a-f0-9-]{36}$/;
const lockFileName = "identity-local-storage.lock";
const lockStaleMilliseconds = 60_000;
const lockWaitMilliseconds = 15_000;

function clone<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T; }
function plainRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function storageRoot(): string { return path.resolve(process.cwd(), ".tmp", "identity-import"); }
function canonicalPathKey(root: string): string {
  const normalized = path.normalize(root);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}
function corrupt(): Error { return new Error("identity_storage_corrupt"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function fullDigest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function compareOrdinal(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
function stringField(record: IndexedRecord, key: string): string { return typeof record[key] === "string" ? record[key] : ""; }
function numberField(record: IndexedRecord, key: string): number { return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : 0; }
function linkFamily(record: IndexedRecord): string { return JSON.stringify(["businessId", "sourceSystem", "vendorId", "sourceSignature", "identifierType", "namespace", "normalizedValue"].map((key) => stringField(record, key))); }
function compareIndexedLinks(left: IndexedRecord, right: IndexedRecord): number { return compareOrdinal(stringField(left, "normalizedValue"), stringField(right, "normalizedValue")) || compareOrdinal(linkFamily(left), linkFamily(right)) || numberField(left, "version") - numberField(right, "version"); }
function assertBounds(options: { offset?: number; limit: number }): void { if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) throw new Error("atomic page bounds are invalid"); if (!Number.isSafeInteger(options.limit) || options.limit <= 0 || options.limit > 1_000) throw new Error("atomic page bounds are invalid"); }

function assertConfiguredRoot(root: string): string {
  const base = storageRoot();
  const resolved = path.resolve(root);
  if (canonicalPathKey(path.dirname(resolved)) !== canonicalPathKey(base) || !path.basename(resolved)) throw new Error(`Local identity storage root must be a direct child of ${base}`);
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
  if (canonicalPathKey(path.dirname(child)) !== canonicalPathKey(base)) throw new Error("identity-import child escaped approved base");
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("identity-import child is a reparse or symlink path");
  return child;
}

/**
 * A preview is a read model, not a storage initializer. Check an existing root
 * without creating it; transaction callers are writers and materialize the root
 * before their callback runs once under the process lock.
 */
async function existingPhysicalRoot(root: string): Promise<string | undefined> {
  try { await lstat(root); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return recheckPhysicalRoot(root);
}

async function assertRegularFile(filePath: string): Promise<boolean> {
  try { const stat = await lstat(filePath); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("identity-local-storage state is a reparse or symlink path"); return true; }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function withMutex<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = canonicalPathKey(root), previous = rootMutexes.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current); rootMutexes.set(key, queued); await previous;
  try { return await action(); } finally { release(); if (rootMutexes.get(key) === queued) rootMutexes.delete(key); }
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

type LockOwner = { token: string; pid: number };
type ReaderPinOwner = { token: string; pid: number; generation: string };
function parseLockOwner(body: string | undefined): LockOwner | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return plainRecord(parsed) && typeof parsed.token === "string" && parsed.token.length > 0
      && Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0
      ? { token: parsed.token, pid: parsed.pid as number }
      : undefined;
  } catch { return undefined; }
}
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** A process-visible exclusive lock with dead-process-only stale recovery. */
async function withFileLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(root, lockFileName), owner: LockOwner = { token: randomUUID(), pid: process.pid }, ownerBody = JSON.stringify(owner), deadline = Date.now() + lockWaitMilliseconds;
  for (;;) {
    try {
      const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(ownerBody, "utf8"); await handle.sync(); } finally { await handle.close(); }
      try { return await action(); }
      finally {
        const heldBy = await readFile(lockPath, "utf8").catch(() => undefined);
        if (heldBy === ownerBody) await unlink(lockPath).catch(() => undefined);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await lstat(lockPath).catch((statError: unknown) => {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw statError;
      });
      if (stat && Date.now() - stat.mtimeMs > lockStaleMilliseconds) {
        const staleBody = await readFile(lockPath, "utf8").catch(() => undefined);
        const staleOwner = parseLockOwner(staleBody);
        if (!staleOwner || !processIsAlive(staleOwner.pid)) {
          const quarantine = path.join(root, `identity-local-storage.stale-lock.${randomUUID()}`);
          try {
            await rename(lockPath, quarantine);
            await unlink(quarantine).catch(() => undefined);
          } catch (recoveryError: unknown) {
            if (!["ENOENT", "EACCES", "EPERM"].includes((recoveryError as NodeJS.ErrnoException).code ?? "")) throw recoveryError;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error("identity_storage_lock_timeout");
      await delay(10);
    }
  }
}

class MapTransaction implements AtomicTransaction {
  private working: StoredRecord | undefined;
  constructor(private readonly initial: StoredRecord) {}
  private get values(): StoredRecord { return this.working ?? this.initial; }
  private writable(): StoredRecord { if (!this.working) this.working = clone(this.initial); return this.working; }
  async get<T>(key: string): Promise<T | undefined> { return clone(this.values[key]) as T | undefined; }
  async scanPage<T, After = never>(key: string, options: AtomicPageOptions<T, After>): Promise<AtomicPage<T>> {
    assertBounds(options);
    const stored = Array.isArray(this.values[key]) ? this.values[key] as T[] : [];
    type PageEntry = { item: T; origin: PageOrigin };
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
      for (const [family, entry] of durable) merged.set(family, entry);
      source = merged.values();
    } else {
      source = (function* () { for (const item of options.baseItems ?? []) yield { item, origin: "base" as const }; for (const item of stored) yield { item, origin: "stored" as const }; })();
    }
    const groupTotals: Record<string, number> = {}, retained: PageEntry[] = [], fingerprintItems: T[] = [], retainCount = (options.offset ?? 0) + options.limit;
    let total = 0;
    for (const entry of source) {
      const item = entry.item;
      if (!options.collapseBy && options.filter && !options.filter(item)) continue;
      if (options.physical?.kind === "identity-links" && options.physical.mode === "current") fingerprintItems.push(item);
      const group = options.groupBy?.(item); if (group !== undefined) groupTotals[group] = (groupTotals[group] ?? 0) + 1;
      if (options.visible && !options.visible(item)) continue;
      total += 1;
      if (options.after !== undefined && (!options.isAfter || !options.isAfter(item, options.after))) continue;
      let low = 0, high = retained.length;
      while (low < high) { const middle = (low + high) >>> 1; if (options.compare(retained[middle]!.item, item) <= 0) low = middle + 1; else high = middle; }
      retained.splice(low, 0, entry); if (retained.length > retainCount) retained.pop();
    }
    const selected = retained.slice(options.offset ?? 0, (options.offset ?? 0) + options.limit);
    return {
      items: clone(selected.map((entry) => entry.item)),
      origins: selected.map((entry) => entry.origin),
      total,
      groupTotals,
      ...(options.physical?.kind === "identity-links" && options.physical.mode === "current"
        ? { fingerprint: fullDigest(JSON.stringify(fingerprintItems.sort(options.compare))) }
        : {}),
    };
  }
  async set<T>(key: string, value: T): Promise<void> { this.writable()[key] = clone(value) as StoredValue; }
  async delete(key: string): Promise<void> { if (key in this.values) delete this.writable()[key]; }
  get changed(): boolean { return Boolean(this.working); }
  get snapshot(): StoredRecord { return this.values; }
}

function parseJson(input: string): unknown { try { return JSON.parse(input); } catch { throw corrupt(); } }
function parseLegacy(input: string): StoredRecord { const parsed = parseJson(input); if (!plainRecord(parsed) || parsed.version !== legacySchemaVersion || !plainRecord(parsed.values)) throw corrupt(); return parsed.values as StoredRecord; }
function parseManifest(input: string): StorageManifest | undefined {
  const parsed = parseJson(input);
  if (plainRecord(parsed) && parsed.version === legacySchemaVersion) return undefined;
  if (!plainRecord(parsed) || parsed.version !== manifestSchemaVersion || typeof parsed.generation !== "string" || !generationPattern.test(parsed.generation)) throw corrupt();
  return { version: manifestSchemaVersion, generation: parsed.generation };
}

async function syncFile(filePath: string, body: string): Promise<void> {
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); }
}

async function readText(filePath: string, io: FileStorageHooks, { optional = false, maxBytes, records = 0, observe = true }: { optional?: boolean; maxBytes?: number; records?: number; observe?: boolean } = {}): Promise<string | undefined> {
  if (!await assertRegularFile(filePath)) { if (optional) return undefined; throw corrupt(); }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (maxBytes !== undefined && stat.size > maxBytes) throw corrupt();
    const body = await handle.readFile({ encoding: "utf8" });
    if (observe) io.observeRead?.({ filePath, bytes: Buffer.byteLength(body, "utf8"), records });
    return body;
  } finally { await handle.close(); }
}

function readerPinFileName(generation: string, token: string): string {
  if (!generationPattern.test(generation) || !generationPattern.test(token)) throw corrupt();
  return `identity-local-storage.reader.${generation}.${token}.pin`;
}
function parseReaderPin(body: string | undefined): ReaderPinOwner | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return plainRecord(parsed) && typeof parsed.token === "string" && generationPattern.test(parsed.token)
      && Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0
      && typeof parsed.generation === "string" && generationPattern.test(parsed.generation)
      ? { token: parsed.token, pid: parsed.pid as number, generation: parsed.generation }
      : undefined;
  } catch { return undefined; }
}
async function createReaderPin(root: string, generation: string, io: FileStorageHooks): Promise<{ filePath: string; body: string }> {
  const owner: ReaderPinOwner = { token: randomUUID(), pid: process.pid, generation };
  const filePath = path.join(root, readerPinFileName(generation, owner.token));
  const tempPath = path.join(root, `identity-local-storage.reader-pin.${process.pid}.${owner.token}.tmp`);
  const body = JSON.stringify(owner);
  try {
    await syncFile(tempPath, body);
    await io.beforeReaderPinPublish?.(tempPath);
    await rename(tempPath, filePath);
    await (io.syncDirectory ?? syncDirectory)(root);
    return { filePath, body };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
async function releaseReaderPin(pin: { filePath: string; body: string }, io: FileStorageHooks): Promise<void> {
  const current = await readText(pin.filePath, io, { optional: true, maxBytes: 1_024, observe: false }).catch(() => undefined);
  if (current === pin.body) await unlink(pin.filePath).catch(() => undefined);
}
async function activeReaderGenerations(root: string, io: FileStorageHooks): Promise<Set<string>> {
  const pattern = /^identity-local-storage\.reader\.([a-f0-9-]{36})\.([a-f0-9-]{36})\.pin$/;
  const active = new Set<string>();
  for (const name of await readdir(root)) {
    const match = pattern.exec(name);
    if (!match) continue;
    const filePath = path.join(root, name), body = await readText(filePath, io, { optional: true, maxBytes: 1_024, observe: false }).catch(() => undefined);
    const pin = parseReaderPin(body);
    if (pin && pin.generation === match[1] && pin.token === match[2] && processIsAlive(pin.pid)) active.add(pin.generation);
    else if (body !== undefined) await unlink(filePath).catch(() => undefined);
  }
  return active;
}

const directorySyncUnsupportedCodes = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EISDIR"]);
async function syncDirectory(directory: string): Promise<void> {
  try { const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error: unknown) { if (!directorySyncUnsupportedCodes.has((error as NodeJS.ErrnoException).code ?? "")) throw error; }
}

function generationPath(root: string, generation: string, suffix: string): string { if (!generationPattern.test(generation)) throw corrupt(); return path.join(root, `identity-local-storage.${generation}.${suffix}.json`); }
function businessToken(businessId: string): string { return digest(businessId); }
function reviewSummaryPath(root: string, generation: string, businessId: string): string { return generationPath(root, generation, `reviews.${businessToken(businessId)}.summary`); }
function reviewPagePath(root: string, generation: string, businessId: string, selector: string, pageNumber: number): string { return generationPath(root, generation, `reviews.${businessToken(businessId)}.${digest(selector)}.${pageNumber}`); }
function linkSummaryPath(root: string, generation: string, businessId: string): string { return generationPath(root, generation, `links.${businessToken(businessId)}.summary`); }
function linkPagePath(root: string, generation: string, businessId: string, pageNumber: number): string { return generationPath(root, generation, `links.${businessToken(businessId)}.${pageNumber}`); }
function approvedLinkSummaryPath(root: string, generation: string, businessId: string): string { return generationPath(root, generation, `links.${businessToken(businessId)}.approved.summary`); }
function approvedLinkPagePath(root: string, generation: string, businessId: string, pageNumber: number): string { return generationPath(root, generation, `links.${businessToken(businessId)}.approved.${pageNumber}`); }
function exactLinkIndexPath(root: string, generation: string, businessId: string): string { return generationPath(root, generation, `links.${businessToken(businessId)}.exact.index`); }
function exactLinkDescriptorPagePath(root: string, generation: string, businessId: string, pageNumber: number): string { return generationPath(root, generation, `links.${businessToken(businessId)}.exact.descriptor.${pageNumber}`); }
function exactLinkMergeSummaryPath(root: string, generation: string, businessId: string): string { return generationPath(root, generation, `links.${businessToken(businessId)}.exact.merge-summary`); }
function exactLinkMergeMembershipPagePath(root: string, generation: string, businessId: string, pageNumber: number): string { return generationPath(root, generation, `links.${businessToken(businessId)}.exact.merge-membership.${pageNumber}`); }
function exactLinkDataPath(root: string, generation: string, businessId: string): string { return generationPath(root, generation, `links.${businessToken(businessId)}.exact.data`); }

type ExactLinkIndexEntry = { familyHash: string; familyKey?: string; status: string; normalizedValue: string; offset: number; length: number };
type ExactLinkIndex = {
  schemaVersion: 1 | 2 | 3;
  mergeAlgorithmVersion: "identity-links-merge-v1";
  orderAlgorithmVersion: "identity-links-order-v1";
  businessId: string;
  entries: ExactLinkIndexEntry[];
  descriptorDirectory?: PageBoundary[];
  mergeSummaryFingerprint?: string;
};
type Tuple = readonly string[];
type PageBoundary = { first: string[]; last: string[] };
type IndexedSummary = { schemaVersion: 2; kind: "identity-reviews" | "identity-links"; businessId: string; total: number; bucketTotals: Record<string, number>; directories: Record<string, PageBoundary[]>; fingerprint?: string };

function pageBody(items: readonly unknown[]): string {
  const body = JSON.stringify({ version: 1, items });
  if (Buffer.byteLength(body, "utf8") > maxIndexFileBytes) throw new Error("identity_storage_index_page_too_large");
  return body;
}
function chunks<T>(items: readonly T[]): T[][] { const pages: T[][] = []; for (let index = 0; index < items.length; index += recordsPerPage) pages.push(items.slice(index, index + recordsPerPage)); return pages; }
function tupleCompare(left: Tuple, right: Tuple): number { for (let index = 0; index < Math.max(left.length, right.length); index += 1) { const compared = compareOrdinal(left[index] ?? "", right[index] ?? ""); if (compared) return compared; } return 0; }
function reviewTuple(record: IndexedRecord): string[] { return [stringField(record, "reviewId")]; }
function linkTuple(record: IndexedRecord): string[] { return [stringField(record, "normalizedValue"), linkFamily(record)]; }
function pageBoundaries(pages: readonly IndexedRecord[][], tuple: (record: IndexedRecord) => string[]): PageBoundary[] { return pages.map((page) => ({ first: tuple(page[0]!), last: tuple(page.at(-1)!) })); }
async function writeImmutable(filePath: string, body: string, io: FileStorageHooks): Promise<void> {
  await syncFile(filePath, body);
  await io.afterGenerationFileWrite?.(filePath);
}
async function writeIndexSummary(filePath: string, summary: IndexedSummary, io: FileStorageHooks): Promise<void> { const body = JSON.stringify(summary); if (Buffer.byteLength(body, "utf8") > maxIndexFileBytes) throw new Error("identity_storage_index_summary_too_large"); await writeImmutable(filePath, body, io); }

async function writeReviewIndexes(root: string, generation: string, values: StoredRecord, io: FileStorageHooks): Promise<void> {
  const reviews = Array.isArray(values["identity-reviews"]) ? values["identity-reviews"].filter(plainRecord) as IndexedRecord[] : [];
  const businesses = new Map<string, IndexedRecord[]>();
  for (const review of reviews) {
    const businessId = stringField(review, "businessId");
    if (!businessId || review.resolution) continue;
    businesses.set(businessId, [...(businesses.get(businessId) ?? []), review]);
  }
  for (const [businessId, scoped] of businesses) {
    scoped.sort((left, right) => compareOrdinal(stringField(left, "reviewId"), stringField(right, "reviewId")));
    const bucketTotals: Record<string, number> = {};
    const byBucket = new Map<string, IndexedRecord[]>();
    for (const review of scoped) {
      const decision = plainRecord(review.decision) ? review.decision : {};
      const bucket = stringField(decision as IndexedRecord, "kind");
      bucketTotals[bucket] = (bucketTotals[bucket] ?? 0) + 1;
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), review]);
    }
    const directories: Record<string, PageBoundary[]> = {};
    for (const [selector, records] of [["*", scoped] as const, ...[...byBucket.entries()]]) {
      const pages = chunks(records);
      directories[selector] = pageBoundaries(pages, reviewTuple);
      for (let index = 0; index < pages.length; index += 1) await writeImmutable(reviewPagePath(root, generation, businessId, selector, index), pageBody(pages[index]!), io);
    }
    await writeIndexSummary(reviewSummaryPath(root, generation, businessId), { schemaVersion: 2, kind: "identity-reviews", businessId, total: scoped.length, bucketTotals, directories }, io);
  }
}

function currentLinks(values: StoredRecord): Map<string, IndexedRecord[]> {
  const links = Array.isArray(values["identity-links"]) ? values["identity-links"].filter(plainRecord) as IndexedRecord[] : [];
  const businesses = new Map<string, Map<string, IndexedRecord>>();
  for (const link of links) {
    const businessId = stringField(link, "businessId"); if (!businessId) continue;
    const family = linkFamily(link), byFamily = businesses.get(businessId) ?? new Map<string, IndexedRecord>(), current = byFamily.get(family);
    if (!current || numberField(link, "version") > numberField(current, "version")) byFamily.set(family, link);
    businesses.set(businessId, byFamily);
  }
  return new Map([...businesses].map(([businessId, byFamily]) => [businessId, [...byFamily.values()].sort(compareIndexedLinks)]));
}

async function writeLinkIndexes(root: string, generation: string, values: StoredRecord, io: FileStorageHooks): Promise<void> {
  for (const [businessId, links] of currentLinks(values)) {
    const pages = chunks(links);
    await writeIndexSummary(linkSummaryPath(root, generation, businessId), { schemaVersion: 2, kind: "identity-links", businessId, total: links.length, bucketTotals: {}, directories: { current: pageBoundaries(pages, linkTuple) }, fingerprint: fullDigest(JSON.stringify(links)) }, io);
    for (let index = 0; index < pages.length; index += 1) await writeImmutable(linkPagePath(root, generation, businessId, index), pageBody(pages[index]!), io);
    const approved = links.filter((link) => stringField(link, "status") === "approved");
    const approvedPages = chunks(approved);
    await writeIndexSummary(approvedLinkSummaryPath(root, generation, businessId), { schemaVersion: 2, kind: "identity-links", businessId, total: approved.length, bucketTotals: {}, directories: { approved: pageBoundaries(approvedPages, linkTuple) } }, io);
    for (let index = 0; index < approvedPages.length; index += 1) await writeImmutable(approvedLinkPagePath(root, generation, businessId, index), pageBody(approvedPages[index]!), io);
    let offset = 0;
    const dataParts: string[] = [];
    const entries: ExactLinkIndexEntry[] = [];
    const hashes = new Set<string>();
    for (const link of links) {
      const body = `${JSON.stringify(link)}\n`, length = Buffer.byteLength(body, "utf8"), familyHash = digest(linkFamily(link));
      if (length > maxExactRecordBytes) throw new Error("identity_storage_exact_record_too_large");
      if (hashes.has(familyHash)) throw new Error("identity_storage_exact_family_collision");
      hashes.add(familyHash);
      entries.push({ familyHash, familyKey: linkFamily(link), status: stringField(link, "status"), normalizedValue: stringField(link, "normalizedValue"), offset, length });
      dataParts.push(body);
      offset += length;
    }
    const descriptors = [...entries].sort((left, right) => compareOrdinal(left.familyHash, right.familyHash) || compareOrdinal(left.familyKey!, right.familyKey!));
    const descriptorPages = chunks(descriptors);
    const memberships = [...entries].sort((left, right) => compareOrdinal(left.familyHash, right.familyHash) || compareOrdinal(left.familyKey!, right.familyKey!));
    const membershipPages = chunks(memberships);
    const membershipBodies = membershipPages.map((page) => pageBody(page.map((entry) => [entry.familyHash, entry.familyKey!, entry.status])));
    const mergeSummaryBody = JSON.stringify({ schemaVersion: 2, businessId, total: memberships.length, directory: membershipPages.map((page, pageNumber) => ({ first: [page[0]!.familyHash, page[0]!.familyKey!], last: [page.at(-1)!.familyHash, page.at(-1)!.familyKey!], fingerprint: fullDigest(membershipBodies[pageNumber]!) })) });
    if (Buffer.byteLength(mergeSummaryBody, "utf8") > maxIndexFileBytes) throw new Error("identity_storage_index_summary_too_large");
    const index = {
      schemaVersion: 3,
      mergeAlgorithmVersion: "identity-links-merge-v1",
      orderAlgorithmVersion: "identity-links-order-v1",
      businessId,
      descriptorDirectory: descriptorPages.map((page) => ({ first: [page[0]!.familyHash, page[0]!.familyKey!], last: [page.at(-1)!.familyHash, page.at(-1)!.familyKey!] })),
      mergeSummaryFingerprint: fullDigest(mergeSummaryBody),
    };
    const indexBody = JSON.stringify(index);
    if (Buffer.byteLength(indexBody, "utf8") > maxIndexFileBytes) throw new Error("identity_storage_exact_index_too_large");
    await writeImmutable(exactLinkDataPath(root, generation, businessId), dataParts.join(""), io);
    for (let pageNumber = 0; pageNumber < descriptorPages.length; pageNumber += 1) await writeImmutable(exactLinkDescriptorPagePath(root, generation, businessId, pageNumber), pageBody(descriptorPages[pageNumber]!.map((entry) => [entry.familyHash, entry.familyKey!, entry.status, entry.normalizedValue, entry.offset, entry.length])), io);
    for (let pageNumber = 0; pageNumber < membershipBodies.length; pageNumber += 1) await writeImmutable(exactLinkMergeMembershipPagePath(root, generation, businessId, pageNumber), membershipBodies[pageNumber]!, io);
    await writeImmutable(exactLinkMergeSummaryPath(root, generation, businessId), mergeSummaryBody, io);
    await writeImmutable(exactLinkIndexPath(root, generation, businessId), indexBody, io);
  }
}

async function cleanupOldGenerations(root: string, statePath: string, keep: ReadonlySet<string>, io: FileStorageHooks): Promise<void> {
  const liveBody = await readText(statePath, io, { maxBytes: maxIndexFileBytes, observe: false });
  const liveManifest = parseManifest(liveBody!);
  if (!liveManifest) throw corrupt();
  const protectedGenerations = new Set([...keep, liveManifest.generation, ...await activeReaderGenerations(root, io)]);
  const pattern = /^identity-local-storage\.([a-f0-9-]{36})\..+\.json$/;
  await Promise.all((await readdir(root)).map(async (name) => {
    const generation = pattern.exec(name)?.[1];
    if (!generation || protectedGenerations.has(generation)) return;
    const target = path.join(root, name);
    if (path.dirname(target) !== root) throw new Error("identity generation cleanup escaped storage root");
    if (await assertRegularFile(target)) await unlink(target);
  }));
}

async function assertManifestCompareAndSwap(statePath: string, expectedGeneration: string | undefined, io: FileStorageHooks): Promise<void> {
  const currentBody = await readText(statePath, io, { optional: true, maxBytes: maxIndexFileBytes, observe: false });
  if (currentBody === undefined) {
    if (expectedGeneration !== undefined) throw new Error("identity_storage_manifest_conflict");
    return;
  }
  const current = parseManifest(currentBody);
  if (expectedGeneration === undefined) {
    if (current) throw new Error("identity_storage_manifest_conflict");
    return;
  }
  if (!current || current.generation !== expectedGeneration) throw new Error("identity_storage_manifest_conflict");
}

async function commitGeneration(root: string, statePath: string, values: StoredRecord, io: FileStorageHooks, previousGeneration?: string): Promise<StorageManifest> {
  const generation = randomUUID(), manifest: StorageManifest = { version: manifestSchemaVersion, generation };
  await writeImmutable(generationPath(root, generation, "state"), JSON.stringify({ version: legacySchemaVersion, values } satisfies LegacyEnvelope), io);
  await writeReviewIndexes(root, generation, values, io);
  await writeLinkIndexes(root, generation, values, io);
  await (io.syncDirectory ?? syncDirectory)(root);
  const temp = path.join(root, `identity-local-storage.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let swapped = false;
  try {
    await (io.writeTemp ?? syncFile)(temp, JSON.stringify(manifest));
    await assertManifestCompareAndSwap(statePath, previousGeneration, io);
    await (io.replace ?? rename)(temp, statePath);
    swapped = true;
    try { await (io.syncDirectory ?? syncDirectory)(root); }
    catch (error) { throw new Error(`identity_storage_commit_indeterminate:${generation}`, { cause: error }); }
  } catch (error) {
    if (!swapped) await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await cleanupOldGenerations(root, statePath, new Set([generation, ...(previousGeneration ? [previousGeneration] : [])]), io).catch(() => undefined);
  return manifest;
}

async function loadState(root: string, manifest: StorageManifest, io: FileStorageHooks): Promise<StoredRecord> {
  const body = await readText(generationPath(root, manifest.generation, "state"), io);
  return parseLegacy(body!);
}

function parseSummary(body: string | undefined, businessId: string): IndexedSummary {
  if (body === undefined) return { schemaVersion: 2, kind: "identity-reviews", businessId, total: 0, bucketTotals: {}, directories: {} };
  const parsed = parseJson(body);
  if (!plainRecord(parsed) || parsed.schemaVersion !== 2 || (parsed.kind !== "identity-reviews" && parsed.kind !== "identity-links") || parsed.businessId !== businessId || typeof parsed.total !== "number" || !Number.isSafeInteger(parsed.total) || parsed.total < 0 || !plainRecord(parsed.bucketTotals) || !plainRecord(parsed.directories) || (parsed.fingerprint !== undefined && (typeof parsed.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(parsed.fingerprint)))) throw corrupt();
  const bucketTotals: Record<string, number> = {}, directories: Record<string, PageBoundary[]> = {};
  for (const [bucket, total] of Object.entries(parsed.bucketTotals)) { if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw corrupt(); bucketTotals[bucket] = total; }
  for (const [selector, raw] of Object.entries(parsed.directories)) {
    if (!Array.isArray(raw)) throw corrupt(); let previous: string[] | undefined;
    directories[selector] = raw.map((entry) => { if (!plainRecord(entry) || !Array.isArray(entry.first) || !Array.isArray(entry.last) || entry.first.length < 1 || entry.first.length > 2 || entry.last.length !== entry.first.length || !entry.first.every((value) => typeof value === "string") || !entry.last.every((value) => typeof value === "string") || tupleCompare(entry.first as string[], entry.last as string[]) > 0 || (previous && tupleCompare(previous, entry.first as string[]) >= 0)) throw corrupt(); previous = entry.last as string[]; return { first: [...entry.first] as string[], last: [...entry.last] as string[] }; });
  }
  return { schemaVersion: 2, kind: parsed.kind, businessId, total: parsed.total, bucketTotals, directories, ...(typeof parsed.fingerprint === "string" ? { fingerprint: parsed.fingerprint } : {}) };
}
function parsePage<T>(body: string | undefined): T[] {
  if (body === undefined) return [];
  const parsed = parseJson(body);
  if (!plainRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.items) || parsed.items.length > recordsPerPage) throw corrupt();
  return parsed.items as T[];
}

function parseExactLinkIndex(body: string | undefined, businessId: string): ExactLinkIndex | undefined {
  if (body === undefined) return undefined;
  const parsed = parseJson(body);
  if (!plainRecord(parsed) || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) || parsed.mergeAlgorithmVersion !== "identity-links-merge-v1"
    || parsed.orderAlgorithmVersion !== "identity-links-order-v1" || parsed.businessId !== businessId) throw corrupt();
  if (parsed.schemaVersion === 3) {
    if (!Array.isArray(parsed.descriptorDirectory) || typeof parsed.mergeSummaryFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(parsed.mergeSummaryFingerprint)) throw corrupt();
    let previous: string[] | undefined;
    const descriptorDirectory = parsed.descriptorDirectory.map((raw) => {
      if (!plainRecord(raw) || !Array.isArray(raw.first) || !Array.isArray(raw.last) || raw.first.length !== 2 || raw.last.length !== 2 || !raw.first.every((value) => typeof value === "string") || !raw.last.every((value) => typeof value === "string") || !/^[a-f0-9]{32}$/.test(raw.first[0] as string) || !/^[a-f0-9]{32}$/.test(raw.last[0] as string) || tupleCompare(raw.first as string[], raw.last as string[]) > 0 || (previous && (tupleCompare(previous, raw.first as string[]) >= 0 || previous[0] === raw.first[0]))) throw corrupt();
      previous = raw.last as string[];
      return { first: [...raw.first] as string[], last: [...raw.last] as string[] };
    });
    return { schemaVersion: 3, mergeAlgorithmVersion: "identity-links-merge-v1", orderAlgorithmVersion: "identity-links-order-v1", businessId, entries: [], descriptorDirectory, mergeSummaryFingerprint: parsed.mergeSummaryFingerprint };
  }
  if (!Array.isArray(parsed.entries) || parsed.descriptorDirectory !== undefined || parsed.mergeSummaryFingerprint !== undefined) throw corrupt();
  const entries: ExactLinkIndexEntry[] = [];
  let previousEnd = 0;
  for (const raw of parsed.entries) {
    const v2 = parsed.schemaVersion === 2;
    if (!Array.isArray(raw) || raw.length !== (v2 ? 6 : 5) || typeof raw[0] !== "string" || !/^[a-f0-9]{32}$/.test(raw[0])
      || typeof raw[v2 ? 1 : 1] !== "string" || typeof raw[v2 ? 2 : 1] !== "string" || typeof raw[v2 ? 3 : 2] !== "string"
      || !Number.isSafeInteger(raw[v2 ? 4 : 3]) || (raw[v2 ? 4 : 3] as number) < previousEnd
      || !Number.isSafeInteger(raw[v2 ? 5 : 4]) || (raw[v2 ? 5 : 4] as number) <= 0 || (raw[v2 ? 5 : 4] as number) > maxExactRecordBytes) throw corrupt();
    entries.push(v2 ? { familyHash: raw[0], familyKey: raw[1] as string, status: raw[2] as string, normalizedValue: raw[3] as string, offset: raw[4] as number, length: raw[5] as number } : { familyHash: raw[0], status: raw[1] as string, normalizedValue: raw[2] as string, offset: raw[3] as number, length: raw[4] as number });
    previousEnd = (raw[v2 ? 4 : 3] as number) + (raw[v2 ? 5 : 4] as number);
  }
  return { schemaVersion: parsed.schemaVersion as 1 | 2, mergeAlgorithmVersion: "identity-links-merge-v1", orderAlgorithmVersion: "identity-links-order-v1", businessId, entries };
}

function parseDescriptorPage(body: string | undefined): ExactLinkIndexEntry[] {
  const raw = parsePage<unknown[]>(body);
  return raw.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 6 || typeof entry[0] !== "string" || !/^[a-f0-9]{32}$/.test(entry[0]) || typeof entry[1] !== "string" || typeof entry[2] !== "string" || typeof entry[3] !== "string" || !Number.isSafeInteger(entry[4]) || (entry[4] as number) < 0 || !Number.isSafeInteger(entry[5]) || (entry[5] as number) <= 0 || (entry[5] as number) > maxExactRecordBytes) throw corrupt();
    return { familyHash: entry[0], familyKey: entry[1], status: entry[2], normalizedValue: entry[3], offset: entry[4] as number, length: entry[5] as number };
  });
}

async function findExactLinkDescriptor(root: string, generation: string, businessId: string, index: ExactLinkIndex | undefined, familyKey: string, io: FileStorageHooks, cache?: Map<number, ExactLinkIndexEntry[]>): Promise<ExactLinkIndexEntry | undefined> {
  if (!index) return undefined;
  const familyHash = digest(familyKey);
  if (index.schemaVersion !== 3) return index.entries.find((entry) => entry.familyHash === familyHash && entry.familyKey === familyKey);
  const directory = index.descriptorDirectory ?? [];
  let low = 0, high = directory.length;
  while (low < high) { const mid = Math.floor((low + high) / 2); io.observeSeek?.({ pageNumber: mid, tuple: directory[mid]!.last }); if (tupleCompare(directory[mid]!.last, [familyHash, familyKey]) < 0) low = mid + 1; else high = mid; }
  if (low >= directory.length || tupleCompare(directory[low]!.first, [familyHash, familyKey]) > 0) return undefined;
  const filePath = exactLinkDescriptorPagePath(root, generation, businessId, low);
  let entries = cache?.get(low);
  let body: string | undefined;
  if (!entries) {
    body = await readText(filePath, io, { optional: false, maxBytes: maxIndexFileBytes, observe: false });
    entries = parseDescriptorPage(body);
    cache?.set(low, entries);
  }
  if (entries.length === 0 || entries.some((entry, position) => position > 0 && (tupleCompare([entries[position - 1]!.familyHash, entries[position - 1]!.familyKey!], [entry.familyHash, entry.familyKey!]) >= 0 || entries[position - 1]!.familyHash === entry.familyHash)) || tupleCompare([entries[0]!.familyHash, entries[0]!.familyKey!], directory[low]!.first) !== 0 || tupleCompare([entries.at(-1)!.familyHash, entries.at(-1)!.familyKey!], directory[low]!.last) !== 0) throw corrupt();
  if (body !== undefined) io.observeRead?.({ filePath, bytes: Buffer.byteLength(body, "utf8"), records: 0 });
  return entries.find((entry) => entry.familyHash === familyHash && entry.familyKey === familyKey);
}

async function readExactLinkRecords<T>(root: string, generation: string, businessId: string, entries: readonly ExactLinkIndexEntry[], io: FileStorageHooks): Promise<Map<string, T>> {
  if (entries.length === 0) return new Map();
  if (entries.length > 1_000) throw corrupt();
  const filePath = exactLinkDataPath(root, generation, businessId);
  if (!await assertRegularFile(filePath)) throw corrupt();
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const result = new Map<string, T>();
  try {
    const stat = await handle.stat();
    for (const entry of entries) {
      if (entry.offset + entry.length > stat.size) throw corrupt();
      const buffer = Buffer.alloc(entry.length);
      const read = await handle.read(buffer, 0, entry.length, entry.offset);
      if (read.bytesRead !== entry.length) throw corrupt();
      const text = buffer.toString("utf8");
      const parsed = parseJson(text.trim());
      if (!plainRecord(parsed) || digest(linkFamily(parsed as IndexedRecord)) !== entry.familyHash || (entry.familyKey !== undefined && (linkFamily(parsed as IndexedRecord) !== entry.familyKey || stringField(parsed as IndexedRecord, "normalizedValue") !== entry.normalizedValue || stringField(parsed as IndexedRecord, "status") !== entry.status))) throw corrupt();
      io.observeRead?.({ filePath, bytes: entry.length, records: 1 });
      result.set(entry.familyHash, parsed as T);
    }
  } finally { await handle.close(); }
  return result;
}

async function loadExactLinkIndex(root: string, generation: string, businessId: string, io: FileStorageHooks): Promise<ExactLinkIndex | undefined> {
  return parseExactLinkIndex(await readText(exactLinkIndexPath(root, generation, businessId), io, { optional: true, maxBytes: maxIndexFileBytes }), businessId);
}

type MergeMembership = { familyHash: string; familyKey: string; status: string };
function validLinkStatus(status: string): boolean { return status === "proposed" || status === "approved" || status === "rejected" || status === "revoked"; }
function validFamilyKey(familyKey: string, businessId: string): boolean {
  try { const parsed = parseJson(familyKey); return Array.isArray(parsed) && parsed.length === 7 && parsed.every((value) => typeof value === "string") && parsed[0] === businessId; }
  catch { return false; }
}
async function readExactMergeMembership(root: string, generation: string, businessId: string, io: FileStorageHooks, index: ExactLinkIndex | undefined): Promise<MergeMembership[] | undefined> {
  const body = await readText(exactLinkMergeSummaryPath(root, generation, businessId), io, { optional: true, maxBytes: maxIndexFileBytes });
  if (body === undefined) {
    const membershipPrefix = path.basename(exactLinkMergeMembershipPagePath(root, generation, businessId, 0)).replace(/0\.json$/, "");
    const descriptorPrefix = path.basename(exactLinkDescriptorPagePath(root, generation, businessId, 0)).replace(/0\.json$/, "");
    if ((await readdir(root)).some((name) => name.startsWith(membershipPrefix) || name.startsWith(descriptorPrefix))) throw corrupt();
    if (index?.schemaVersion === 3) throw corrupt(); return index ? undefined : [];
  }
  if (!index || index.schemaVersion !== 3 || !index.mergeSummaryFingerprint || fullDigest(body) !== index.mergeSummaryFingerprint) throw corrupt();
  const parsed = parseJson(body);
  if (!plainRecord(parsed) || parsed.schemaVersion !== 2 || parsed.businessId !== businessId || !Number.isSafeInteger(parsed.total) || (parsed.total as number) < 0 || !Array.isArray(parsed.directory)) throw corrupt();
  type MembershipBoundary = PageBoundary & { fingerprint: string };
  let previous: string[] | undefined;
  const directory: MembershipBoundary[] = parsed.directory.map((entry) => {
    if (!plainRecord(entry) || !Array.isArray(entry.first) || !Array.isArray(entry.last) || entry.first.length !== 2 || entry.last.length !== 2 || !entry.first.every((value) => typeof value === "string") || !entry.last.every((value) => typeof value === "string") || !/^[a-f0-9]{32}$/.test(entry.first[0] as string) || !/^[a-f0-9]{32}$/.test(entry.last[0] as string) || typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || tupleCompare(entry.first as string[], entry.last as string[]) > 0 || (previous && (tupleCompare(previous, entry.first as string[]) >= 0 || previous[0] === entry.first[0]))) throw corrupt();
    previous = entry.last as string[]; return { first: [...entry.first] as string[], last: [...entry.last] as string[], fingerprint: entry.fingerprint as string };
  });
  if (Math.ceil((parsed.total as number) / recordsPerPage) !== directory.length) throw corrupt();
  const result: MergeMembership[] = [];
  for (let pageNumber = 0; pageNumber < directory.length; pageNumber += 1) {
    const filePath = exactLinkMergeMembershipPagePath(root, generation, businessId, pageNumber);
    const pageBodyText = await readText(filePath, io, { optional: false, maxBytes: maxIndexFileBytes, observe: false });
    if (pageBodyText === undefined) throw corrupt();
    if (fullDigest(pageBodyText!) !== directory[pageNumber]!.fingerprint) throw corrupt();
    const raw = parsePage<unknown[]>(pageBodyText), page = raw.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== "string" || !/^[a-f0-9]{32}$/.test(entry[0]) || typeof entry[1] !== "string" || digest(entry[1]) !== entry[0] || !validFamilyKey(entry[1], businessId) || typeof entry[2] !== "string" || !validLinkStatus(entry[2])) throw corrupt();
      return { familyHash: entry[0], familyKey: entry[1], status: entry[2] };
    });
    const boundary = directory[pageNumber]!;
    if (page.length === 0 || tupleCompare([page[0]!.familyHash, page[0]!.familyKey], boundary.first) !== 0 || tupleCompare([page.at(-1)!.familyHash, page.at(-1)!.familyKey], boundary.last) !== 0 || page.some((entry, position) => position > 0 && (tupleCompare([page[position - 1]!.familyHash, page[position - 1]!.familyKey], [entry.familyHash, entry.familyKey]) >= 0 || page[position - 1]!.familyHash === entry.familyHash))) throw corrupt();
    io.observeRead?.({ filePath, bytes: Buffer.byteLength(pageBodyText!, "utf8"), records: 0 }); result.push(...page);
  }
  if (result.length !== parsed.total) throw corrupt();
  return result;
}

async function readIndexedPage<T, After = never>({ businessId, selector, options, io, summaryPath, pagePath, tuple, afterTuple }: { businessId: string; selector: string; options: AtomicPageOptions<T, After>; io: FileStorageHooks; summaryPath: string; pagePath: (pageNumber: number) => string; tuple: (item: T) => string[]; afterTuple: (after: After) => string[] }): Promise<AtomicPage<T>> {
  const summaryBody = await readText(summaryPath, io, { optional: true, maxBytes: maxIndexFileBytes });
  const summary = parseSummary(summaryBody, businessId), directory = summary.directories[selector];
  const selectorTotal = selector === "*" || selector === "current" || selector === "approved" ? summary.total : summary.bucketTotals[selector] ?? 0;
  if (!directory) { if (selectorTotal === 0) return { items: [], origins: [], total: selectorTotal, groupTotals: summary.bucketTotals, ...(summary.fingerprint ? { fingerprint: summary.fingerprint } : {}) }; throw corrupt(); }
  const total = selectorTotal;
  if (Math.ceil(total / recordsPerPage) !== directory.length) throw corrupt();
  let firstPage = Math.floor((options.offset ?? 0) / recordsPerPage);
  if (options.after !== undefined) {
    let low = 0, high = directory.length;
    const after = afterTuple(options.after);
    while (low < high) { const mid = Math.floor((low + high) / 2); io.observeSeek?.({ pageNumber: mid, tuple: directory[mid]!.last }); if (tupleCompare(directory[mid]!.last, after) <= 0) low = mid + 1; else high = mid; }
    firstPage = low;
  }
  const loaded: T[] = [];
  for (let pageNumber = firstPage; pageNumber < directory.length && loaded.length < (options.after === undefined ? options.limit : options.limit + recordsPerPage); pageNumber += 1) {
    const filePath = pagePath(pageNumber), body = await readText(filePath, io, { optional: false, maxBytes: maxIndexFileBytes, observe: false });
    const page = parsePage<T>(body);
    if (page.length === 0 || tupleCompare(tuple(page[0]!), directory[pageNumber]!.first) !== 0 || tupleCompare(tuple(page.at(-1)!), directory[pageNumber]!.last) !== 0 || page.some((item, index) => index > 0 && tupleCompare(tuple(page[index - 1]!), tuple(item)) >= 0)) throw corrupt();
    io.observeRead?.({ filePath, bytes: Buffer.byteLength(body!, "utf8"), records: page.length });
    loaded.push(...page);
  }
  const strict = options.after === undefined ? loaded : loaded.filter((item) => !options.isAfter || options.isAfter(item, options.after!));
  const withinFirst = options.after === undefined ? (options.offset ?? 0) - firstPage * recordsPerPage : 0;
  const items = strict.slice(withinFirst, withinFirst + options.limit);
  return { items: clone(items), origins: items.map(() => "stored"), total, groupTotals: summary.bucketTotals, ...(summary.fingerprint ? { fingerprint: summary.fingerprint } : {}) };
}

async function openIndexedStream<T, After = never>({ businessId, selector, options, io, summaryPath, pagePath, tuple, afterTuple }: { businessId: string; selector: string; options: AtomicPageOptions<T, After>; io: FileStorageHooks; summaryPath: string; pagePath: (pageNumber: number) => string; tuple: (item: T) => string[]; afterTuple: (after: After) => string[] }): Promise<{ next: () => Promise<T | undefined>; total: number }> {
  const summary = parseSummary(await readText(summaryPath, io, { optional: true, maxBytes: maxIndexFileBytes }), businessId);
  const directory = summary.directories[selector];
  if (!directory) { if (summary.total === 0) return { next: async () => undefined, total: 0 }; throw corrupt(); }
  if (Math.ceil(summary.total / recordsPerPage) !== directory.length) throw corrupt();
  let pageNumber = 0;
  if (options.after !== undefined) {
    let low = 0, high = directory.length;
    const after = afterTuple(options.after);
    while (low < high) { const mid = Math.floor((low + high) / 2); io.observeSeek?.({ pageNumber: mid, tuple: directory[mid]!.last }); if (tupleCompare(directory[mid]!.last, after) <= 0) low = mid + 1; else high = mid; }
    pageNumber = low;
  }
  let page: T[] = [], itemNumber = 0;
  const loadNextPage = async (): Promise<boolean> => {
    if (pageNumber >= directory.length) return false;
    const filePath = pagePath(pageNumber), body = await readText(filePath, io, { optional: false, maxBytes: maxIndexFileBytes, observe: false });
    const loaded = parsePage<T>(body), boundary = directory[pageNumber]!;
    if (loaded.length === 0 || tupleCompare(tuple(loaded[0]!), boundary.first) !== 0 || tupleCompare(tuple(loaded.at(-1)!), boundary.last) !== 0 || loaded.some((item, index) => index > 0 && tupleCompare(tuple(loaded[index - 1]!), tuple(item)) >= 0)) throw corrupt();
    io.observeRead?.({ filePath, bytes: Buffer.byteLength(body!, "utf8"), records: loaded.length });
    page = loaded; itemNumber = 0; pageNumber += 1; return true;
  };
  return {
    total: summary.total,
    next: async () => {
      for (;;) {
        if (itemNumber >= page.length && !await loadNextPage()) return undefined;
        const item = page[itemNumber++]!;
        if (options.after !== undefined && options.isAfter && !options.isAfter(item, options.after)) continue;
        return item;
      }
    },
  };
}

async function readLegacyMergeMembership(root: string, generation: string, businessId: string, io: FileStorageHooks): Promise<MergeMembership[]> {
  const stream = await openIndexedStream<IndexedRecord>({ businessId, selector: "current", options: { limit: 1, compare: compareIndexedLinks }, io, summaryPath: linkSummaryPath(root, generation, businessId), pagePath: (pageNumber) => linkPagePath(root, generation, businessId, pageNumber), tuple: linkTuple, afterTuple: () => [] });
  const result: MergeMembership[] = [], hashes = new Set<string>();
  for (let link = await stream.next(); link !== undefined; link = await stream.next()) {
    const familyKey = linkFamily(link), familyHash = digest(familyKey), status = stringField(link, "status");
    if (!validFamilyKey(familyKey, businessId) || !validLinkStatus(status) || hashes.has(familyHash)) throw corrupt();
    hashes.add(familyHash); result.push({ familyHash, familyKey, status });
  }
  if (result.length !== stream.total) throw corrupt();
  return result;
}

class FileTransaction implements AtomicTransaction {
  private delegate?: MapTransaction;
  constructor(private readonly root: string, private readonly manifest: StorageManifest | undefined, private readonly io: FileStorageHooks) {}
  private async map(): Promise<MapTransaction> { if (!this.delegate) this.delegate = new MapTransaction(this.manifest ? await loadState(this.root, this.manifest, this.io) : {}); return this.delegate; }
  async get<T>(key: string): Promise<T | undefined> { return (await this.map()).get<T>(key); }
  async set<T>(key: string, value: T): Promise<void> { return (await this.map()).set(key, value); }
  async delete(key: string): Promise<void> { return (await this.map()).delete(key); }
  async scanPage<T, After = never>(key: string, options: AtomicPageOptions<T, After>): Promise<AtomicPage<T>> {
    assertBounds(options);
    if (!this.manifest || !options.physical || this.delegate?.changed) return (await this.map()).scanPage(key, options);
    const physical = options.physical;
    if (physical.kind === "identity-reviews" && key === "identity-reviews") {
      const selector = physical.bucket ?? "*";
      return readIndexedPage({ businessId: physical.businessId, selector, options, io: this.io, summaryPath: reviewSummaryPath(this.root, this.manifest.generation, physical.businessId), pagePath: (pageNumber) => reviewPagePath(this.root, this.manifest!.generation, physical.businessId, selector, pageNumber), tuple: (item) => reviewTuple(item as IndexedRecord), afterTuple: (after) => [stringField(after as unknown as IndexedRecord, "reviewId")] });
    }
    if (physical.kind === "identity-links" && key === "identity-links" && physical.mode === "current") {
      return readIndexedPage({ businessId: physical.businessId, selector: "current", options, io: this.io, summaryPath: linkSummaryPath(this.root, this.manifest.generation, physical.businessId), pagePath: (pageNumber) => linkPagePath(this.root, this.manifest!.generation, physical.businessId, pageNumber), tuple: (item) => linkTuple(item as IndexedRecord), afterTuple: (after) => [stringField(after as unknown as IndexedRecord, "normalizedValue"), stringField(after as unknown as IndexedRecord, "familyKey")] });
    }
    if (physical.kind === "identity-links" && key === "identity-links" && physical.mode === "families") {
      const index = await loadExactLinkIndex(this.root, this.manifest.generation, physical.businessId, this.io);
      if (!index) return { items: [], origins: [], total: 0, groupTotals: {} };
      const requestedByHash = new Map<string, string>();
      for (const family of physical.families.slice(0, recordsPerPage)) {
        const familyHash = digest(family), existing = requestedByHash.get(familyHash);
        if (existing !== undefined && existing !== family) throw corrupt();
        requestedByHash.set(familyHash, family);
      }
      const selectedEntries = index.schemaVersion === 3
        ? (await Promise.all([...requestedByHash.values()].map((family) => findExactLinkDescriptor(this.root, this.manifest!.generation, physical.businessId, index, family, this.io)))).filter((entry): entry is ExactLinkIndexEntry => entry !== undefined)
        : [...requestedByHash].flatMap(([familyHash]) => {
            const matches = index.entries.filter((entry) => entry.familyHash === familyHash);
            if (matches.length > 1) throw corrupt();
            return matches;
          });
      const records = await readExactLinkRecords<T>(this.root, this.manifest.generation, physical.businessId, selectedEntries, this.io);
      const found: T[] = [];
      for (const entry of selectedEntries) {
        const item = records.get(entry.familyHash);
        if (!item || !plainRecord(item) || linkFamily(item as IndexedRecord) !== requestedByHash.get(entry.familyHash)) throw corrupt();
        if (options.filter && !options.filter(item)) continue;
        if (options.visible && !options.visible(item)) continue;
        found.push(item);
      }
      found.sort(options.compare);
      const selected = found.slice(options.offset ?? 0, (options.offset ?? 0) + options.limit);
      return { items: clone(selected), origins: selected.map(() => "stored"), total: found.length, groupTotals: {} };
    }
    if (physical.kind === "identity-links" && key === "identity-links" && physical.mode === "authoritative") return this.authoritative(options, physical.businessId);
    return (await this.map()).scanPage(key, options);
  }
  private async authoritative<T, After = never>(options: AtomicPageOptions<T, After>, businessId: string): Promise<AtomicPage<T>> {
    if ((options.baseItems?.length ?? 0) === 0) {
      return readIndexedPage({ businessId, selector: "approved", options, io: this.io, summaryPath: approvedLinkSummaryPath(this.root, this.manifest!.generation, businessId), pagePath: (pageNumber) => approvedLinkPagePath(this.root, this.manifest!.generation, businessId, pageNumber), tuple: (item) => linkTuple(item as IndexedRecord), afterTuple: (after) => [stringField(after as unknown as IndexedRecord, "normalizedValue"), stringField(after as unknown as IndexedRecord, "familyKey")] });
    }
    if (!options.collapseBy) return (await this.map()).scanPage("identity-links", options);
    const index = await loadExactLinkIndex(this.root, this.manifest!.generation, businessId, this.io);
    const hasCurrentSummary = await assertRegularFile(linkSummaryPath(this.root, this.manifest!.generation, businessId));
    const hasApprovedSummary = await assertRegularFile(approvedLinkSummaryPath(this.root, this.manifest!.generation, businessId));
    if ((index !== undefined) !== hasCurrentSummary || hasCurrentSummary !== hasApprovedSummary) throw corrupt();
    const configured = new Map<string, T>();
    for (const item of options.baseItems ?? []) {
      if (options.filter && !options.filter(item)) continue;
      const family = options.collapseBy(item);
      const current = configured.get(family);
      if (!current || (options.versionOf?.(item) ?? 0) > (options.versionOf?.(current) ?? 0)) configured.set(family, item);
    }
    type Candidate = { familyKey: string; normalizedValue: string; item: T };
    const candidates: Candidate[] = [];
    for (const [familyKey, item] of configured) {
      if (options.visible && !options.visible(item)) continue;
      const normalizedValue = plainRecord(item) ? stringField(item as IndexedRecord, "normalizedValue") : "";
      candidates.push({ familyKey, normalizedValue, item });
    }
    candidates.sort((left, right) => compareOrdinal(left.normalizedValue, right.normalizedValue) || compareOrdinal(left.familyKey, right.familyKey));
    const after = options.after as unknown as IndexedRecord | undefined;
    const strict = after === undefined ? candidates : candidates.filter((candidate) => tupleCompare([candidate.normalizedValue, candidate.familyKey], [stringField(after, "normalizedValue"), stringField(after, "familyKey")]) > 0);
    const durable = await openIndexedStream<T, After>({ businessId, selector: "current", options: { ...options, offset: undefined }, io: this.io, summaryPath: linkSummaryPath(this.root, this.manifest!.generation, businessId), pagePath: (pageNumber) => linkPagePath(this.root, this.manifest!.generation, businessId, pageNumber), tuple: (item) => linkTuple(item as IndexedRecord), afterTuple: (cursor) => [stringField(cursor as unknown as IndexedRecord, "normalizedValue"), stringField(cursor as unknown as IndexedRecord, "familyKey")] });
    let memberships = await readExactMergeMembership(this.root, this.manifest!.generation, businessId, this.io, index);
    if (memberships === undefined) memberships = await readLegacyMergeMembership(this.root, this.manifest!.generation, businessId, this.io);
    const configuredFamilies = new Set(candidates.map((candidate) => candidate.familyKey));
    const durableFamilies = new Set(memberships.map((membership) => membership.familyKey));
    const approvedSummary = parseSummary(await readText(approvedLinkSummaryPath(this.root, this.manifest!.generation, businessId), this.io, { optional: true, maxBytes: maxIndexFileBytes }), businessId);
    const total = approvedSummary.total + [...configuredFamilies].filter((familyKey) => !durableFamilies.has(familyKey)).length;
    const items: T[] = [], origins: PageOrigin[] = [];
    const offset = options.offset ?? 0;
    let skipped = 0, configuredIndex = 0, stored = await durable.next();
    const emit = (item: T, origin: PageOrigin): void => { if (skipped < offset) { skipped += 1; return; } items.push(item); origins.push(origin); };
    while (items.length < options.limit && (configuredIndex < strict.length || stored !== undefined)) {
      const base = strict[configuredIndex];
      const baseTuple: string[] | undefined = base ? [base.normalizedValue, base.familyKey] : undefined;
      const storedTuple: string[] | undefined = stored && plainRecord(stored) ? linkTuple(stored as IndexedRecord) : undefined;
      const order = baseTuple && storedTuple ? tupleCompare(baseTuple, storedTuple) : baseTuple ? -1 : 1;
      if (base && order <= 0) {
        if (order < 0) { emit(base.item, "base"); configuredIndex += 1; continue; }
        configuredIndex += 1;
        const current = stored!; stored = await durable.next();
        if (options.visible && !options.visible(current)) continue;
        if (options.filter && !options.filter(current)) throw corrupt();
        emit(current, "stored");
        continue;
      }
      if (!stored || !storedTuple) throw corrupt();
      const current = stored; stored = await durable.next();
      if (options.filter && !options.filter(current)) throw corrupt();
      if (options.visible && !options.visible(current)) continue;
      emit(current, "stored");
    }
    return { items: clone(items), origins, total, groupTotals: {} };
  }
  get changed(): boolean { return this.delegate?.changed ?? false; }
  async snapshot(): Promise<StoredRecord> { return (await this.map()).snapshot; }
}

async function loadOrMigrateManifest(root: string, statePath: string, io: FileStorageHooks): Promise<StorageManifest | undefined> {
  const body = await readText(statePath, io, { optional: true });
  if (body === undefined) return undefined;
  const manifest = parseManifest(body);
  if (manifest) return manifest;
  return commitGeneration(root, statePath, parseLegacy(body), io);
}

export function createMemoryAtomicLocalStorage(): AtomicLocalStorage {
  let values: StoredRecord = {}, mutex = Promise.resolve();
  return {
    async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> { const previous = mutex; let release: () => void = () => {}; mutex = new Promise<void>((resolve) => { release = resolve; }); await previous; try { const transaction = new MapTransaction(values); const result = await fn(transaction); if (transaction.changed) values = transaction.snapshot; return result; } finally { release(); } },
    async read<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> { const transaction = new MapTransaction(values), result = await fn(transaction); if (transaction.changed) throw new Error("identity_storage_read_only"); return result; },
  };
}

export function createFileAtomicLocalStorage({ root, io = {} }: { root: string; io?: FileStorageHooks }): AtomicLocalStorage {
  const safeRoot = assertConfiguredRoot(root);
  return {
    async read<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> {
      const existingRoot = await existingPhysicalRoot(safeRoot);
      if (!existingRoot) {
        const transaction = new FileTransaction(safeRoot, undefined, io), result = await fn(transaction);
        if (transaction.changed) throw new Error("identity_storage_read_only");
        return result;
      }
      const statePath = path.join(existingRoot, "identity-local-storage.json");
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const body = await readText(statePath, io, { optional: true, maxBytes: maxIndexFileBytes, observe: false });
        if (body === undefined) {
          const transaction = new FileTransaction(existingRoot, undefined, io), result = await fn(transaction);
          if (transaction.changed) throw new Error("identity_storage_read_only");
          return result;
        }
        const manifest = parseManifest(body);
        if (!manifest) {
          io.observeRead?.({ filePath: statePath, bytes: Buffer.byteLength(body, "utf8"), records: 0 });
          const transaction = new MapTransaction(parseLegacy(body)), result = await fn(transaction);
          if (transaction.changed) throw new Error("identity_storage_read_only");
          return result;
        }
        const pin = await createReaderPin(existingRoot, manifest.generation, io);
        try {
          const confirmedBody = await readText(statePath, io, { maxBytes: maxIndexFileBytes, observe: false });
          const confirmed = parseManifest(confirmedBody!);
          if (!confirmed || confirmed.generation !== manifest.generation) continue;
          io.observeRead?.({ filePath: statePath, bytes: Buffer.byteLength(body, "utf8"), records: 0 });
          const transaction = new FileTransaction(existingRoot, manifest, io), result = await fn(transaction);
          if (transaction.changed) throw new Error("identity_storage_read_only");
          return result;
        } finally { await releaseReaderPin(pin, io); }
      }
      throw new Error("identity_storage_reader_retry_exhausted");
    },
    async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> {
    const canonicalRoot = await recheckPhysicalRoot(safeRoot);
    io.beforeMutexAcquire?.(canonicalRoot);
    return withMutex(canonicalRoot, () => {
      io.afterMutexAcquire?.(canonicalRoot);
      return withFileLock(canonicalRoot, async () => {
      const statePath = path.join(canonicalRoot, "identity-local-storage.json");
      await recheckPhysicalRoot(canonicalRoot);
      const manifest = await loadOrMigrateManifest(canonicalRoot, statePath, io);
      const transaction = new FileTransaction(canonicalRoot, manifest, io), result = await fn(transaction);
      if (transaction.changed) {
        await recheckPhysicalRoot(canonicalRoot);
        await assertRegularFile(statePath);
        await commitGeneration(canonicalRoot, statePath, await transaction.snapshot(), io, manifest?.generation);
      }
      return result;
      });
    });
    },
  };
}
