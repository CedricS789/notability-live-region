import { createHash, randomUUID } from "node:crypto";

export const REGION_BLOCK_LANGUAGE = "notability-region";
export const REGION_FRAGMENT_KEY = "obsidian-notability-region";
export const MODEL_VERSION = 1 as const;

export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Stable V1 representation of one complete logical Notability page. */
export const FULL_PAGE_RECT: Readonly<NormalizedRect> = Object.freeze({
  x: 0,
  y: 0,
  width: 1,
  height: 1
});

export function isFullPageRect(rect: NormalizedRect, tolerance = 0.000001): boolean {
  return Math.abs(rect.x) <= tolerance
    && Math.abs(rect.y) <= tolerance
    && Math.abs(rect.width - 1) <= tolerance
    && Math.abs(rect.height - 1) <= tolerance;
}

export type RegionFingerprint =
  | { kind: "text-sha256"; digest: string; characters: number }
  | { kind: "none" };

/** Build a stable fingerprint without retaining the selected PDF text. */
export function textSelectionFingerprint(value: string): RegionFingerprint {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return { kind: "none" };
  return {
    kind: "text-sha256",
    digest: `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`,
    characters: [...normalized].length
  };
}

export type NotabilityRegionV1 = {
  v: 1;
  id: string;
  url: string;
  title: string;
  page: number;
  expectedPageCount: number;
  rect: NormalizedRect;
  pageAspect: number;
  fingerprint: RegionFingerprint;
  adapter: "notability-web-v1";
  capturedAt: string;
};

export class RegionValidationError extends Error {}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RegionValidationError(`${label} must be a finite number.`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number)) {
    throw new RegionValidationError(`${label} must be an integer.`);
  }
  return number;
}

export function validateNormalizedRect(value: unknown): NormalizedRect {
  if (!value || typeof value !== "object") {
    throw new RegionValidationError("rect must be an object.");
  }
  const record = value as Record<string, unknown>;
  const rect = {
    x: finiteNumber(record.x, "rect.x"),
    y: finiteNumber(record.y, "rect.y"),
    width: finiteNumber(record.width, "rect.width"),
    height: finiteNumber(record.height, "rect.height")
  };
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > 1.000001 ||
    rect.y + rect.height > 1.000001
  ) {
    throw new RegionValidationError("rect must remain inside the normalized page bounds.");
  }
  return rect;
}

function validateFingerprint(value: unknown): RegionFingerprint {
  if (!value || typeof value !== "object") {
    throw new RegionValidationError("fingerprint must be an object.");
  }
  const fingerprint = value as Record<string, unknown>;
  if (fingerprint.kind === "none") return { kind: "none" };
  // Existing text fingerprints remain readable. Version 0.3 also emits this
  // fixed-size digest for explicit PDF text selections, never the raw text.
  if (fingerprint.kind === "text-sha256") {
    if (
      typeof fingerprint.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(fingerprint.digest)
    ) {
      throw new RegionValidationError("fingerprint.digest is not a SHA-256 digest.");
    }
    const characters = integer(fingerprint.characters, "fingerprint.characters");
    if (characters < 1) {
      throw new RegionValidationError("fingerprint.characters must be positive.");
    }
    return { kind: "text-sha256", digest: fingerprint.digest, characters };
  }
  throw new RegionValidationError("Unsupported fingerprint kind.");
}

export function validateRegion(value: unknown): NotabilityRegionV1 {
  if (!value || typeof value !== "object") {
    throw new RegionValidationError("Region metadata must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.v !== MODEL_VERSION) {
    throw new RegionValidationError(`Unsupported region version: ${String(record.v)}.`);
  }
  if (typeof record.id !== "string" || !/^nr-[a-z0-9-]{8,}$/.test(record.id)) {
    throw new RegionValidationError("Invalid region id.");
  }
  if (typeof record.url !== "string") throw new RegionValidationError("url must be a string.");
  if (typeof record.title !== "string") throw new RegionValidationError("title must be a string.");
  if (record.adapter !== "notability-web-v1") {
    throw new RegionValidationError("Unsupported Notability adapter.");
  }
  if (typeof record.capturedAt !== "string" || Number.isNaN(Date.parse(record.capturedAt))) {
    throw new RegionValidationError("capturedAt must be an ISO date.");
  }
  const page = integer(record.page, "page");
  const expectedPageCount = integer(record.expectedPageCount, "expectedPageCount");
  if (page < 1 || expectedPageCount < page) {
    throw new RegionValidationError("Page ordinal is outside the captured page count.");
  }
  const pageAspect = finiteNumber(record.pageAspect, "pageAspect");
  if (pageAspect <= 0) throw new RegionValidationError("pageAspect must be positive.");
  return {
    v: MODEL_VERSION,
    id: record.id,
    url: record.url,
    title: record.title,
    page,
    expectedPageCount,
    rect: validateNormalizedRect(record.rect),
    pageAspect,
    fingerprint: validateFingerprint(record.fingerprint),
    adapter: "notability-web-v1",
    capturedAt: record.capturedAt
  };
}

export function canonicalRegionJson(region: NotabilityRegionV1): string {
  const valid = validateRegion(region);
  return `${JSON.stringify(valid, null, 2)}\n`;
}

export function regionFence(region: NotabilityRegionV1): string {
  return `\`\`\`${REGION_BLOCK_LANGUAGE}\n${canonicalRegionJson(region)}\`\`\``;
}

export function parseRegionJson(source: string): NotabilityRegionV1 {
  try {
    return validateRegion(JSON.parse(source));
  } catch (error) {
    if (error instanceof RegionValidationError) throw error;
    throw new RegionValidationError(`Invalid region JSON: ${String(error)}`);
  }
}

export function newRegionId(): string {
  return `nr-${randomUUID()}`;
}

export function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
