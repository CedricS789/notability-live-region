import assert from "node:assert/strict";
import test from "node:test";
import type { App, ListedFiles, Stat } from "obsidian";
import {
  RegionCache,
  type PreviewCaptureInput
} from "../src/cache";
import type { NotabilityRegionV1 } from "../src/model";

const CACHE_ROOT = ".custom-config/plugins/notability-live-region/cache";
const CACHE_INDEX_PATH = `${CACHE_ROOT}/index.json`;

type StoredFile = {
  bytes: Uint8Array;
  ctime: number;
  mtime: number;
};

class FakeAdapter {
  readonly files = new Map<string, StoredFile>();
  readonly folders = new Set<string>([CACHE_ROOT]);
  readonly log: string[] = [];
  readonly failRemove = new Set<string>();
  private clock = Date.parse("2026-08-12T12:00:00.000Z");

  getName(): string { return "fake"; }

  seedBinary(path: string, bytes: Uint8Array, mtime = this.clock): void {
    this.files.set(path, { bytes: bytes.slice(), ctime: mtime, mtime });
  }

  seedText(path: string, text: string, mtime = this.clock): void {
    this.seedBinary(path, new TextEncoder().encode(text), mtime);
  }

  text(path: string): string {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing ${path}`);
    return new TextDecoder().decode(file.bytes);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async stat(path: string): Promise<Stat | null> {
    const file = this.files.get(path);
    if (file) return { type: "file", ctime: file.ctime, mtime: file.mtime, size: file.bytes.byteLength };
    if (this.folders.has(path)) return { type: "folder", ctime: this.clock, mtime: this.clock, size: 0 };
    return null;
  }

  async list(path: string): Promise<ListedFiles> {
    if (!this.folders.has(path)) throw new Error(`Missing folder ${path}`);
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/")),
      folders: [...this.folders].filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
    };
  }

  async read(path: string): Promise<string> { return this.text(path); }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing ${path}`);
    return file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
  }

  async write(path: string, text: string): Promise<void> {
    this.log.push(`write:${path}`);
    this.seedText(path, text, ++this.clock);
  }

  async writeBinary(path: string, bytes: ArrayBuffer): Promise<void> {
    this.log.push(`write-binary:${path}`);
    this.seedBinary(path, new Uint8Array(bytes), ++this.clock);
  }

  async process(path: string, update: (data: string) => string): Promise<string> {
    this.log.push(`process:${path}`);
    const next = update(this.text(path));
    this.seedText(path, next, ++this.clock);
    return next;
  }

  async mkdir(path: string): Promise<void> { this.folders.add(path); }

  getResourcePath(path: string): string { return `app://vault/${path}`; }

  async remove(path: string): Promise<void> {
    this.log.push(`remove:${path}`);
    if (this.failRemove.has(path)) throw new Error("simulated remove failure");
    if (!this.files.delete(path)) throw new Error(`Missing ${path}`);
  }

  async rename(from: string, to: string): Promise<void> {
    this.log.push(`rename:${from}->${to}`);
    const file = this.files.get(from);
    if (!file) throw new Error(`Missing ${from}`);
    this.files.set(to, file);
    this.files.delete(from);
  }
}

function fakeApp(adapter: FakeAdapter): App {
  return { vault: { adapter } } as unknown as App;
}

