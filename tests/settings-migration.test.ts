import assert from "node:assert/strict";
import test from "node:test";
import { migrateRegionSettings } from "../src/settings-data";

test("v0.2 defaults migrate to the 5 GiB cache and drop age retention", () => {
  const migrated = migrateRegionSettings({
    maxCacheMiB: 256,
    maxCacheAgeDays: 30,
    recentNoteUrls: ["https://notability.com/app/note/example"]
  });

  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.settings, {
    maxCacheMiB: 5120,
    recentNoteUrls: ["https://notability.com/app/note/example"]
  });
  assert.equal("maxCacheAgeDays" in migrated.settings, false);
});

test("the v0.3 1 GiB default migrates to the 5 GiB cache", () => {
  const migrated = migrateRegionSettings({
    maxCacheMiB: 1024,
    recentNoteUrls: ["https://notability.com/app/note/example"]
  });

  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.settings, {
    maxCacheMiB: 5120,
    recentNoteUrls: ["https://notability.com/app/note/example"]
  });
});

test("custom v0.2 cache sizes survive while obsolete age retention is removed", () => {
  const migrated = migrateRegionSettings({
    maxCacheMiB: 512,
    maxCacheAgeDays: 14,
    recentNoteUrls: []
  });

  assert.equal(migrated.changed, true);
  assert.equal(migrated.settings.maxCacheMiB, 512);
});

test("current settings remain stable and need no rewrite", () => {
  const migrated = migrateRegionSettings({
    maxCacheMiB: 768,
    recentNoteUrls: ["one", "two"]
  });

  assert.equal(migrated.changed, false);
  assert.deepEqual(migrated.settings, {
    maxCacheMiB: 768,
    recentNoteUrls: ["one", "two"]
  });
});

test("the current 5 GiB default remains stable and needs no rewrite", () => {
  const migrated = migrateRegionSettings({
    maxCacheMiB: 5120,
    recentNoteUrls: []
  });

  assert.equal(migrated.changed, false);
  assert.deepEqual(migrated.settings, {
    maxCacheMiB: 5120,
    recentNoteUrls: []
  });
});
