import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
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
export type AtomicPage<T> = { items: T[]; origins: PageOrigin[]; total: number; groupTotals: Record<string, number> };
export interface AtomicTransaction { get<T>(key: string): Promise<T | undefined>; scanPage?<T>(key: string, options: AtomicPageOptions<T>): Promise<AtomicPage<T>>; set<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<void> }
export interface AtomicLocalStorage { transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> }

export type FileReadObservation = { filePath: string; bytes: number; records: number };
type FileStorageHooks = {
  writeTemp?: (filePath: string, body: string) => Promise<void>;
  replace?: (tempPath: string, statePath: string) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<void>;
  observeRead?: (observation: FileReadObservation) => void;
};

const rootMutexes = new Map<string, Promise<void>>();
const legacySchemaVersion = 1;
const manifestSchemaVersion = 2;
const recordsPerPage = 25;
const maxIndexFileBytes = 64 * 1024;
const generationPattern = /^[a-f0-9-]{36}$/;

function clone<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T; }
function plainRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function storageRoot(): string { return path.resolve(process.cwd(), ".tmp", "identity-import"); }
function mutexKey(root: string): string { return path.normalize(root).toLocaleLowerCase("en-US"); }
function corrupt(): Error { return new Error("identity_storage_corrupt"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
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
function linkFamilyPath(root: string, generation: string, businessId: string, family: string): string { return generationPath(root, generation, `links.${businessToken(businessId)}.family.${digest(family)}`); }
function authoritativeToken<T>(businessId: string, items: readonly T[]): string { return digest(`${businessId}\n${JSON.stringify(items)}`); }
function authoritativeSummaryPath(root: string, generation: string, token: string): string { return generationPath(root, generation, `links.authoritative.${token}.summary`); }
function authoritativePagePath(root: string, generation: string, token: string, pageNumber: number): string { return generationPath(root, generation, `links.authoritative.${token}.${pageNumber}`); }

function pageBody(items: readonly unknown[]): string {
  const body = JSON.stringify({ version: 1, items });
  if (Buffer.byteLength(body, "utf8") > maxIndexFileBytes) throw new Error("identity_storage_index_page_too_large");
  return body;
}
function chunks<T>(items: readonly T[]): T[][] { const pages: T[][] = []; for (let index = 0; index < items.length; index += recordsPerPage) pages.push(items.slice(index, index + recordsPerPage)); return pages; }
async function writeImmutable(filePath: string, body: string): Promise<void> { await syncFile(filePath, body); }

async function writeReviewIndexes(root: string, generation: string, values: StoredRecord): Promise<void> {
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
    await writeImmutable(reviewSummaryPath(root, generation, businessId), JSON.stringify({ version: 1, businessId, total: scoped.length, bucketTotals }));
    for (const [selector, records] of [["*", scoped] as const, ...[...byBucket.entries()]]) {
      const pages = chunks(records);
      for (let index = 0; index < pages.length; index += 1) await writeImmutable(reviewPagePath(root, generation, businessId, selector, index), pageBody(pages[index]!));
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

async function writeLinkIndexes(root: string, generation: string, values: StoredRecord): Promise<void> {
  for (const [businessId, links] of currentLinks(values)) {
    await writeImmutable(linkSummaryPath(root, generation, businessId), JSON.stringify({ version: 1, businessId, total: links.length }));
    const pages = chunks(links);
    for (let index = 0; index < pages.length; index += 1) await writeImmutable(linkPagePath(root, generation, businessId, index), pageBody(pages[index]!));
    const approved = links.filter((link) => stringField(link, "status") === "approved");
    await writeImmutable(approvedLinkSummaryPath(root, generation, businessId), JSON.stringify({ version: 1, businessId, total: approved.length }));
    const approvedPages = chunks(approved);
    for (let index = 0; index < approvedPages.length; index += 1) await writeImmutable(approvedLinkPagePath(root, generation, businessId, index), pageBody(approvedPages[index]!));
    for (const link of links) await writeImmutable(linkFamilyPath(root, generation, businessId, linkFamily(link)), pageBody([{ family: linkFamily(link), item: link }]));
  }
}

async function cleanupOldGenerations(root: string, keep: ReadonlySet<string>): Promise<void> {
  const pattern = /^identity-local-storage\.([a-f0-9-]{36})\..+\.json$/;
  await Promise.all((await readdir(root)).map(async (name) => {
    const generation = pattern.exec(name)?.[1];
    if (!generation || keep.has(generation)) return;
    const target = path.join(root, name);
    if (path.dirname(target) !== root) throw new Error("identity generation cleanup escaped storage root");
    await rm(target, { force: true });
  }));
}

async function commitGeneration(root: string, statePath: string, values: StoredRecord, io: FileStorageHooks, previousGeneration?: string): Promise<StorageManifest> {
  const generation = randomUUID(), manifest: StorageManifest = { version: manifestSchemaVersion, generation };
  await writeImmutable(generationPath(root, generation, "state"), JSON.stringify({ version: legacySchemaVersion, values } satisfies LegacyEnvelope));
  await writeReviewIndexes(root, generation, values);
  await writeLinkIndexes(root, generation, values);
  await (io.syncDirectory ?? syncDirectory)(root);
  const temp = path.join(root, `identity-local-storage.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await (io.writeTemp ?? syncFile)(temp, JSON.stringify(manifest));
    await (io.replace ?? rename)(temp, statePath);
    await (io.syncDirectory ?? syncDirectory)(root);
  } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  await cleanupOldGenerations(root, new Set([generation, ...(previousGeneration ? [previousGeneration] : [])])).catch(() => undefined);
  return manifest;
}

async function loadState(root: string, manifest: StorageManifest, io: FileStorageHooks): Promise<StoredRecord> {
  const body = await readText(generationPath(root, manifest.generation, "state"), io);
  return parseLegacy(body!);
}

function parseSummary(body: string | undefined, businessId: string): { total: number; bucketTotals: Record<string, number> } {
  if (body === undefined) return { total: 0, bucketTotals: {} };
  const parsed = parseJson(body);
  if (!plainRecord(parsed) || parsed.version !== 1 || parsed.businessId !== businessId || typeof parsed.total !== "number" || !Number.isSafeInteger(parsed.total) || parsed.total < 0 || (parsed.bucketTotals !== undefined && !plainRecord(parsed.bucketTotals))) throw corrupt();
  return { total: parsed.total, bucketTotals: (parsed.bucketTotals ?? {}) as Record<string, number> };
}
function parsePage<T>(body: string | undefined): T[] {
  if (body === undefined) return [];
  const parsed = parseJson(body);
  if (!plainRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.items) || parsed.items.length > recordsPerPage) throw corrupt();
  return parsed.items as T[];
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
  return { items: clone(items), origins: items.map(() => "stored"), total, groupTotals: summary.bucketTotals };
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
      const found: T[] = [];
      for (const family of physical.families.slice(0, 25)) {
        const filePath = linkFamilyPath(this.root, this.manifest.generation, physical.businessId, family), body = await readText(filePath, this.io, { optional: true, maxBytes: maxIndexFileBytes, observe: false });
        if (!body) continue;
        const wrapped = parsePage<{ family: string; item: T }>(body);
        this.io.observeRead?.({ filePath, bytes: Buffer.byteLength(body, "utf8"), records: wrapped.length });
        const entry = wrapped[0]; if (!entry || entry.family !== family) throw corrupt(); found.push(entry.item);
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
    const token = authoritativeToken(businessId, options.baseItems ?? []), summaryPath = authoritativeSummaryPath(this.root, this.manifest!.generation, token);
    const summaryBody = await readText(summaryPath, this.io, { optional: true, maxBytes: maxIndexFileBytes });
    if (!summaryBody) {
      const durableSummaryBody = await readText(linkSummaryPath(this.root, this.manifest!.generation, businessId), this.io, { optional: true, maxBytes: maxIndexFileBytes });
      const durableSummary = parseSummary(durableSummaryBody, businessId), durable: T[] = [];
      for (let pageNumber = 0; pageNumber * recordsPerPage < durableSummary.total; pageNumber += 1) {
        const filePath = linkPagePath(this.root, this.manifest!.generation, businessId, pageNumber), body = await readText(filePath, this.io, { maxBytes: maxIndexFileBytes, observe: false });
        const page = parsePage<T>(body); this.io.observeRead?.({ filePath, bytes: Buffer.byteLength(body!, "utf8"), records: page.length }); durable.push(...page);
      }
      const merged = new Map<string, { item: T; origin: PageOrigin }>();
      for (const item of options.baseItems ?? []) { if (!options.filter || options.filter(item)) { const family = options.collapseBy!(item), current = merged.get(family); if (!current || (options.versionOf?.(item) ?? 0) > (options.versionOf?.(current.item) ?? 0)) merged.set(family, { item, origin: "base" }); } }
      for (const item of durable) if (!options.filter || options.filter(item)) merged.set(options.collapseBy!(item), { item, origin: "stored" });
      const effective = [...merged.values()].filter((entry) => !options.visible || options.visible(entry.item)).sort((left, right) => options.compare(left.item, right.item));
      const pages = chunks(effective);
      for (let pageNumber = 0; pageNumber < pages.length; pageNumber += 1) await writeImmutable(authoritativePagePath(this.root, this.manifest!.generation, token, pageNumber), pageBody(pages[pageNumber]!));
      await writeImmutable(summaryPath, JSON.stringify({ version: 1, businessId, total: effective.length }));
      await syncDirectory(this.root);
      const selected = effective.slice(options.offset, options.offset + options.limit);
      return { items: clone(selected.map((entry) => entry.item)), origins: selected.map((entry) => entry.origin), total: effective.length, groupTotals: {} };
    }
    const page = await readIndexedPage<{ item: T; origin: PageOrigin }>({ businessId, options: { offset: options.offset, limit: options.limit, compare: (left, right) => options.compare(left.item, right.item) }, io: this.io, summaryPath, pagePath: (pageNumber) => authoritativePagePath(this.root, this.manifest!.generation, token, pageNumber) });
    return { items: page.items.map((entry) => entry.item), origins: page.items.map((entry) => entry.origin), total: page.total, groupTotals: {} };
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
  return { async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> { const previous = mutex; let release: () => void = () => {}; mutex = new Promise<void>((resolve) => { release = resolve; }); await previous; try { const transaction = new MapTransaction(values); const result = await fn(transaction); if (transaction.changed) values = transaction.snapshot; return result; } finally { release(); } } };
}

export function createFileAtomicLocalStorage({ root, io = {} }: { root: string; io?: FileStorageHooks }): AtomicLocalStorage {
  const safeRoot = assertConfiguredRoot(root);
  return { async transaction<T>(fn: (transaction: AtomicTransaction) => Promise<T>): Promise<T> {
    const canonicalRoot = await recheckPhysicalRoot(safeRoot);
    return withMutex(canonicalRoot, async () => {
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
  } };
}