function png(width: number, height: number, byteLength = 24): Uint8Array {
  const bytes = new Uint8Array(Math.max(24, byteLength));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function region(id: string, capturedAt = "2026-08-12T10:00:00.000Z"): NotabilityRegionV1 {
  return {
    v: 1,
    id,
    url: "https://notability.com/n/abc123",
    title: "Signals",
    page: 2,
    expectedPageCount: 10,
    rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
    pageAspect: 0.75,
    fingerprint: { kind: "none" },
    adapter: "notability-web-v1",
    capturedAt
  };
}

function capture(capturedAt = "2026-08-12T10:00:00.000Z"): PreviewCaptureInput {
  return {
    captureVersion: 2,
    cssWidth: 320,
    cssHeight: 160,
    pixelWidth: 640,
    pixelHeight: 320,
    chosenScale: 2,
    availableScales: [1, 2],
    capturedAt
  };
}

test("legacy PNGs are indexed without deletion and adopted on first region read", async () => {
  const adapter = new FakeAdapter();
  const id = "nr-legacy0001";
  const path = `${CACHE_ROOT}/${id}.png`;
  adapter.seedBinary(path, png(640, 320), Date.parse("2026-08-11T08:00:00.000Z"));
  adapter.seedText(`${CACHE_ROOT}/keep.me`, "owned elsewhere");
  const cache = new RegionCache(fakeApp(adapter), () => ({ maxCacheMiB: 1024 }), CACHE_ROOT);

  const stats = await cache.stats();
  assert.deepEqual({ count: stats.count, bytes: stats.bytes, unknownFiles: stats.unknownFiles }, { count: 1, bytes: 24, unknownFiles: 1 });
  assert.equal(adapter.files.has(path), true);
  const migrated = JSON.parse(adapter.text(CACHE_INDEX_PATH));
  assert.equal(migrated.version, 1);
  assert.equal(migrated.entries[id].captureVersion, 0);
  assert.equal(migrated.entries[id].canonicalRegionHash, null);
  assert.deepEqual([migrated.entries[id].pixelWidth, migrated.entries[id].pixelHeight], [640, 320]);

  const preview = await cache.get(region(id));
  assert.equal(preview?.cssWidth, 640);
  assert.match(preview?.canonicalRegionHash ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(adapter.files.has(path), true);
});

test("capture metadata is indexed atomically and access is touched at most daily", async () => {
  const adapter = new FakeAdapter();
  const id = "nr-capture001";
  const cache = new RegionCache(fakeApp(adapter), () => ({ maxCacheMiB: 1024 }), CACHE_ROOT);
  const metadata = capture();
  const preview = await cache.put(region(id), png(640, 320, 120), metadata);
  assert.equal(preview?.chosenScale, 2);
  assert.deepEqual(preview?.availableScales, [1, 2]);

  const indexed = JSON.parse(adapter.text(CACHE_INDEX_PATH)).entries[id];
  assert.equal(indexed.bytes, 120);
  assert.equal(indexed.cssWidth, 320);
  assert.equal(indexed.pixelWidth, 640);
  assert.match(indexed.canonicalRegionHash, /^sha256:[a-f0-9]{64}$/);
  const atomicUpdatesAfterPut = adapter.log.filter((entry) => entry === `process:${CACHE_INDEX_PATH}`).length;

  const firstAccess = Date.parse(metadata.capturedAt) + 60 * 60 * 1000;
  await cache.get(region(id), firstAccess);
  assert.equal(adapter.log.filter((entry) => entry === `process:${CACHE_INDEX_PATH}`).length, atomicUpdatesAfterPut);
  assert.equal(JSON.parse(adapter.text(CACHE_INDEX_PATH)).entries[id].lastAccessedAt, metadata.capturedAt);

  const dailyAccess = Date.parse(metadata.capturedAt) + 25 * 60 * 60 * 1000;
  await cache.get(region(id), dailyAccess);
  assert.equal(adapter.log.filter((entry) => entry === `process:${CACHE_INDEX_PATH}`).length, atomicUpdatesAfterPut + 1);
  assert.equal(JSON.parse(adapter.text(CACHE_INDEX_PATH)).entries[id].lastAccessedAt, new Date(dailyAccess).toISOString());

  await cache.get(region(id), dailyAccess + 60 * 60 * 1000);
  assert.equal(adapter.log.filter((entry) => entry === `process:${CACHE_INDEX_PATH}`).length, atomicUpdatesAfterPut + 1);
  assert.equal(JSON.parse(adapter.text(CACHE_INDEX_PATH)).entries[id].lastAccessedAt, new Date(dailyAccess).toISOString());
  assert.equal(adapter.log.some((entry) => entry === `rename:${CACHE_ROOT}/index.json.tmp->${CACHE_INDEX_PATH}`), true);
  assert.equal(adapter.log.some((entry) => entry === `process:${CACHE_INDEX_PATH}`), true);
});

test("rebuild inspection does not touch LRU access time", async () => {
  const adapter = new FakeAdapter();
  const id = "nr-peek00001";
  const cache = new RegionCache(fakeApp(adapter), () => ({ maxCacheMiB: 1024 }), CACHE_ROOT);
  const metadata = capture("2026-08-10T10:00:00.000Z");
  await cache.put(region(id, metadata.capturedAt), png(640, 320, 120), metadata);
  const before = JSON.parse(adapter.text(CACHE_INDEX_PATH)).entries[id].lastAccessedAt;
  const indexWrites = adapter.log.filter((entry) => entry === `process:${CACHE_INDEX_PATH}`).length;

  const descriptor = await cache.peek(region(id, metadata.capturedAt));

  assert.equal(descriptor?.lastAccessedAt, before);
  assert.equal(JSON.parse(adapter.text(CACHE_INDEX_PATH)).entries[id].lastAccessedAt, before);
  assert.equal(adapter.log.filter((entry) => entry === `process:${CACHE_INDEX_PATH}`).length, indexWrites);
  assert.deepEqual(await cache.peek(region(id, metadata.capturedAt)), descriptor);
  assert.equal(await cache.peek({ ...region(id, metadata.capturedAt), page: 3 }), null);
});

test("portable export snapshots atomically validate metadata and PNG bytes", async () => {
  const adapter = new FakeAdapter();
  const id = "nr-export0001";
  const cache = new RegionCache(fakeApp(adapter), () => ({ maxCacheMiB: 1024 }), CACHE_ROOT);
  const metadata = capture();
  const encoded = png(640, 320, 120);
  await cache.put(region(id), encoded, metadata);

  const snapshot = await cache.readSnapshot(region(id));
  assert.ok(snapshot);
  assert.deepEqual(new Uint8Array(snapshot.data), encoded);
  assert.equal(snapshot.descriptor.regionId, id);
  assert.equal(await cache.readSnapshot({ ...region(id), page: 3 }), null, "changed metadata must not reuse the pixels");

  adapter.seedBinary(`${CACHE_ROOT}/${id}.png`, png(320, 160, 120));
  assert.equal(await cache.readSnapshot(region(id)), null, "descriptor dimensions must match the encoded image");

  adapter.seedBinary(`${CACHE_ROOT}/${id}.png`, new Uint8Array(120));
  assert.equal(await cache.readSnapshot(region(id)), null, "non-PNG bytes must fail closed");
});

test("LRU pruning removes the oldest accessed preview when the byte cap is exceeded", async () => {
  const adapter = new FakeAdapter();
  const cache = new RegionCache(fakeApp(adapter), () => ({ maxCacheMiB: 1 }), CACHE_ROOT);
  const firstId = "nr-prune0001";
  const secondId = "nr-prune0002";
  await cache.put(region(firstId, "2026-08-10T10:00:00.000Z"), png(640, 320, 700_000), capture("2026-08-10T10:00:00.000Z"));
  await cache.put(region(secondId, "2026-08-12T10:00:00.000Z"), png(640, 320, 700_000), capture("2026-08-12T10:00:00.000Z"));

  assert.equal(adapter.files.has(`${CACHE_ROOT}/${firstId}.png`), false);
  assert.equal(adapter.files.has(`${CACHE_ROOT}/${secondId}.png`), true);
  assert.deepEqual(await cache.stats(), { count: 1, bytes: 700_000, unknownFiles: 0, failures: [] });
});

test("sub-day reads update exact in-memory LRU order without persisting a touch", async () => {
  const adapter = new FakeAdapter();
  const cache = new RegionCache(fakeApp(adapter), () => ({ maxCacheMiB: 1 }), CACHE_ROOT);
  const firstId = "nr-runtime001";
  const secondId = "nr-runtime002";
  const thirdId = "nr-runtime003";
  const firstCapture = "2026-08-12T10:00:00.000Z";
  const secondCapture = "2026-08-12T11:00:00.000Z";
  const thirdCapture = "2026-08-12T12:00:00.000Z";

  await cache.put(region(firstId, firstCapture), png(640, 320, 400_000), capture(firstCapture));
  await cache.put(region(secondId, secondCapture), png(640, 320, 400_000), capture(secondCapture));
  const writesBeforeRead = adapter.log.filter((entry) => entry === `process:${CACHE_INDEX_PATH}`).length;

  await cache.get(region(firstId, firstCapture), Date.parse(secondCapture) + 30 * 60 * 1000);

  assert.equal(adapter.log.filter((entry) => entry === `process:${CACHE_INDEX_PATH}`).length, writesBeforeRead);
  assert.equal(JSON.parse(adapter.text(CACHE_INDEX_PATH)).entries[firstId].lastAccessedAt, firstCapture);

  await cache.put(region(thirdId, thirdCapture), png(640, 320, 400_000), capture(thirdCapture));

  assert.equal(adapter.files.has(`${CACHE_ROOT}/${firstId}.png`), true);
  assert.equal(adapter.files.has(`${CACHE_ROOT}/${secondId}.png`), false);
  assert.equal(adapter.files.has(`${CACHE_ROOT}/${thirdId}.png`), true);
});

test("clear removes only recognized previews and reports partial failures", async () => {
  const adapter = new FakeAdapter();
  const first = `${CACHE_ROOT}/nr-clear0001.png`;
  const second = `${CACHE_ROOT}/nr-clear0002.png`;
  const unknown = `${CACHE_ROOT}/do-not-delete.png`;
  adapter.seedBinary(first, png(10, 10, 40));
  adapter.seedBinary(second, png(10, 10, 60));
  adapter.seedBinary(unknown, png(10, 10, 80));
  adapter.failRemove.add(second);
  const cache = new RegionCache(fakeApp(adapter), () => ({ maxCacheMiB: 1024 }), CACHE_ROOT);

  const result = await cache.clear();
  assert.equal(result.recognized, 2);
  assert.equal(result.removed, 1);
  assert.equal(result.bytesRemoved, 40);
  assert.equal(result.preservedUnknownFiles, 1);
  assert.equal(result.failures.some((entry) => entry.path === second && entry.operation === "remove"), true);
  assert.equal(adapter.files.has(first), false);
  assert.equal(adapter.files.has(second), true);
  assert.equal(adapter.files.has(unknown), true);
  const retained = JSON.parse(adapter.text(CACHE_INDEX_PATH)).entries;
  assert.deepEqual(Object.keys(retained), ["nr-clear0002"]);
});
