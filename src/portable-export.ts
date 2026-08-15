import { parseRegionJson, type NotabilityRegionV1 } from "./model";
import { scanMarkdownRegions } from "./rebuild";
import {
  compactCanonicalRegionJson,
  escapeMarkdownLinkLabel,
  normalizeMarkdownLinkLabel
} from "./url-policy";

export const PORTABLE_EXPORT_ASSET_DIRECTORY = "notability-assets";

export type PortableExportAsset = {
  region: NotabilityRegionV1;
  id: string;
  path: string;
};

export type PortableExportPlan = {
  markdown: string;
  assets: readonly PortableExportAsset[];
  embedCount: number;
};

export class PortableExportConflictError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`Cannot export Notability region ${id}: the same id has conflicting canonical metadata.`);
    this.name = "PortableExportConflictError";
    this.id = id;
  }
}

type CanonicalPortableRegion = {
  region: NotabilityRegionV1;
  metadata: string;
};

function canonicalPortableRegion(region: NotabilityRegionV1): CanonicalPortableRegion {
  const metadata = compactCanonicalRegionJson(region);
  return { region: parseRegionJson(metadata), metadata };
}

function portableAssetPath(id: string): string {
  return `${PORTABLE_EXPORT_ASSET_DIRECTORY}/${id}.png`;
}

function portableImage(region: NotabilityRegionV1, path: string): string {
  const title = normalizeMarkdownLinkLabel(region.title) || "Notability note";
  const alt = escapeMarkdownLinkLabel(`${title}, page ${region.page}`);
  return `![${alt}](${path})`;
}

function portableLinkLabel(markdownLink: string, region: NotabilityRegionV1): string {
  const match = /^\[((?:\\.|[^\]\\\r\n])*)\]\(/.exec(markdownLink);
  if (match) return match[1] ?? "";
  const title = normalizeMarkdownLinkLabel(region.title) || "Notability note";
  return escapeMarkdownLinkLabel(`${title}, page ${region.page}`);
}

function replacementEnd(markdown: string, fenceEnd: number): number {
  return markdown[fenceEnd - 1] === "\r" && markdown[fenceEnd] === "\n"
    ? fenceEnd - 1
    : fenceEnd;
}

/**
 * Replace real top-level Notability region fences with portable PNG embeds.
 * The returned assets are unique and remain ordered by their first embed.
 */
export function planPortableExport(markdown: string): PortableExportPlan {
  const occurrences = scanMarkdownRegions(markdown);
  const fences = occurrences.filter((occurrence) => occurrence.kind === "fence");
  const canonicalById = new Map<string, CanonicalPortableRegion>();
  const assets: PortableExportAsset[] = [];

  for (const fence of fences) {
    const canonical = canonicalPortableRegion(fence.region);
    const existing = canonicalById.get(canonical.region.id);
    if (existing) {
      if (existing.metadata !== canonical.metadata) {
        throw new PortableExportConflictError(canonical.region.id);
      }
      continue;
    }

    canonicalById.set(canonical.region.id, canonical);
    assets.push({
      region: canonical.region,
      id: canonical.region.id,
      path: portableAssetPath(canonical.region.id)
    });
  }

  if (occurrences.length === 0) return { markdown, assets, embedCount: 0 };

  const output: string[] = [];
  let cursor = 0;
  for (const occurrence of occurrences) {
    if (occurrence.kind === "link") {
      output.push(
        markdown.slice(cursor, occurrence.from),
        portableLinkLabel(markdown.slice(occurrence.from, occurrence.to), occurrence.region)
      );
      cursor = occurrence.to;
      continue;
    }

    const canonical = canonicalById.get(occurrence.region.id);
    if (!canonical) throw new Error(`Missing portable export asset for ${occurrence.region.id}.`);
    const path = portableAssetPath(canonical.region.id);
    output.push(markdown.slice(cursor, occurrence.from), portableImage(canonical.region, path));
    cursor = replacementEnd(markdown, occurrence.to);
  }
  output.push(markdown.slice(cursor));

  return {
    markdown: output.join(""),
    assets,
    embedCount: fences.length
  };
}
