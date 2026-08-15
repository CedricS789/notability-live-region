import { createHash } from "node:crypto";
import type { App, DataAdapter, Stat } from "obsidian";
import { canonicalRegionJson, type NotabilityRegionV1 } from "./model";

export type CacheSettings = {
  maxCacheMiB: number;
};

export const CACHE_INDEX_VERSION = 1 as const;
export const PREVIEW_CAPTURE_VERSION = 5 as const;
export const DEFAULT_MAX_CACHE_MIB = 5120;
const ACCESS_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REGION_ID_PATTERN = /^nr-[a-z0-9-]{8,}$/;
const REGION_FILE_PATTERN = /(?:^|\/)(nr-[a-z0-9-]{8,})\.png$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type PreviewCaptureInput = {
  captureVersion: number;
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  chosenScale: number;
  availableScales: readonly number[];
  capturedAt: string;
};

export type PreviewDescriptor = PreviewCaptureInput & {
  regionId: string;
  url: string;
  canonicalRegionHash: string | null;
  bytes: number;
  lastAccessedAt: string;
};

export type PreviewSnapshot = {
  descriptor: PreviewDescriptor;
  data: ArrayBuffer;
};

export type CacheIndexEntry = Omit<PreviewDescriptor, "url" | "availableScales"> & {
  file: string;
  availableScales: number[];
};

export type CacheIndexV1 = {
  version: typeof CACHE_INDEX_VERSION;
  entries: Record<string, CacheIndexEntry>;
};

export type CacheFailure = {
  path: string;
  operation: "list" | "read" | "stat" | "remove" | "write-index";
  message: string;
};

export type CacheStats = {
  count: number;
  bytes: number;
  unknownFiles: number;
  failures: CacheFailure[];
};

export type CachePruneResult = {
  removed: number;
  bytesRemoved: number;
  remaining: number;
  remainingBytes: number;
  failures: CacheFailure[];
};

export type CacheClearResult = {
  recognized: number;
  removed: number;
  bytesRemoved: number;
  preservedUnknownFiles: number;
  failures: CacheFailure[];
};

type LoadedIndex = {
  index: CacheIndexV1;
  failures: CacheFailure[];
  unknownFiles: number;
};

type ListedCacheFiles = Awaited<ReturnType<DataAdapter["list"]>>;

