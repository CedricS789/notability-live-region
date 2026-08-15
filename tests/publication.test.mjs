import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excludedDirectories = new Set([".git", ".tmp", "node_modules"]);
const excludedFiles = new Set(["main.js"]);
const textualExtensions = new Set([".css", ".json", ".md", ".mjs", ".ts", ".yml", ".yaml"]);
const syntheticNoteIds = new Set([
  "11111111-2222-3333-4444-555555555555",
  "11111111-2222-4333-8444-555555555555",
  "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
]);

async function publicTextFiles(directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await publicTextFiles(absolute));
    else if (!excludedFiles.has(entry.name) && textualExtensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

test("publication tree contains no private paths, known private fixtures, or credential material", async () => {
  const failures = [];
  for (const file of await publicTextFiles()) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    const text = await readFile(file, "utf8");
    for (const [label, expression] of [
      ["Windows user path", /C:\\Users\\/i],
      ["private vault name", new RegExp(["ULB", "MA2"].join("-"), "i")],
      ["retired private note fixture", new RegExp([
        ["cf1ba233", "c875", "4abf", "8ae7", "246103b513c7"].join("-"),
        ["9aa421fd", "6557", "4a01", "8a4a", "6402f7906500"].join("-")
      ].join("|"), "i")],
      ["GitHub token", /\b(?:gho|ghp|github_pat)_[A-Za-z0-9_]+/],
      ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
    ]) {
      if (expression.test(text)) failures.push(`${relative}: ${label}`);
    }
    for (const match of text.matchAll(/notability\.com\/app\/note\/([0-9a-f-]{36})/gi)) {
      const id = match[1]?.toLowerCase();
      if (id && !syntheticNoteIds.has(id)) failures.push(`${relative}: non-synthetic Notability note ID ${id}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("release tree excludes generated and private runtime state", async () => {
  const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
  for (const entry of ["node_modules/", "main.js", ".tmp/", "*.log", ".obsidian/", "cache/", "data.json"]) {
    assert.match(ignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
  await assert.rejects(() => access(path.join(root, "src", "rebuild-ui.ts")));
  await assert.rejects(() => access(path.join(root, "src", "rebuild-runner.ts")));
});

test("policy-sensitive runtime wiring stays publication-safe", async () => {
  const [main, cache, capture, deploy, readme] = await Promise.all([
    readFile(path.join(root, "src", "main.ts"), "utf8"),
    readFile(path.join(root, "src", "cache.ts"), "utf8"),
    readFile(path.join(root, "src", "capture-view.ts"), "utf8"),
    readFile(path.join(root, "scripts", "deploy.mjs"), "utf8"),
    readFile(path.join(root, "README.md"), "utf8")
  ]);
  assert.doesNotMatch(main, /detachLeavesOfType|\.detach\(\)/);
  assert.doesNotMatch(cache, /\.obsidian/);
  assert.match(main, /this\.app\.vault\.configDir/);
  assert.doesNotMatch(capture, /\bdocument\.createEl\(/);
  assert.doesNotMatch(capture, /ownerDocument\.createDiv\(/);
  assert.match(capture, /ownerDocument\.win\.createEl\("webview"\)/);
  assert.match(capture, /document\.win\.createEl\("canvas"\)/);
  assert.doesNotMatch(deploy, /DEFAULT_VAULT/);
  assert.match(deploy, /Set NOTABILITY_LIVE_REGION_VAULT/);
  for (const heading of ["## Quick start", "## Disclosures", "## Privacy and local data", "## Support and security"]) {
    assert.match(readme, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
