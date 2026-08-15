import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("portable export is an explicit cache-only copy and never mutates its source note", async () => {
  const [main, cache, files, readme] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/cache.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/portable-export-files.ts", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8")
  ]);

  assert.match(main, /id:\s*"create-portable-export-copy"/);
  assert.match(main, /planPortableExport\(source\)/);
  assert.match(main, /this\.cache\.readSnapshot\(asset\.region\)/);
  assert.match(main, /const approvedPixels = new Map<string, \{ bytes: number; digest: string \}>\(\)/);
  assert.match(main, /portableExportDigest\(snapshot\.data\)/);
  assert.match(main, /snapshot\.data\.byteLength !== approved\.bytes[\s\S]*portableExportDigest\(snapshot\.data\) !== approved\.digest/);
  assert.doesNotMatch(main, /Map<string, ArrayBuffer>/);
  assert.match(main, /new PortableExportConfirmationModal/);
  assert.match(main, /writePortableExportBundle/);
  assert.match(main, /sourceStillCurrent:\s*async \(\) => await this\.app\.vault\.read\(file\) === source/);

  const method = /private async createPortableExportCopy[\s\S]*?\n  private async availablePortableExportPath/.exec(main)?.[0] ?? "";
  assert.doesNotMatch(method, /openRegion|refreshRegion|loadURL|vault\.modify|vault\.process/);
  assert.match(cache, /async readSnapshot[\s\S]*canonicalRegionHash[\s\S]*readBinary[\s\S]*pngDimensions/);
  assert.match(files, /PORTABLE_EXPORT_STAGING_ROOT = "\.tmp"/);
  assert.match(files, /await adapter\.rename\(stagingPath, plan\.destinationPath\)/);
  assert.match(readme, /The source note is never edited/);
});