function failure(path: string, operation: CacheFailure["operation"], error: unknown): CacheFailure {
  return {
    path,
    operation,
    message: error instanceof Error ? error.message : String(error)
  };
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveInteger(value: unknown): value is number {
  return finitePositive(value) && Number.isInteger(value);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function canonicalRegionHash(region: NotabilityRegionV1): string {
  return `sha256:${createHash("sha256").update(canonicalRegionJson(region), "utf8").digest("hex")}`;
}

function normalizeCaptureInput(input: PreviewCaptureInput): PreviewCaptureInput {
  if (!Number.isInteger(input.captureVersion) || input.captureVersion < 1) {
    throw new Error("captureVersion must be a positive integer.");
  }
  if (!finitePositive(input.cssWidth) || !finitePositive(input.cssHeight)) {
    throw new Error("Preview CSS dimensions must be positive finite numbers.");
  }
  if (!positiveInteger(input.pixelWidth) || !positiveInteger(input.pixelHeight)) {
    throw new Error("Preview pixel dimensions must be positive integers.");
  }
  if (!finitePositive(input.chosenScale)) throw new Error("chosenScale must be positive.");
  if (!input.availableScales.length || !input.availableScales.every(finitePositive)) {
    throw new Error("availableScales must contain only positive finite numbers.");
  }
  const availableScales = [...new Set(input.availableScales)].sort((left, right) => left - right);
  if (!availableScales.some((scale) => Math.abs(scale - input.chosenScale) <= 0.000001)) {
    throw new Error("availableScales must include chosenScale.");
  }
  if (!validIsoDate(input.capturedAt)) throw new Error("capturedAt must be an ISO date.");
  return {
    captureVersion: input.captureVersion,
    cssWidth: input.cssWidth,
    cssHeight: input.cssHeight,
    pixelWidth: input.pixelWidth,
    pixelHeight: input.pixelHeight,
    chosenScale: input.chosenScale,
    availableScales,
    capturedAt: new Date(input.capturedAt).toISOString()
  };
}

function parseIndexEntry(id: string, value: unknown): CacheIndexEntry | null {
  if (!REGION_ID_PATTERN.test(id) || !value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const file = `${id}.png`;
  const hash = entry.canonicalRegionHash;
  const availableScales = entry.availableScales;
  if (
    entry.regionId !== id
    || entry.file !== file
    || (!SHA256_PATTERN.test(String(hash)) && hash !== null)
    || !Number.isInteger(entry.bytes) || (entry.bytes as number) < 0
    || !Number.isInteger(entry.captureVersion) || (entry.captureVersion as number) < 0
    || !finitePositive(entry.cssWidth)
    || !finitePositive(entry.cssHeight)
    || !positiveInteger(entry.pixelWidth)
    || !positiveInteger(entry.pixelHeight)
    || !finitePositive(entry.chosenScale)
    || !Array.isArray(availableScales)
    || !availableScales.length
    || !availableScales.every(finitePositive)
    || !availableScales.some((scale) => Math.abs(scale - (entry.chosenScale as number)) <= 0.000001)
    || !validIsoDate(entry.capturedAt)
    || !validIsoDate(entry.lastAccessedAt)
  ) return null;
  return {
    regionId: id,
    file,
    canonicalRegionHash: hash as string | null,
    bytes: entry.bytes as number,
    captureVersion: entry.captureVersion as number,
    cssWidth: entry.cssWidth,
    cssHeight: entry.cssHeight,
    pixelWidth: entry.pixelWidth,
    pixelHeight: entry.pixelHeight,
    chosenScale: entry.chosenScale,
    availableScales: [...new Set(availableScales)].sort((left, right) => left - right),
    capturedAt: new Date(entry.capturedAt).toISOString(),
    lastAccessedAt: new Date(entry.lastAccessedAt).toISOString()
  };
}

function parseIndex(value: unknown): CacheIndexV1 | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== CACHE_INDEX_VERSION || !record.entries || typeof record.entries !== "object" || Array.isArray(record.entries)) {
    return null;
  }
  const entries: Record<string, CacheIndexEntry> = {};
  for (const [id, rawEntry] of Object.entries(record.entries as Record<string, unknown>)) {
    const entry = parseIndexEntry(id, rawEntry);
    if (entry) entries[id] = entry;
  }
  return { version: CACHE_INDEX_VERSION, entries };
}

function pngDimensions(bytes: ArrayBuffer): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const view = new DataView(bytes);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => view.getUint8(index) === byte)) return null;
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : null;
}

function maxCacheBytes(settings: CacheSettings): number {
  const configured = settings.maxCacheMiB;
  const mib = Number.isFinite(configured) && configured >= 1 ? configured : DEFAULT_MAX_CACHE_MIB;
  return Math.floor(mib * 1024 * 1024);
}

function sortedIndex(index: CacheIndexV1): CacheIndexV1 {
  const entries = Object.fromEntries(
    Object.entries(index.entries).sort(([left], [right]) => left.localeCompare(right))
  );
  return { version: CACHE_INDEX_VERSION, entries };
}

function recognizedRegionId(path: string): string | null {
  return REGION_FILE_PATTERN.exec(path.replaceAll("\\", "/"))?.[1] ?? null;
}

export class RegionCache {
  private readonly cacheRoot: string;
  private readonly cacheIndexPath: string;
  private readonly cacheIndexTempPath: string;
  private index: CacheIndexV1 | null = null;
  private initializationFailures: CacheFailure[] = [];
  private unknownFiles = 0;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly runtimeAccessOrder = new Map<string, number>();
  private nextRuntimeAccessOrder = 0;

