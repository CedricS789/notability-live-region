import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function json(name) {
  return JSON.parse(await readFile(path.join(root, name), "utf8"));
}

const [manifest, packageJson, packageLock, versions] = await Promise.all([
  json("manifest.json"),
  json("package.json"),
  json("package-lock.json"),
  json("versions.json")
]);

assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "manifest version must be SemVer x.y.z");
assert.equal(packageJson.version, manifest.version, "package.json version differs from manifest.json");
assert.equal(packageLock.version, manifest.version, "package-lock.json version differs from manifest.json");
assert.equal(packageLock.packages?.[""]?.version, manifest.version, "lockfile root version differs");
assert.equal(versions[manifest.version], manifest.minAppVersion, "versions.json does not map this release");
assert.equal(manifest.id, "notability-live-region");
assert.equal(manifest.isDesktopOnly, true);
assert.equal(manifest.id.includes("obsidian"), false, "plugin ID must not contain obsidian");
assert.ok(manifest.description.length <= 250, "manifest description exceeds 250 characters");
assert.ok(manifest.description.endsWith("."), "manifest description must end with a period");
assert.equal(packageJson.private, true, "npm publication must remain disabled");
assert.equal(packageJson.license, "MIT");
assert.equal(
  packageJson.repository?.url,
  "git+https://github.com/CedricS789/notability-live-region.git"
);

for (const required of ["README.md", "LICENSE", "manifest.json", "versions.json", "styles.css"]) {
  await access(path.join(root, required));
}

const requestedTag = process.argv[2]
  ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
if (requestedTag) {
  assert.equal(requestedTag, manifest.version, "release tag must exactly match manifest version");
}

process.stdout.write(`Release metadata verified for ${manifest.id} ${manifest.version}.\n`);
