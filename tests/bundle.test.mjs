import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production bundle uses Obsidian's CodeMirror runtime", async () => {
  const bundle = await readFile(new URL("../main.js", import.meta.url), "utf8");

  assert.match(bundle, /require\(["']@codemirror\/state["']\)/);
  assert.match(bundle, /require\(["']@codemirror\/view["']\)/);
  assert.doesNotMatch(
    bundle,
    /Unrecognized extension value in extension set/,
    "private CodeMirror runtime was bundled"
  );
});

test("release metadata is consistently versioned as 1.0.0", async () => {
  const [manifest, packageJson, packageLock] = await Promise.all([
    readFile(new URL("../manifest.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse)
  ]);

  assert.equal(manifest.id, "notability-live-region");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(packageLock.version, manifest.version);
  assert.equal(packageLock.packages[""].version, manifest.version);
});

test("production bundle contains the v1.0.0 capture, delivery, and portable-export runtime", async () => {
  const bundle = await readFile(new URL("../main.js", import.meta.url), "utf8");

  assert.match(bundle, /captureVersion must be a positive integer/);
  assert.match(bundle, /Embed page/);
  assert.doesNotMatch(bundle, /notability-live-region-page-controls/);
  assert.doesNotMatch(bundle, /notability-live-region-page-input/);
  assert.doesNotMatch(bundle, /Notability page count/);
  assert.doesNotMatch(bundle, /Type a page number and press Enter/);
  assert.doesNotMatch(bundle, /Jumped to page/);
  assert.match(bundle, /notability-live-region\.selection-scroll-lock\.v3/);
  assert.match(bundle, /notability-live-region\.capture-escape:/);
  assert.match(bundle, /captureEscapeRequestedId/);
  assert.match(bundle, /could not close its Escape cancellation window safely/);
  assert.match(bundle, /data-obsidian-notability-capture-chrome/);
  assert.match(bundle, /\[data-testid=\\?"page-navigator/);
  assert.match(bundle, /Notability capture controls became visible during capture/);
  assert.doesNotMatch(bundle, /sendInputEvent/);
  assert.match(bundle, /Capturing the entire page/);
  assert.match(bundle, /The Notability page tile did not finish rendering before capture/);
  assert.match(bundle, /Whole-page capture page identity changed across viewer scale phases/);
  assert.match(bundle, /Whole-page capture phase layout changed during tiled capture/);
  assert.match(bundle, /Notability capture cancelled/);
  assert.match(bundle, /Press Esc to cancel/);
  assert.match(bundle, /aria-keyshortcuts.*Escape/);
  assert.match(bundle, /sealCaptureCancellation/);
  assert.match(bundle, /this final write cannot be cancelled/);
  assert.match(bundle, /Toggle inserting Notability embeds on copy/);
  assert.match(bundle, /notability-live-region-auto-insert/);
  assert.match(bundle, /Copy \+ insert/);
  assert.match(bundle, /Insert on copy needs an editable Markdown target/);
  assert.match(bundle, /selecting alone does not start a capture/);
  assert.match(bundle, /The viewer returned to Browse/);
  assert.match(bundle, /Markdown target changed or was unavailable/);
  assert.match(bundle, /Create portable Notability export copy/);
  assert.match(bundle, /create-portable-export-copy/);
  assert.match(bundle, /Notability Exports/);
  assert.match(bundle, /notability-assets/);
  assert.match(bundle, /notability-live-region-export-/);
  assert.match(bundle, /The source note was not changed/);
  assert.match(bundle, /The source note changed while the portable export was being prepared/);
  assert.match(bundle, /is missing or unreadable/);
  assert.match(bundle, /changed after confirmation/);
  assert.match(bundle, /Portable export failed and its staging folder could not be removed/);
  assert.match(bundle, /The saved preview did not finish loading in time/);
  assert.match(bundle, /,"eager"/);
  assert.doesNotMatch(bundle, /id:\s*["']rebuild-previews["']/);
  assert.doesNotMatch(bundle, /Rebuild Notability previews|Scanning indexed Markdown/);
  assert.match(bundle, /configDir/);
});
