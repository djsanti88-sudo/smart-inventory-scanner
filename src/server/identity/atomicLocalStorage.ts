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
  physical?: AtomicPhysicalPage;
};
export type AtomicPage<T> = { items: T[]; origins: PageOrigin[]; total: number; groupTotals: Record<string, number>; fingerprint?: string };
export interface AtomicTransaction { get<T>(key: string): Promise<T | undefined>; scanPage?<T>(key: string, options: AtomicPageOptions<T>): Promise<AtomicPage<T>>; set<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<void> }
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
  afterGenerationFileWrite?: (filePath: string) => Promise<void>;
};

const rootMutexes = new Map<string, Promise<void>>();
const legacySchemaVersion = 1;
const manifestSchemaVersion = 2;
const recordsPerPage = 25;
const maxIndexFileBytes = 64 * 1024;
const maxExactRecordBytes = Math.floor(maxIndexFileBytes / recordsPerPage);
const generationPattern = /^[a-f0-9-]{36}$/;
const lockFileName = "identity-local-storage.lock";
const lockStaleMilliseconds = 60_000;
const lockWaitMilliseconds = 15_000;

function clone<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T; }
function plainRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function storageRoot(): string { return path.resolve(process.cwd(), ".tmp", "identity-import"); }
function mutexKey(root: string): string { return path.normalize(root).toLocaleLowerCase("en-US"); }
function corrupt(): Error { return new Error("identity_storage_corrupt"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function fullDigest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stringField(record: IndexedRecord, key: string): string { return typeof record[key] === "string" ? record[key] : ""; }
function numberField(record: IndexedRecord, key: string): number { return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : 0; }
function linkFamily(record: IndexedRecord): string { return JSON.stringify(["businessId", "sourceSystem", "vendorId", "sourceSignature", "identifierType", "namespace", "normalizedValue"].map((key) => stringField(record, key))); }
function compareIndexedLinks(left: IndexedRecord, right: IndexedRecord): number { return stringField(left, "normalizedValue").localeCompare(stringField(right, "normalizedValue")) || linkFamily(left).localeCompare(linkFamily(right)) || numberField(left, "version") - numberField(right, "version"); }
function assertBounds(options: { offset: number; limit: number }): void { if (!Number.isSafeInteger(options.offset) || options.offset < 0 || !Number.isSafeInteger(options.limit) || options.limit <= 0 || options.limit > 1_000) throw new Error("atomic page bounds are invalid"); }

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

/**
 * A preview is a read model, not a storage initializer.  Check an existing root
 * without creating it; writers recheck and materialize the root only after the
 * callback has actually staged a mutation.
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
  const key = mutexKey(root), previous = rootMutexes.get(key) ?? Promise.resolve();
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
  async scanPage<T>(key: string, options: AtomicPageOptions<T>): Promise<AtomicPage<T>> {
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
    const groupTotals: Record<string, number> = {}, retained: PageEntry[] = [], fingerprintItems: T[] = [], retainCount = options.offset + options.limit;
    let total = 0;
    for (const entry of source) {
      const item = entry.item;
      if (!options.collapseBy && options.filter && !options.filter(item)) continue;
      if (options.physical?.kind === "identity-links" && options.physical.mode === "current") fingerprintItems.push(item);
      const group = options.groupBy?.(item); if (group !== undefined) groupTotals[group] = (groupTotals[group] ?? 0) + 1;
      if (options.visible && !options.visible(item)) continue;
      total += 1;
      let low = 0, high = retained.length;
      while (low < high) { const middle = (low + high) >>> 1; if (options.compare(retained[middle]!.item, item) <= 0) low = middle + 1; else high = middle; }
      retained.splice(low, 0, entry); if (retained.length > retainCount) retained.pop();
    }
    const selected = retained.slice(options.offset, options.offset + options.limit);
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
async function createReaderPin(root: string, generation: string): Promise<{ filePath: string; body: string }> {
  const owner: ReaderPinOwner = { token: randomUUID(), pid: process.pid, generation };
  const filePath = path.join(root, readerPinFileName(generation, owner.token)), body = JSON.stringify(owner);
  await syncFile(filePath, body);
  return { filePath, body };
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
function exactLinkDataPath(root: string, generation: string, businessId: string): string { return generationPath(root, generation, `links.${businessToken(businessId)}.exact.data`); }

type ExactLinkIndexEntry = { familyHash: string; status: string; normalizedValue: string; offset: number; length: number };
type ExactLinkIndex = {
  schemaVersion: 1;
  mergeAlgorithmVersion: "identity-links-merge-v1";
  orderAlgorithmVersion: "identity-links-order-v1";
  businessId: string;
  entries: ExactLinkIndexEntry[];
};
type ExactLinkIndexDisk = Omit<ExactLinkIndex, "entries"> & { entries: Array<[string, string, string, number, number]> };

function pageBody(items: readonly unknown[]): string {
  const body = JSON.stringify({ version: 1, items });
  if (Buffer.byteLength(body, "utf8") > maxIndexFileBytes) throw new Error("identity_storage_index_page_too_large");
  return body;
}
function chunks<T>(items: readonly T[]): T[][] { const pages: T[][] = []; for (let index = 0; index < items.length; index += recordsPerPage) pages.push(items.slice(index, index + recordsPerPage)); return pages; }
async function writeImmutable(filePath: string, body: string, io: FileStorageHooks): Promise<void> {
  await syncFile(filePath, body);
  await io.afterGenerationFileWrite?.(filePath);
}

async function writeReviewIndexes(root: string, generation: string, values: StoredRecord, io: FileStorageHooks): Promise<void> {
  const reviews = Array.isArray(values["identity-reviews"]) ? values["identity-reviews"].filter(plainRecord) as IndexedRecord[] : [];
  const businesses = new Map<string, IndexedRecord[]>();
  for (const review of reviews) {
    const businessId = stringField(review, "businessId");
    if (!businessId || review.resolution) continue;
    businesses.set(businessId, [...(businesses.get(businessId) ?? []), review]);
  }
  for (const [businessId, scoped] of businesses) {
    scoped.sort((left, right) => stringField(left, "reviewId").localeCompare(stringField(right, "reviewId")));
    const bucketTotals: Record<string, number> = {};
    const byBucket = new Map<string, IndexedRecord[]>();
    for (const review of scoped) {
      const decision = plainRecord(review.decision) ? review.decision : {};
      const bucket = stringField(decision as IndexedRecord, "kind");
      bucketTotals[bucket] = (bucketTotals[bucket] ?? 0) + 1;
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), review]);
    }
    await writeImmutable(reviewSummaryPath(root, generation, businessId), JSON.stringify({ version: 1, businessId, total: scoped.length, bucketTotals }), io);
    for (const [selector, records] of [["*", scoped] as const, ...[...byBucket.entries()]]) {
      const pages = chunks(records);
      for (let index = 0; index < pages.length; index += 1) await writeImmutable(reviewPagePath(root, generation, businessId, selector, index), pageBody(pages[index]!), io);
    }
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
    await writeImmutable(linkSummaryPath(root, generation, businessId), JSON.stringify({ version: 1, businessId, total: links.length, fingerprint: fullDigest(JSON.stringify(links)) }), io);
    const pages = chunks(links);
    for (let index = 0; index < pages.length; index += 1) await writeImmutable(linkPagePath(root, generation, businessId, index), pageBody(pages[index]!), io);
    const approved = links.filter((link) => stringField(link, "status") === "approved");
    await writeImmutable(approvedLinkSummaryPath(root, generation, businessId), JSON.stringify({ version: 1, businessId, total: approved.length }), io);
    const approvedPages = chunks(approved);
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
      entries.push({ familyHash, status: stringField(link, "status"), normalizedValue: stringField(link, "normalizedValue"), offset, length });
      dataParts.push(body);
      offset += length;
    }
    const index: ExactLinkIndexDisk = {
      schemaVersion: 1,
      mergeAlgorithmVersion: "identity-links-merge-v1",
      orderAlgorithmVersion: "identity-links-order-v1",
      businessId,
      entries: entries.map((entry) => [entry.familyHash, entry.status, entry.normalizedValue, entry.offset, entry.length]),
    };
    const indexBody = JSON.stringify(index);
    if (Buffer.byteLength(indexBody, "utf8") > maxIndexFileBytes) throw new Error("identity_storage_exact_index_too_large");
    await writeImmutable(exactLinkDataPath(root, generation, businessId), dataParts.join(""), io);
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

function parseSummary(body: string | undefined, businessId: string): { total: number; bucketTotals: Record<string, number>; fingerprint?: string } {
  if (body === undefined) return { total: 0, bucketTotals: {} };
  const parsed = parseJson(body);
  if (!plainRecord(parsed) || parsed.version !== 1 || parsed.businessId !== businessId || typeof parsed.total !== "number" || !Number.isSafeInteger(parsed.total) || parsed.total < 0 || (parsed.bucketTotals !== undefined && !plainRecord(parsed.bucketTotals)) || (parsed.fingerprint !== undefined && (typeof parsed.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(parsed.fingerprint)))) throw corrupt();
  return { total: parsed.total, bucketTotals: (parsed.bucketTotals ?? {}) as Record<string, number>, ...(typeof parsed.fingerprint === "string" ? { fingerprint: parsed.fingerprint } : {}) };
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
  if (!plainRecord(parsed) || parsed.schemaVersion !== 1 || parsed.mergeAlgorithmVersion !== "identity-links-merge-v1"
    || parsed.orderAlgorithmVersion !== "identity-links-order-v1" || parsed.businessId !== businessId || !Array.isArray(parsed.entries)) throw corrupt();
  const entries: ExactLinkIndexEntry[] = [];
  let previousEnd = 0;
  for (const raw of parsed.entries) {
    if (!Array.isArray(raw) || raw.length !== 5 || typeof raw[0] !== "string" || !/^[a-f0-9]{32}$/.test(raw[0])
      || typeof raw[1] !== "string" || typeof raw[2] !== "string"
      || !Number.isSafeInteger(raw[3]) || (raw[3] as number) < previousEnd
      || !Number.isSafeInteger(raw[4]) || (raw[4] as number) <= 0 || (raw[4] as number) > maxExactRecordBytes) throw corrupt();
    entries.push({ familyHash: raw[0], status: raw[1], normalizedValue: raw[2], offset: raw[3] as number, length: raw[4] as number });
    previousEnd = (raw[3] as number) + (raw[4] as number);
  }
  return { schemaVersion: 1, mergeAlgorithmVersion: "identity-links-merge-v1", orderAlgorithmVersion: "identity-links-order-v1", businessId, entries };
}

async function readExactLinkRecords<T>(root: string, generation: string, businessId: string, entries: readonly ExactLinkIndexEntry[], io: FileStorageHooks): Promise<Map<string, T>> {
  if (entries.length === 0) return new Map();
  if (entries.length > recordsPerPage) throw corrupt();
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
      if (!plainRecord(parsed) || digest(linkFamily(parsed as IndexedRecord)) !== entry.familyHash) throw corrupt();
      io.observeRead?.({ filePath, bytes: entry.length, records: 1 });
      result.set(entry.familyHash, parsed as T);
    }
  } finally { await handle.close(); }
  return result;
}

async function loadExactLinkIndex(root: string, generation: string, businessId: string, io: FileStorageHooks): Promise<ExactLinkIndex | undefined> {
  return parseExactLinkIndex(await readText(exactLinkIndexPath(root, generation, businessId), io, { optional: true, maxBytes: maxIndexFileBytes }), businessId);
}

async function readIndexedPage<T>({ businessId, selector, options, io, summaryPath, pagePath }: { businessId: string; selector?: string; options: AtomicPageOptions<T>; io: FileStorageHooks; summaryPath: string; pagePath: (pageNumber: number) => string }): Promise<AtomicPage<T>> {
  const summaryBody = await readText(summaryPath, io, { optional: true, maxBytes: maxIndexFileBytes });
  const summary = parseSummary(summaryBody, businessId), total = selector && selector !== "*" ? summary.bucketTotals[selector] ?? 0 : summary.total;
  const firstPage = Math.floor(options.offset / recordsPerPage), lastPage = Math.floor((options.offset + options.limit - 1) / recordsPerPage), loaded: T[] = [];
  for (let pageNumber = firstPage; pageNumber <= lastPage && pageNumber * recordsPerPage < total; pageNumber += 1) {
    const filePath = pagePath(pageNumber), body = await readText(filePath, io, { optional: false, maxBytes: maxIndexFileBytes, observe: false });
    const page = parsePage<T>(body);
    io.observeRead?.({ filePath, bytes: Buffer.byteLength(body!, "utf8"), records: page.length });
    loaded.push(...page);
  }
  const withinFirst = options.offset - firstPage * recordsPerPage;
  const items = loaded.slice(withinFirst, withinFirst + options.limit);
  return { items: clone(items), origins: items.map(() => "stored"), total, groupTotals: summary.bucketTotals, ...(summary.fingerprint ? { fingerprint: summary.fingerprint } : {}) };
}

class FileTransaction implements AtomicTransaction {
  private delegate?: MapTransaction;
  constructor(private readonly root: string, private readonly manifest: StorageManifest | undefined, private readonly io: FileStorageHooks) {}
  private async map(): Promise<MapTransaction> { if (!this.delegate) this.delegate = new MapTransaction(this.manifest ? await loadState(this.root, this.manifest, this.io) : {}); return this.delegate; }
  async get<T>(key: string): Promise<T | undefined> { return (await this.map()).get<T>(key); }
  async set<T>(key: string, value: T): Promise<void> { return (await this.map()).set(key, value); }
  async delete(key: string): Promise<void> { return (await this.map()).delete(key); }
  async scanPage<T>(key: string, options: AtomicPageOptions<T>): Promise<AtomicPage<T>> {
    assertBounds(options);
    if (!this.manifest || !options.physical || this.delegate?.changed) return (await this.map()).scanPage(key, options);
    const physical = options.physical;
    if (physical.kind === "identity-reviews" && key === "identity-reviews") {
      const selector = physical.bucket ?? "*";
      return readIndexedPage({ businessId: physical.businessId, selector, options, io: this.io, summaryPath: reviewSummaryPath(this.root, this.manifest.generation, physical.businessId), pagePath: (pageNumber) => reviewPagePath(this.root, this.manifest!.generation, physical.businessId, selector, pageNumber) });
    }
    if (physical.kind === "identity-links" && key === "identity-links" && physical.mode === "current") {
      return readIndexedPage({ businessId: physical.businessId, options, io: this.io, summaryPath: linkSummaryPath(this.root, this.manifest.generation, physical.businessId), pagePath: (pageNumber) => linkPagePath(this.root, this.manifest!.generation, physical.businessId, pageNumber) });
    }
    if (physical.kind === "identity-links" && key === "identity-links" && physical.mode === "families") {
      const index = await loadExactLinkIndex(this.root, this.manifest.generation, physical.businessId, this.io);
      if (!index) return { items: [], origins: [], total: 0, groupTotals: {} };
      const requestedByHash = new Map(physical.families.slice(0, recordsPerPage).map((family) => [digest(family), family]));
      const selectedEntries = index.entries.filter((entry) => requestedByHash.has(entry.familyHash)).slice(0, recordsPerPage);
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
      const selected = found.slice(options.offset, options.offset + options.limit);
      return { items: clone(selected), origins: selected.map(() => "stored"), total: found.length, groupTotals: {} };
    }
    if (physical.kind === "identity-links" && key === "identity-links" && physical.mode === "authoritative") return this.authoritative(options, physical.businessId);
    return (await this.map()).scanPage(key, options);
  }
  private async authoritative<T>(options: AtomicPageOptions<T>, businessId: string): Promise<AtomicPage<T>> {
    if ((options.baseItems?.length ?? 0) === 0) {
      return readIndexedPage({ businessId, options, io: this.io, summaryPath: approvedLinkSummaryPath(this.root, this.manifest!.generation, businessId), pagePath: (pageNumber) => approvedLinkPagePath(this.root, this.manifest!.generation, businessId, pageNumber) });
    }
    if (!options.collapseBy) return (await this.map()).scanPage("identity-links", options);
    const index = await loadExactLinkIndex(this.root, this.manifest!.generation, businessId, this.io);
    const durableFamilies = new Set(index?.entries.map((entry) => entry.familyHash) ?? []);
    const configured = new Map<string, T>();
    for (const item of options.baseItems ?? []) {
      if (options.filter && !options.filter(item)) continue;
      const family = options.collapseBy(item), familyHash = digest(family);
      if (durableFamilies.has(familyHash)) continue;
      const current = configured.get(familyHash);
      if (!current || (options.versionOf?.(item) ?? 0) > (options.versionOf?.(current) ?? 0)) configured.set(familyHash, item);
    }
    type Descriptor = { familyHash: string; normalizedValue: string; origin: PageOrigin; item?: T; entry?: ExactLinkIndexEntry };
    const descriptors: Descriptor[] = [];
    for (const [familyHash, item] of configured) {
      if (options.visible && !options.visible(item)) continue;
      const normalizedValue = plainRecord(item) ? stringField(item as IndexedRecord, "normalizedValue") : "";
      descriptors.push({ familyHash, normalizedValue, origin: "base", item });
    }
    for (const entry of index?.entries ?? []) if (entry.status === "approved") descriptors.push({ familyHash: entry.familyHash, normalizedValue: entry.normalizedValue, origin: "stored", entry });
    descriptors.sort((left, right) => left.normalizedValue.localeCompare(right.normalizedValue) || left.familyHash.localeCompare(right.familyHash));
    const selected = descriptors.slice(options.offset, options.offset + options.limit);
    const storedEntries = selected.flatMap((descriptor) => descriptor.entry ? [descriptor.entry] : []);
    const records = await readExactLinkRecords<T>(this.root, this.manifest!.generation, businessId, storedEntries, this.io);
    const items: T[] = [], origins: PageOrigin[] = [];
    for (const descriptor of selected) {
      const item = descriptor.item ?? records.get(descriptor.familyHash);
      if (!item || (options.filter && !options.filter(item)) || (options.visible && !options.visible(item))) throw corrupt();
      items.push(item); origins.push(descriptor.origin);
    }
    return { items: clone(items), origins, total: descriptors.length, groupTotals: {} };
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
        const pin = await createReaderPin(existingRoot, manifest.generation);
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
    const existingRoot = await existingPhysicalRoot(safeRoot);
    // Do not create a directory merely to serve an empty preview from a root
    // that has never received a durable write.
    if (!existingRoot) {
      const probe = new FileTransaction(safeRoot, undefined, io), probeResult = await fn(probe);
      if (!probe.changed) return probeResult;
      const canonicalRoot = await recheckPhysicalRoot(safeRoot);
      return withMutex(canonicalRoot, () => withFileLock(canonicalRoot, async () => {
        const statePath = path.join(canonicalRoot, "identity-local-storage.json");
        const manifest = await loadOrMigrateManifest(canonicalRoot, statePath, io);
        const latest = new FileTransaction(canonicalRoot, manifest, io);
        // The root may have been initialized by another process after the
        // write probe. Re-evaluate against the locked latest snapshot instead
        // of replaying a whole stale top-level value over that committed work.
        const result = await fn(latest);
        if (latest.changed) await commitGeneration(canonicalRoot, statePath, await latest.snapshot(), io, manifest?.generation);
        return result;
      }));
    }
    const canonicalRoot = existingRoot;
    return withMutex(canonicalRoot, () => withFileLock(canonicalRoot, async () => {
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
    }));
    },
  };
}
