import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LEGACY_DEFAULT_HOTKEYS,
  PLUGIN_ID,
  RUNTIME_ARTIFACTS,
  assertAllowedVault,
  deploy,
  mergeCommunityPlugins,
  migrateHotkeys,
  resolveVault
} from "../scripts/deploy.mjs";

test("configuration migration removes only exact legacy defaults and adds no hotkeys", () => {
  assert.deepEqual(mergeCommunityPlugins(["pdf-plus"]), ["pdf-plus", PLUGIN_ID]);
  assert.deepEqual(mergeCommunityPlugins([PLUGIN_ID]), [PLUGIN_ID]);
  const customBinding = [{ modifiers: ["Alt", "Shift"], key: "L" }];
  const original = {
    "pdf-plus:copy": [{ modifiers: ["Alt"], key: "Q" }],
    [`${PLUGIN_ID}:old`]: [],
    [`${PLUGIN_ID}:capture-link`]: customBinding,
    [`${PLUGIN_ID}:capture-embed`]: [{ key: "O", modifiers: ["Mod", "Shift"] }]
  };
  const migration = migrateHotkeys(original);
  assert.deepEqual(migration.hotkeys["pdf-plus:copy"], original["pdf-plus:copy"]);
  assert.deepEqual(migration.hotkeys[`${PLUGIN_ID}:old`], []);
  assert.deepEqual(migration.hotkeys[`${PLUGIN_ID}:capture-link`], customBinding);
  assert.equal(`${PLUGIN_ID}:capture-embed` in migration.hotkeys, false);
  assert.deepEqual(migration.removedLegacyDefaults, [`${PLUGIN_ID}:capture-embed`]);
  assert.deepEqual(migration.preservedCustomBindings, [`${PLUGIN_ID}:capture-link`]);
  assert.equal(migration.changed, true);

  const empty = migrateHotkeys({});
  assert.deepEqual(empty.hotkeys, {});
  assert.deepEqual(empty.removedLegacyDefaults, []);
  assert.deepEqual(empty.preservedCustomBindings, []);
  assert.equal(empty.changed, false);
});

test("vault guard rejects broad paths", () => {
  const driveRoot = path.parse(process.cwd()).root;
  assert.throws(() => assertAllowedVault(driveRoot, { NOTABILITY_LIVE_REGION_VAULT: driveRoot }), /unsafe/);
});

test("deployment requires one explicit matching vault path", () => {
  assert.throws(() => resolveVault({}), /Set NOTABILITY_LIVE_REGION_VAULT/);
  const configured = path.join(process.cwd(), "example-vault");
  assert.equal(resolveVault({ NOTABILITY_LIVE_REGION_VAULT: configured }), path.resolve(configured));
  assert.throws(
    () => assertAllowedVault(path.join(process.cwd(), "other-vault"), { NOTABILITY_LIVE_REGION_VAULT: configured }),
    /does not match/
  );
});