  constructor(
    private readonly app: App,
    private readonly settings: () => CacheSettings,
    cacheRoot: string
  ) {
    const normalizedRoot = cacheRoot.replaceAll("\\", "/").replace(/\/+$/g, "");
    if (!normalizedRoot || normalizedRoot.startsWith("/") || /^[A-Za-z]:\//.test(normalizedRoot)) {
      throw new Error("Region cache root must be a vault-relative path.");
    }
    this.cacheRoot = normalizedRoot;
    this.cacheIndexPath = `${normalizedRoot}/index.json`;
    this.cacheIndexTempPath = `${normalizedRoot}/index.json.tmp`;
  }

  path(id: string): string {
    if (!REGION_ID_PATTERN.test(id)) throw new Error("Invalid region cache identity.");
    return `${this.cacheRoot}/${id}.png`;
  }

  async ensureRoot(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.cacheRoot))) await this.app.vault.adapter.mkdir(this.cacheRoot);
  }

  async put(region: NotabilityRegionV1, bytes: Uint8Array, input: PreviewCaptureInput): Promise<PreviewDescriptor | null> {
    return this.exclusive(async () => {
      const capture = normalizeCaptureInput(input);
      const loaded = await this.ensureIndex();
      const path = this.path(region.id);
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const dimensions = pngDimensions(arrayBuffer);
      if (!dimensions || dimensions.width !== capture.pixelWidth || dimensions.height !== capture.pixelHeight) {
        throw new Error("Encoded PNG dimensions do not match the preview descriptor.");
      }
      await this.app.vault.adapter.writeBinary(
        path,
        arrayBuffer
      );
      const entry: CacheIndexEntry = {
        regionId: region.id,
        file: `${region.id}.png`,
        canonicalRegionHash: canonicalRegionHash(region),
        bytes: bytes.byteLength,
        ...capture,
        availableScales: [...capture.availableScales],
        lastAccessedAt: capture.capturedAt
      };
      loaded.index.entries[region.id] = entry;
      this.touchRuntimeAccess(region.id);
      const pruneResult = await this.pruneLoaded(loaded.index, maxCacheBytes(this.settings()));
      await this.writeIndex(loaded.index);
      if (!loaded.index.entries[region.id]) return null;
      if (pruneResult.failures.length) this.initializationFailures.push(...pruneResult.failures);
      return this.descriptor(entry);
    });
  }

  async get(region: NotabilityRegionV1, now = Date.now()): Promise<PreviewDescriptor | null> {
    return this.exclusive(async () => {
      const loaded = await this.ensureIndex();
      const entry = loaded.index.entries[region.id];
      if (!entry || !(await this.app.vault.adapter.exists(this.path(region.id)))) return null;
      const hash = canonicalRegionHash(region);
      if (entry.canonicalRegionHash !== null && entry.canonicalRegionHash !== hash) return null;

      let changed = false;
      if (entry.canonicalRegionHash === null) {
        entry.canonicalRegionHash = hash;
        changed = true;
      }
      const previousAccess = Date.parse(entry.lastAccessedAt);
      if (!Number.isFinite(previousAccess) || now - previousAccess >= ACCESS_TOUCH_INTERVAL_MS) {
        entry.lastAccessedAt = new Date(now).toISOString();
        changed = true;
      }
      if (changed) await this.writeIndex(loaded.index);
      this.touchRuntimeAccess(region.id);
      return this.descriptor(entry);
    });
  }

  /** Inspect rebuild freshness without changing LRU access recency. */
  async peek(region: NotabilityRegionV1): Promise<PreviewDescriptor | null> {
    return this.exclusive(async () => {
      const loaded = await this.ensureIndex();
      const entry = loaded.index.entries[region.id];
      if (!entry || !(await this.app.vault.adapter.exists(this.path(region.id)))) return null;
      const hash = canonicalRegionHash(region);
      if (entry.canonicalRegionHash !== null && entry.canonicalRegionHash !== hash) return null;
      return this.descriptor(entry);
    });
  }

  /**
   * Read one cache image and its matching descriptor under the cache queue.
   * Portable export uses this instead of a resource URL so a prune, refresh,
   * or clear cannot pair metadata with different bytes midway through a read.
   */
  async readSnapshot(region: NotabilityRegionV1, now = Date.now()): Promise<PreviewSnapshot | null> {
    return this.exclusive(async () => {
      const loaded = await this.ensureIndex();
      const entry = loaded.index.entries[region.id];
      const path = this.path(region.id);
      if (!entry || !(await this.app.vault.adapter.exists(path))) return null;
      const hash = canonicalRegionHash(region);
      if (entry.canonicalRegionHash !== null && entry.canonicalRegionHash !== hash) return null;

      let data: ArrayBuffer;
      try {
        data = await this.app.vault.adapter.readBinary(path);
      } catch {
        return null;
      }
      const dimensions = pngDimensions(data);
      if (
        data.byteLength !== entry.bytes
        || !dimensions
        || dimensions.width !== entry.pixelWidth
        || dimensions.height !== entry.pixelHeight
      ) return null;

      let changed = false;
      if (entry.canonicalRegionHash === null) {
        entry.canonicalRegionHash = hash;
        changed = true;
      }
      const previousAccess = Date.parse(entry.lastAccessedAt);
      if (!Number.isFinite(previousAccess) || now - previousAccess >= ACCESS_TOUCH_INTERVAL_MS) {
        entry.lastAccessedAt = new Date(now).toISOString();
        changed = true;
      }
      if (changed) await this.writeIndex(loaded.index);
      this.touchRuntimeAccess(region.id);
      return { descriptor: this.descriptor(entry), data };
    });
  }

  async has(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const loaded = await this.ensureIndex();
      return Boolean(loaded.index.entries[id]) && this.app.vault.adapter.exists(this.path(id));
    });
  }

  resourceUrl(id: string): string {
    return this.app.vault.adapter.getResourcePath(this.path(id));
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(async () => {
      const loaded = await this.ensureIndex();
      const path = this.path(id);
      if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
      if (loaded.index.entries[id]) {
        delete loaded.index.entries[id];
        this.runtimeAccessOrder.delete(id);
        await this.writeIndex(loaded.index);
      }
    });
  }

  async prune(): Promise<CachePruneResult> {
    return this.exclusive(async () => {
      try {
        const loaded = await this.ensureIndex();
        const result = await this.pruneLoaded(loaded.index, maxCacheBytes(this.settings()));
        if (result.removed > 0) {
          try {
            await this.writeIndex(loaded.index);
          } catch (error) {
            result.failures.push(failure(this.cacheIndexPath, "write-index", error));
          }
        }
        return result;
      } catch (error) {
        return {
          removed: 0,
          bytesRemoved: 0,
          remaining: 0,
          remainingBytes: 0,
          failures: [failure(this.cacheRoot, "read", error)]
        };
      }
    });
  }

  async stats(): Promise<CacheStats> {
    return this.exclusive(async () => {
      try {
        const loaded = await this.ensureIndex();
        const entries = Object.values(loaded.index.entries);
        return {
          count: entries.length,
          bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          unknownFiles: this.unknownFiles,
          failures: [...this.initializationFailures]
        };
      } catch (error) {
        return {
          count: 0,
          bytes: 0,
          unknownFiles: 0,
          failures: [failure(this.cacheRoot, "read", error)]
        };
      }
    });
  }

  async clear(): Promise<CacheClearResult> {
    return this.exclusive(async () => {
      const failures: CacheFailure[] = [];
      if (!(await this.app.vault.adapter.exists(this.cacheRoot))) {
        return { recognized: 0, removed: 0, bytesRemoved: 0, preservedUnknownFiles: 0, failures };
      }
      const loaded = await this.ensureIndex();
      failures.push(...loaded.failures);

      let listing: ListedCacheFiles;
      try {
        listing = await this.app.vault.adapter.list(this.cacheRoot);
      } catch (error) {
        return {
          recognized: 0,
          removed: 0,
          bytesRemoved: 0,
          preservedUnknownFiles: 0,
          failures: [failure(this.cacheRoot, "list", error)]
        };
      }

      const recognizedFiles = listing.files.filter((path) => recognizedRegionId(path) !== null);
      const unknownFiles = listing.files.length - recognizedFiles.length - listing.files.filter((path) => path === this.cacheIndexPath || path === this.cacheIndexTempPath).length;
      const retainedEntries: Record<string, CacheIndexEntry> = {};
      let removed = 0;
      let bytesRemoved = 0;

      for (const path of recognizedFiles) {
        const id = recognizedRegionId(path);
        if (!id) continue;
        let stat: Stat | null = null;
        try {
          stat = await this.app.vault.adapter.stat(path);
        } catch (error) {
          failures.push(failure(path, "stat", error));
        }
        try {
          await this.app.vault.adapter.remove(path);
          removed += 1;
          bytesRemoved += stat?.size ?? 0;
        } catch (error) {
          failures.push(failure(path, "remove", error));
          const existing = loaded.index.entries[id];
          if (existing) retainedEntries[id] = existing;
        }
      }

      const nextIndex: CacheIndexV1 = { version: CACHE_INDEX_VERSION, entries: retainedEntries };
      try {
        await this.writeIndex(nextIndex);
        this.index = nextIndex;
        this.resetRuntimeAccessOrder(nextIndex);
        this.initializationFailures = [];
        this.unknownFiles = Math.max(0, unknownFiles);
      } catch (error) {
        failures.push(failure(this.cacheIndexPath, "write-index", error));
      }
      return {
        recognized: recognizedFiles.length,
        removed,
        bytesRemoved,
        preservedUnknownFiles: Math.max(0, unknownFiles),
        failures
      };
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureIndex(): Promise<LoadedIndex> {
    if (this.index) {
      return { index: this.index, failures: this.initializationFailures, unknownFiles: this.unknownFiles };
    }
    await this.ensureRoot();
    const failures: CacheFailure[] = [];
    let index: CacheIndexV1 = { version: CACHE_INDEX_VERSION, entries: {} };
    let mustWrite = false;

    if (await this.app.vault.adapter.exists(this.cacheIndexPath)) {
      try {
        const parsed = parseIndex(JSON.parse(await this.app.vault.adapter.read(this.cacheIndexPath)));
        if (parsed) index = parsed;
        else {
          mustWrite = true;
          failures.push(failure(this.cacheIndexPath, "read", new Error("The cache index is invalid and was rebuilt.")));
        }
      } catch (error) {
        mustWrite = true;
        failures.push(failure(this.cacheIndexPath, "read", error));
      }
    } else {
      mustWrite = true;
    }

    let listing: ListedCacheFiles;
    try {
      listing = await this.app.vault.adapter.list(this.cacheRoot);
    } catch (error) {
      failures.push(failure(this.cacheRoot, "list", error));
      listing = { files: [], folders: [] };
    }
    const recognizedFiles = new Map<string, string>();
    let unknownFiles = 0;
    for (const path of listing.files) {
      const id = recognizedRegionId(path);
      if (id) recognizedFiles.set(id, path);
      else if (path !== this.cacheIndexPath && path !== this.cacheIndexTempPath) unknownFiles += 1;
    }

    for (const id of Object.keys(index.entries)) {
      if (!recognizedFiles.has(id)) {
        delete index.entries[id];
        mustWrite = true;
      }
    }
    for (const [id, path] of recognizedFiles) {
      let stat: Stat | null;
      try {
        stat = await this.app.vault.adapter.stat(path);
      } catch (error) {
        failures.push(failure(path, "stat", error));
        continue;
      }
      if (!stat) continue;
      const existing = index.entries[id];
      if (existing) {
        if (existing.bytes !== stat.size) {
          existing.bytes = stat.size;
          mustWrite = true;
        }
        continue;
      }
      try {
        const dimensions = pngDimensions(await this.app.vault.adapter.readBinary(path));
        if (!dimensions) throw new Error("The legacy preview is not a readable PNG.");
        const capturedAt = new Date(stat.mtime).toISOString();
        index.entries[id] = {
          regionId: id,
          file: `${id}.png`,
          canonicalRegionHash: null,
          bytes: stat.size,
          captureVersion: 0,
          cssWidth: dimensions.width,
          cssHeight: dimensions.height,
          pixelWidth: dimensions.width,
          pixelHeight: dimensions.height,
          chosenScale: 1,
          availableScales: [1],
          capturedAt,
          lastAccessedAt: capturedAt
        };
        mustWrite = true;
      } catch (error) {
        failures.push(failure(path, "read", error));
      }
    }

    this.index = index;
    this.resetRuntimeAccessOrder(index);
    this.initializationFailures = failures;
    this.unknownFiles = unknownFiles;
    if (mustWrite) {
      try {
        await this.writeIndex(index);
      } catch (error) {
        failures.push(failure(this.cacheIndexPath, "write-index", error));
      }
    }
    return { index, failures, unknownFiles };
  }

  private descriptor(entry: CacheIndexEntry): PreviewDescriptor {
    return {
      regionId: entry.regionId,
      url: `${this.resourceUrl(entry.regionId)}?v=${encodeURIComponent(entry.capturedAt)}`,
      canonicalRegionHash: entry.canonicalRegionHash,
      bytes: entry.bytes,
      captureVersion: entry.captureVersion,
      cssWidth: entry.cssWidth,
      cssHeight: entry.cssHeight,
      pixelWidth: entry.pixelWidth,
      pixelHeight: entry.pixelHeight,
      chosenScale: entry.chosenScale,
      availableScales: [...entry.availableScales],
      capturedAt: entry.capturedAt,
      lastAccessedAt: entry.lastAccessedAt
    };
  }

  private async pruneLoaded(index: CacheIndexV1, limit: number): Promise<CachePruneResult> {
    const failures: CacheFailure[] = [];
    const entries = Object.values(index.entries);
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let removed = 0;
    let bytesRemoved = 0;
    const oldestFirst = [...entries].sort((left, right) => {
      const orderDifference = (this.runtimeAccessOrder.get(left.regionId) ?? 0)
        - (this.runtimeAccessOrder.get(right.regionId) ?? 0);
      return orderDifference || left.regionId.localeCompare(right.regionId);
    });
    for (const entry of oldestFirst) {
      if (total <= limit) break;
      const path = this.path(entry.regionId);
      try {
        if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
        delete index.entries[entry.regionId];
        this.runtimeAccessOrder.delete(entry.regionId);
        removed += 1;
        bytesRemoved += entry.bytes;
        total -= entry.bytes;
      } catch (error) {
        failures.push(failure(path, "remove", error));
      }
    }
    return {
      removed,
      bytesRemoved,
      remaining: Object.keys(index.entries).length,
      remainingBytes: total,
      failures
    };
  }

  private touchRuntimeAccess(id: string): void {
    this.runtimeAccessOrder.set(id, ++this.nextRuntimeAccessOrder);
  }

  private resetRuntimeAccessOrder(index: CacheIndexV1): void {
    this.runtimeAccessOrder.clear();
    const oldestFirst = Object.values(index.entries).sort((left, right) => {
      const timeDifference = Date.parse(left.lastAccessedAt) - Date.parse(right.lastAccessedAt);
      return timeDifference || left.regionId.localeCompare(right.regionId);
    });
    for (const entry of oldestFirst) this.touchRuntimeAccess(entry.regionId);
  }

  private async writeIndex(index: CacheIndexV1): Promise<void> {
    await this.ensureRoot();
    const serialized = `${JSON.stringify(sortedIndex(index), null, 2)}\n`;
    if (await this.app.vault.adapter.exists(this.cacheIndexPath)) {
      await this.app.vault.adapter.process(this.cacheIndexPath, () => serialized);
      return;
    }
    await this.app.vault.adapter.write(this.cacheIndexTempPath, serialized);
    try {
      await this.app.vault.adapter.rename(this.cacheIndexTempPath, this.cacheIndexPath);
    } catch (error) {
      try {
        if (await this.app.vault.adapter.exists(this.cacheIndexTempPath)) {
          await this.app.vault.adapter.remove(this.cacheIndexTempPath);
        }
      } catch {
        // Keep the original rename failure. A later atomic write can replace the temp file.
      }
      throw error;
    }
  }
}
