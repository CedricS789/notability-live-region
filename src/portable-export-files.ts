import type { DataAdapter } from "obsidian";
import type { NotabilityRegionV1 } from "./model";

export const PORTABLE_EXPORT_STAGING_ROOT = ".tmp";

export type PortableExportFileAsset = {
  path: string;
  region: NotabilityRegionV1;
};

export type PortableExportFilePlan = {
  markdown: string;
  markdownFileName: string;
  destinationPath: string;
  assets: readonly PortableExportFileAsset[];
};

export type PortableExportFileAdapter = Pick<
  DataAdapter,
  "exists" | "mkdir" | "read" | "readBinary" | "write" | "writeBinary" | "rename" | "rmdir"
>;

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}

function childPath(parent: string, child: string): string {
  return `${parent}/${child}`;
}

function validateRelativePath(path: string, label: string): void {
  const parts = path.split("/");
  const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (
    !path
    || path.startsWith("/")
    || path.includes("\\")
    || parts.some((part) => (
      !part
      || part === "."
      || part === ".."
      || /[<>:"|?*]/.test(part)
      || /\p{Cc}/u.test(part)
      || /[. ]$/.test(part)
      || windowsDeviceName.test(part)
    ))
  ) {
    throw new Error(`${label} is not a safe vault-relative path.`);
  }
}

/**
 * Stage and verify a portable bundle before one folder rename makes it
 * visible. The staging directory is new and uniquely owned by this call.
 */
export async function writePortableExportBundle(input: {
  adapter: PortableExportFileAdapter;
  plan: PortableExportFilePlan;
  stagingId: string;
  readAsset(region: NotabilityRegionV1): Promise<ArrayBuffer | null>;
  sourceStillCurrent(): Promise<boolean>;
}): Promise<void> {
  const { adapter, plan } = input;
  if (!/^[a-z0-9-]{8,}$/i.test(input.stagingId)) throw new Error("Portable export staging identity is invalid.");
  validateRelativePath(plan.destinationPath, "Portable export destination");
  validateRelativePath(plan.markdownFileName, "Portable export Markdown filename");
  for (const asset of plan.assets) validateRelativePath(asset.path, "Portable export asset path");

  const stagingPath = childPath(PORTABLE_EXPORT_STAGING_ROOT, `notability-live-region-export-${input.stagingId}`);
  const destinationParent = plan.destinationPath.split("/").slice(0, -1).join("/");
  if (!destinationParent) throw new Error("Portable export destination must be inside an export folder.");
  if (await adapter.exists(plan.destinationPath)) throw new Error("The portable export destination already exists.");
  if (await adapter.exists(stagingPath)) throw new Error("The portable export staging path already exists.");

  if (!(await adapter.exists(PORTABLE_EXPORT_STAGING_ROOT))) await adapter.mkdir(PORTABLE_EXPORT_STAGING_ROOT);
  if (!(await adapter.exists(destinationParent))) await adapter.mkdir(destinationParent);
  await adapter.mkdir(stagingPath);
  let staged = true;
  try {
    const assetFolders = new Set(plan.assets.map((asset) => asset.path.split("/").slice(0, -1).join("/")));
    for (const folder of [...assetFolders].filter(Boolean).sort()) {
      await adapter.mkdir(childPath(stagingPath, folder));
    }

    for (const asset of plan.assets) {
      const data = await input.readAsset(asset.region);
      if (!data) throw new Error(`The cached preview for ${asset.region.id} is missing or unreadable.`);
      const stagedAssetPath = childPath(stagingPath, asset.path);
      await adapter.writeBinary(stagedAssetPath, data);
      const verification = await adapter.readBinary(stagedAssetPath);
      if (!bytesEqual(data, verification)) throw new Error(`Portable export verification failed for ${asset.region.id}.`);
    }

    const stagedMarkdownPath = childPath(stagingPath, plan.markdownFileName);
    await adapter.write(stagedMarkdownPath, plan.markdown);
    if (await adapter.read(stagedMarkdownPath) !== plan.markdown) {
      throw new Error("Portable export Markdown verification failed.");
    }
    if (!(await input.sourceStillCurrent())) {
      throw new Error("The source note changed while the portable export was being prepared. Retry the export.");
    }
    if (await adapter.exists(plan.destinationPath)) throw new Error("The portable export destination was created by another operation.");
    await adapter.rename(stagingPath, plan.destinationPath);
    staged = false;
  } catch (error) {
    if (staged) {
      try {
        if (await adapter.exists(stagingPath)) await adapter.rmdir(stagingPath, true);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Portable export failed and its staging folder could not be removed. Remove ${stagingPath} manually. Original error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    throw error;
  }
}