test("deployment stages runtime files, preserves plugin data, and writes a backup", async () => {
  const root = path.join(os.tmpdir(), `nlr-deploy-root-${process.pid}-${Date.now()}`);
  const vault = path.join(root, "vault");
  const source = path.join(root, "source");
  const obsidian = path.join(vault, ".obsidian");
  const plugin = path.join(obsidian, "plugins", PLUGIN_ID);
  try {
    await mkdir(plugin, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(obsidian, "app.json"), "{}\n");
    await writeFile(path.join(obsidian, "community-plugins.json"), '["pdf-plus"]\n');
    const customCaptureBinding = [{ modifiers: ["Alt"], key: "E" }];
    const originalHotkeys = {
      "keep:me": [{ key: "K" }],
      [`${PLUGIN_ID}:capture-link`]: LEGACY_DEFAULT_HOTKEYS[`${PLUGIN_ID}:capture-link`],
      [`${PLUGIN_ID}:capture-embed`]: customCaptureBinding
    };
    await writeFile(path.join(obsidian, "hotkeys.json"), `${JSON.stringify(originalHotkeys)}\n`);
    await writeFile(path.join(plugin, "data.json"), '{"preserve":true}\n');
    await writeFile(path.join(plugin, "main.js"), "old-main\n");
    await writeFile(path.join(plugin, "main-security.cjs"), "old-sidecar\n");
    for (const artifact of RUNTIME_ARTIFACTS) {
      await writeFile(path.join(source, artifact), `new-${artifact}\n`);
    }

    const result = await deploy({ vault, root: source, env: { NOTABILITY_LIVE_REGION_VAULT: vault } });
    assert.equal(await readFile(path.join(plugin, "main.js"), "utf8"), "new-main.js\n");
    assert.equal(await readFile(path.join(plugin, "data.json"), "utf8"), '{"preserve":true}\n');
    assert.equal(await readFile(path.join(result.backup, "main.js"), "utf8"), "old-main\n");
    assert.equal(await readFile(path.join(result.backup, "main-security.cjs"), "utf8"), "old-sidecar\n");
    await assert.rejects(() => readFile(path.join(plugin, "main-security.cjs"), "utf8"), { code: "ENOENT" });
    const rollbackManifest = JSON.parse(await readFile(result.manifest, "utf8"));
    assert.equal(rollbackManifest.pluginRootExisted, true);
    assert.equal(rollbackManifest.originalCommunityExists, true);
    assert.match(rollbackManifest.originalCommunityHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(rollbackManifest.sourceHashes).sort(), [...RUNTIME_ARTIFACTS].sort());
    for (const hash of Object.values(rollbackManifest.sourceHashes)) assert.match(hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(rollbackManifest.hotkeyMigration, {
      removedLegacyDefaults: [`${PLUGIN_ID}:capture-link`],
      preservedCustomBindings: [`${PLUGIN_ID}:capture-embed`]
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(obsidian, "community-plugins.json"), "utf8")), ["pdf-plus", PLUGIN_ID]);
    const hotkeys = JSON.parse(await readFile(path.join(obsidian, "hotkeys.json"), "utf8"));
    assert.deepEqual(hotkeys["keep:me"], [{ key: "K" }]);
    assert.equal(`${PLUGIN_ID}:capture-link` in hotkeys, false);
    assert.deepEqual(hotkeys[`${PLUGIN_ID}:capture-embed`], customCaptureBinding);
    assert.deepEqual(JSON.parse(await readFile(path.join(result.backup, "hotkeys.json"), "utf8")), originalHotkeys);
    assert.deepEqual(result.hotkeyMigration, rollbackManifest.hotkeyMigration);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment does not create hotkeys.json when there is nothing to migrate", async () => {
  const root = path.join(os.tmpdir(), `nlr-deploy-no-hotkeys-${process.pid}-${Date.now()}`);
  const vault = path.join(root, "vault");
  const source = path.join(root, "source");
  const obsidian = path.join(vault, ".obsidian");
  try {
    await mkdir(obsidian, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(obsidian, "app.json"), "{}\n");
    for (const artifact of RUNTIME_ARTIFACTS) {
      await writeFile(path.join(source, artifact), `new-${artifact}\n`);
    }

    const result = await deploy({ vault, root: source, env: { NOTABILITY_LIVE_REGION_VAULT: vault } });

    await assert.rejects(() => readFile(path.join(obsidian, "hotkeys.json"), "utf8"), { code: "ENOENT" });
    assert.deepEqual(result.hotkeyMigration, {
      removedLegacyDefaults: [],
      preservedCustomBindings: []
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment reports customized capture bindings without rewriting hotkeys.json", async () => {
  const root = path.join(os.tmpdir(), `nlr-deploy-custom-hotkeys-${process.pid}-${Date.now()}`);
  const vault = path.join(root, "vault");
  const source = path.join(root, "source");
  const obsidian = path.join(vault, ".obsidian");
  const hotkeysFile = path.join(obsidian, "hotkeys.json");
  const customBody = `{
  "${PLUGIN_ID}:capture-link": [{ "modifiers": ["Alt"], "key": "J" }],
  "keep:me": []
}\n`;
  try {
    await mkdir(obsidian, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(obsidian, "app.json"), "{}\n");
    await writeFile(hotkeysFile, customBody);
    for (const artifact of RUNTIME_ARTIFACTS) {
      await writeFile(path.join(source, artifact), `new-${artifact}\n`);
    }

    const result = await deploy({ vault, root: source, env: { NOTABILITY_LIVE_REGION_VAULT: vault } });

    assert.equal(await readFile(hotkeysFile, "utf8"), customBody);
    assert.deepEqual(result.hotkeyMigration, {
      removedLegacyDefaults: [],
      preservedCustomBindings: [`${PLUGIN_ID}:capture-link`]
    });
    await assert.rejects(() => readFile(path.join(result.backup, "hotkeys.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
