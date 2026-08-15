import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const PLUGIN_ID = "notability-live-region";
export const RUNTIME_ARTIFACTS = ["main.js", "manifest.json", "styles.css"];
const LEGACY_RUNTIME_ARTIFACTS = ["main-security.cjs"];
export const LEGACY_DEFAULT_HOTKEYS = {
  [`${PLUGIN_ID}:capture-link`]: [{ modifiers: ["Mod", "Shift"], key: "L" }],
  [`${PLUGIN_ID}:capture-embed`]: [{ modifiers: ["Mod", "Shift"], key: "O" }]
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function resolveVault(env = process.env) {
  const configured = env.NOTABILITY_LIVE_REGION_VAULT?.trim();
  if (!configured) {
    throw new Error("Set NOTABILITY_LIVE_REGION_VAULT to the exact Obsidian vault to deploy.");
  }
  return path.resolve(configured);
}

export function assertAllowedVault(vault, env = process.env) {
  const explicit = env.NOTABILITY_LIVE_REGION_VAULT?.trim();
  if (!explicit) {
    throw new Error("Set NOTABILITY_LIVE_REGION_VAULT before deploying.");
  }
  const expected = path.normalize(path.resolve(explicit)).toLowerCase();
  const normalized = path.normalize(vault).toLowerCase();
  if (normalized !== expected) {
    throw new Error(`Refusing a vault path that does not match NOTABILITY_LIVE_REGION_VAULT: ${vault}`);
  }
  if (path.parse(vault).root === vault || vault.length < 12) {
    throw new Error(`Refusing broad or unsafe vault path: ${vault}`);
  }
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  if (!(await isFile(file))) return fallback;
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function digest(file) {
  if (!(await isFile(file))) return null;
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export function mergeCommunityPlugins(current) {
  if (!Array.isArray(current) || current.some((item) => typeof item !== "string")) {
    throw new Error("community-plugins.json must be an array of plugin IDs.");
  }
  return current.includes(PLUGIN_ID) ? [...current] : [...current, PLUGIN_ID];
}

export function migrateHotkeys(current) {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error("hotkeys.json must be a JSON object.");
  }
  const hotkeys = { ...current };
  const removedLegacyDefaults = [];
  const preservedCustomBindings = [];
  for (const [command, legacyDefault] of Object.entries(LEGACY_DEFAULT_HOTKEYS)) {
    if (!(command in hotkeys)) continue;
    if (isDeepStrictEqual(hotkeys[command], legacyDefault)) {
      delete hotkeys[command];
      removedLegacyDefaults.push(command);
    } else {
      preservedCustomBindings.push(command);
    }
  }
  return {
    hotkeys,
    removedLegacyDefaults,
    preservedCustomBindings,
    changed: removedLegacyDefaults.length > 0
  };
}

/** Compatibility helper for callers that only need the migrated object. */
export function mergeHotkeys(current) {
  return migrateHotkeys(current).hotkeys;
}

export async function deploy({ vault = resolveVault(), env = process.env, root = projectRoot } = {}) {
  assertAllowedVault(vault, env);
  const obsidian = path.join(vault, ".obsidian");
  const pluginRoot = path.join(obsidian, "plugins", PLUGIN_ID);
  if (!(await isDirectory(obsidian)) || !(await isFile(path.join(obsidian, "app.json")))) {
    throw new Error(`Not an Obsidian vault with .obsidian/app.json: ${vault}`);
  }

  const sources = new Map();
  for (const name of RUNTIME_ARTIFACTS) {
    const source = path.join(root, name);
    if (!(await isFile(source))) throw new Error(`Missing built runtime artifact: ${source}`);
    sources.set(name, source);
  }
  const sourceHashes = Object.fromEntries(
    await Promise.all([...sources].map(async ([name, source]) => [name, await digest(source)]))
  );

  const communityFile = path.join(obsidian, "community-plugins.json");
  const hotkeysFile = path.join(obsidian, "hotkeys.json");
  const pluginRootExisted = await isDirectory(pluginRoot);
  const originalCommunityExists = await isFile(communityFile);
  const originalHotkeysExists = await isFile(hotkeysFile);
  const originalCommunityHash = await digest(communityFile);
  const originalHotkeysHash = await digest(hotkeysFile);
  const mergedCommunity = mergeCommunityPlugins(await readJson(communityFile, []));
  const hotkeyMigration = migrateHotkeys(await readJson(hotkeysFile, {}));

  const operationRoot = path.join(vault, ".tmp", `notability-live-region-deploy-${timestamp()}`);
  const stage = path.join(operationRoot, "stage");
  const backup = path.join(operationRoot, "backup");
  await mkdir(stage, { recursive: true });
  await mkdir(backup, { recursive: true });

  const backupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    vault,
    pluginRoot,
    pluginRootExisted,
    originalCommunityExists,
    originalHotkeysExists,
    originalCommunityHash,
    originalHotkeysHash,
    sourceHashes,
    runtimeArtifacts: RUNTIME_ARTIFACTS,
    legacyRuntimeArtifacts: LEGACY_RUNTIME_ARTIFACTS,
    hotkeyMigration: {
      removedLegacyDefaults: hotkeyMigration.removedLegacyDefaults,
      preservedCustomBindings: hotkeyMigration.preservedCustomBindings
    }
  };
  await writeJson(path.join(operationRoot, "rollback-manifest.json"), backupManifest);

  for (const [name, source] of sources) await copyFile(source, path.join(stage, name));
  await writeJson(path.join(stage, "community-plugins.json"), mergedCommunity);
  if (hotkeyMigration.changed) await writeJson(path.join(stage, "hotkeys.json"), hotkeyMigration.hotkeys);

  await mkdir(pluginRoot, { recursive: true });
  for (const name of RUNTIME_ARTIFACTS) {
    const destination = path.join(pluginRoot, name);
    if (await isFile(destination)) await copyFile(destination, path.join(backup, name));
  }
  for (const name of LEGACY_RUNTIME_ARTIFACTS) {
    const destination = path.join(pluginRoot, name);
    if (await isFile(destination)) await copyFile(destination, path.join(backup, name));
  }
  const configurationFiles = [
    ["community-plugins.json", communityFile],
    ...(hotkeyMigration.changed ? [["hotkeys.json", hotkeysFile]] : [])
  ];
  for (const [name, file] of configurationFiles) {
    if (await isFile(file)) await copyFile(file, path.join(backup, name));
  }

  const installs = [
    ...RUNTIME_ARTIFACTS.map((name) => [path.join(stage, name), path.join(pluginRoot, name)]),
    [path.join(stage, "community-plugins.json"), communityFile],
    ...(hotkeyMigration.changed ? [[path.join(stage, "hotkeys.json"), hotkeysFile]] : [])
  ];
  try {
    if (
      await digest(communityFile) !== originalCommunityHash
      || (hotkeyMigration.changed && await digest(hotkeysFile) !== originalHotkeysHash)
    ) {
      throw new Error("Obsidian configuration changed during deployment staging; retry after closing Obsidian.");
    }
    for (const [source, destination] of installs) {
      const temporary = `${destination}.notability-live-region-new`;
      await copyFile(source, temporary);
      await rename(temporary, destination);
    }
    for (const name of LEGACY_RUNTIME_ARTIFACTS) {
      const legacy = path.join(pluginRoot, name);
      if (await isFile(legacy)) await rm(legacy);
    }
  } catch (error) {
    for (const name of RUNTIME_ARTIFACTS) {
      const saved = path.join(backup, name);
      if (await isFile(saved)) await copyFile(saved, path.join(pluginRoot, name));
      else await rm(path.join(pluginRoot, name), { force: true });
    }
    for (const name of LEGACY_RUNTIME_ARTIFACTS) {
      const saved = path.join(backup, name);
      if (await isFile(saved)) await copyFile(saved, path.join(pluginRoot, name));
    }
    for (const [name, destination] of configurationFiles) {
      const saved = path.join(backup, name);
      if (await isFile(saved)) await copyFile(saved, destination);
      else await rm(destination, { force: true });
    }
    if (!pluginRootExisted) await rm(pluginRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  return {
    vault,
    pluginRoot,
    backup,
    manifest: path.join(operationRoot, "rollback-manifest.json"),
    hotkeyMigration: {
      removedLegacyDefaults: [...hotkeyMigration.removedLegacyDefaults],
      preservedCustomBindings: [...hotkeyMigration.preservedCustomBindings]
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await deploy();
  const removed = result.hotkeyMigration.removedLegacyDefaults.join(", ") || "none";
  const preserved = result.hotkeyMigration.preservedCustomBindings.join(", ") || "none";
  process.stdout.write(
    `Deployed ${PLUGIN_ID} to ${result.pluginRoot}\n`
    + `Removed legacy default hotkeys: ${removed}\n`
    + `Preserved customized capture hotkeys: ${preserved}\n`
    + `Backup: ${result.backup}\n`
    + `Rollback manifest: ${result.manifest}\n`
  );
}
