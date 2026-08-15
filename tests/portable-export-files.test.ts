import assert from "node:assert/strict";
import test from "node:test";
import type { NotabilityRegionV1 } from "../src/model";
import { writePortableExportBundle } from "../src/portable-export-files";
import { region } from "./fixtures";

class MemoryAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  readonly log: string[] = [];
  failMarkdown = false;
  failRmdir = false;

  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.folders.has(path); }
  async mkdir(path: string): Promise<void> {
    this.log.push(`mkdir:${path}`);
    if (this.files.has(path) || this.folders.has(path)) throw new Error(`Exists: ${path}`);
    this.folders.add(path);
  }
  async read(path: string): Promise<string> {
    const data = this.files.get(path);
    if (!data) throw new Error(`Missing: ${path}`);
    return new TextDecoder().decode(data);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.files.get(path);
    if (!data) throw new Error(`Missing: ${path}`);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  async write(path: string, value: string): Promise<void> {
    this.log.push(`write:${path}`);
    if (this.failMarkdown) throw new Error("simulated Markdown failure");
    this.files.set(path, new TextEncoder().encode(value));
  }
  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.log.push(`write-binary:${path}`);
    this.files.set(path, new Uint8Array(value.slice(0)));
  }
  async rename(from: string, to: string): Promise<void> {
    this.log.push(`rename:${from}->${to}`);
    const sourcePrefix = `${from}/`;
    const fileMoves = [...this.files].filter(([path]) => path.startsWith(sourcePrefix));
    const folderMoves = [...this.folders].filter((path) => path === from || path.startsWith(sourcePrefix));
    for (const [path, value] of fileMoves) {
      this.files.delete(path);
      this.files.set(`${to}/${path.slice(sourcePrefix.length)}`, value);
    }
    for (const path of folderMoves.sort((a, b) => b.length - a.length)) this.folders.delete(path);
    for (const path of folderMoves.sort((a, b) => a.length - b.length)) {
      this.folders.add(path === from ? to : `${to}/${path.slice(sourcePrefix.length)}`);
    }
  }
  async rmdir(path: string, recursive: boolean): Promise<void> {
    this.log.push(`rmdir:${path}:${recursive}`);
    if (this.failRmdir) throw new Error("simulated cleanup failure");
    const prefix = `${path}/`;
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
    for (const folder of [...this.folders]) if (folder === path || folder.startsWith(prefix)) this.folders.delete(folder);
  }
}

function bytes(...values: number[]): ArrayBuffer {
  return Uint8Array.from(values).buffer;
}

function plan(value: NotabilityRegionV1) {
  return {
    markdown: "before\n\n![preview](notability-assets/nr-12345678.png)\n\nafter",
    markdownFileName: "Note.md",
    destinationPath: "Notability Exports/Note-20260814-120000",
    assets: [{ path: "notability-assets/nr-12345678.png", region: value }]
  };
}

test("portable bundle is verified in hidden staging before one visible rename", async () => {
  const adapter = new MemoryAdapter();
  const image = bytes(1, 2, 3, 4);
  await writePortableExportBundle({
    adapter: adapter as never,
    plan: plan(region()),
    stagingId: "12345678-abcd",
    readAsset: async () => image,
    sourceStillCurrent: async () => true
  });

  assert.equal(new TextDecoder().decode(adapter.files.get("Notability Exports/Note-20260814-120000/Note.md")), plan(region()).markdown);
  assert.deepEqual(adapter.files.get("Notability Exports/Note-20260814-120000/notability-assets/nr-12345678.png"), new Uint8Array(image));
  assert.equal(adapter.log.at(-1), "rename:.tmp/notability-live-region-export-12345678-abcd->Notability Exports/Note-20260814-120000");
  assert.equal([...adapter.files.keys()].some((path) => path.startsWith(".tmp/notability-live-region-export-")), false);
});

test("portable bundle removes its unique staging folder on failure and never publishes partial output", async () => {
  const adapter = new MemoryAdapter();
  adapter.failMarkdown = true;
  await assert.rejects(writePortableExportBundle({
    adapter: adapter as never,
    plan: plan(region()),
    stagingId: "12345678-fail",
    readAsset: async () => bytes(9, 8, 7),
    sourceStillCurrent: async () => true
  }), /simulated Markdown failure/);

  assert.equal(adapter.folders.has("Notability Exports/Note-20260814-120000"), false);
  assert.equal([...adapter.files.keys()].some((path) => path.startsWith(".tmp/notability-live-region-export-")), false);
  assert.match(adapter.log.join("\n"), /rmdir:.tmp\/notability-live-region-export-12345678-fail:true/);
});

test("portable bundle fails before publishing when source changed or preview vanished", async () => {
  const sourceChanged = new MemoryAdapter();
  await assert.rejects(writePortableExportBundle({
    adapter: sourceChanged as never,
    plan: plan(region()),
    stagingId: "12345678-stale",
    readAsset: async () => bytes(4, 5, 6),
    sourceStillCurrent: async () => false
  }), /source note changed/);
  assert.equal(sourceChanged.folders.has("Notability Exports/Note-20260814-120000"), false);

  const missing = new MemoryAdapter();
  await assert.rejects(writePortableExportBundle({
    adapter: missing as never,
    plan: plan(region()),
    stagingId: "12345678-missing",
    readAsset: async () => null,
    sourceStillCurrent: async () => true
  }), /missing or unreadable/);
  assert.equal(missing.folders.has("Notability Exports/Note-20260814-120000"), false);
});

test("portable bundle rejects traversal and Windows-invalid paths before writing", async () => {
  for (const unsafe of [
    "../escape",
    "Notability Exports/CON",
    "Notability Exports/trailing."
  ]) {
    const adapter = new MemoryAdapter();
    await assert.rejects(writePortableExportBundle({
      adapter: adapter as never,
      plan: { ...plan(region()), destinationPath: unsafe },
      stagingId: "12345678-unsafe",
      readAsset: async () => bytes(1),
      sourceStillCurrent: async () => true
    }), /safe vault-relative path/);
    assert.deepEqual(adapter.log, []);
  }
});

test("portable bundle reports the exact staging path when cleanup also fails", async () => {
  const adapter = new MemoryAdapter();
  adapter.failMarkdown = true;
  adapter.failRmdir = true;
  await assert.rejects(writePortableExportBundle({
    adapter: adapter as never,
    plan: plan(region()),
    stagingId: "12345678-cleanup",
    readAsset: async () => bytes(1, 2, 3),
    sourceStillCurrent: async () => true
  }), (error: unknown) => error instanceof AggregateError
    && /\.tmp\/notability-live-region-export-12345678-cleanup/.test(error.message)
    && /simulated Markdown failure/.test(error.message));

  assert.equal(adapter.folders.has(".tmp/notability-live-region-export-12345678-cleanup"), true);
});
