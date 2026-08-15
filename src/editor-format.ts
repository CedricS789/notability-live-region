import { REGION_BLOCK_LANGUAGE, parseRegionJson, regionFence, type NotabilityRegionV1 } from "./model";
import {
  defaultRegionLabel,
  markdownRegionLink,
  normalizeMarkdownLinkLabel,
  parseRegionMarkdownUrl
} from "./url-policy";

export type OffsetRange = { from: number; to: number };

export type CopiedRegionLink = {
  label: string;
  url: string;
  region: NotabilityRegionV1;
};

const markdownRegionLinkExpression = /\[((?:\\.|[^\]\\\r\n])*)\]\(([^()\s]+)\)/g;
const entireMarkdownRegionLinkExpression = /^\[((?:\\.|[^\]\\\r\n])*)\]\(([^()\s]+)\)$/;

function unescapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\\([\\[\]])/g, "$1");
}

function validRange(document: string, range: OffsetRange): boolean {
  return Number.isInteger(range.from)
    && Number.isInteger(range.to)
    && range.from >= 0
    && range.to >= range.from
    && range.to <= document.length;
}

export function findRegionFenceAtOffset(document: string, offset: number): { range: OffsetRange; region: NotabilityRegionV1 } | null {
  const expression = new RegExp("(^|\\n)```" + REGION_BLOCK_LANGUAGE + "[\\t ]*\\r?\\n([\\s\\S]*?)\\r?\\n```(?=\\r?\\n|$)", "g");
  for (const match of document.matchAll(expression)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const end = start + match[0].length - (match[1]?.length ?? 0);
    if (offset < start || offset >= end) continue;
    try {
      return { range: { from: start, to: end }, region: parseRegionJson(match[2] ?? "") };
    } catch {
      return null;
    }
  }
  return null;
}

export function findRegionLinkAtOffset(document: string, offset: number): { range: OffsetRange; region: NotabilityRegionV1 } | null {
  for (const match of document.matchAll(markdownRegionLinkExpression)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (offset < from || offset >= to) continue;
    const region = parseRegionMarkdownUrl(match[2] ?? "");
    if (region) return { range: { from, to }, region };
  }
  return null;
}

/** Parse a clipboard value only when the entire trimmed value is one region link. */
export function parseEntireCopiedRegionLink(source: string): CopiedRegionLink | null {
  const trimmed = source.trim();
  const match = entireMarkdownRegionLinkExpression.exec(trimmed);
  if (!match) return null;
  const url = match[2] ?? "";
  const region = parseRegionMarkdownUrl(url);
  if (!region) return null;
  return {
    label: normalizeMarkdownLinkLabel(unescapeMarkdownLinkLabel(match[1] ?? "")),
    url,
    region
  };
}

/** Parse a clipboard value only when it consists of one complete embed fence. */
export function parseStandaloneRegionFence(source: string): NotabilityRegionV1 | null {
  const trimmed = source.trim();
  const escapedLanguage = REGION_BLOCK_LANGUAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`^\`\`\`${escapedLanguage}[\\t ]*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`$`);
  const match = expression.exec(trimmed);
  if (!match) return null;
  try {
    return parseRegionJson(match[1] ?? "");
  } catch {
    return null;
  }
}

export function replaceFence(document: string, range: OffsetRange, region: NotabilityRegionV1): string {
  return `${document.slice(0, range.from)}${regionFence(region)}${document.slice(range.to)}`;
}

export function embedInsertion(selectedText: string, region: NotabilityRegionV1): string {
  const prefix = selectedText.trim() ? `${selectedText}\n\n` : "";
  return `${prefix}${regionFence(region)}`;
}

/**
 * Build a replacement that keeps a block embed valid at any editor range.
 * Markdown fences must begin on their own line and must not run into the
 * document suffix. The caller still performs the actual guarded replacement.
 */
export function embedInsertionAtRange(
  document: string,
  range: OffsetRange,
  selectedText: string,
  region: NotabilityRegionV1
): string {
  if (!validRange(document, range)) {
    throw new Error("The Markdown insertion range is invalid.");
  }
  const before = document.slice(0, range.from);
  const after = document.slice(range.to);
  const leading = before.length === 0 || before.endsWith("\n\n")
    ? ""
    : before.endsWith("\n") ? "\n" : "\n\n";
  const trailing = after.length === 0 || after.startsWith("\n\n")
    ? ""
    : after.startsWith("\n") ? "\n" : "\n\n";
  return `${leading}${embedInsertion(selectedText, region)}${trailing}`;
}

/**
 * Return the exact editor replacement for a plugin clipboard payload.
 * Null deliberately means "leave the paste event alone".
 */
export function buildRegionPasteReplacement(
  document: string,
  range: OffsetRange,
  selectedText: string,
  clipboardText: string
): string | null {
  const copiedLink = parseEntireCopiedRegionLink(clipboardText);
  if (copiedLink) {
    if (!validRange(document, range) || document.slice(range.from, range.to) !== selectedText) return null;
    const selectedLabel = normalizeMarkdownLinkLabel(selectedText);
    return markdownRegionLink(selectedLabel || copiedLink.label || defaultRegionLabel(copiedLink.region), copiedLink.region);
  }

  const embeddedRegion = parseStandaloneRegionFence(clipboardText);
  if (!embeddedRegion) return null;
  if (!validRange(document, range) || document.slice(range.from, range.to) !== selectedText) return null;
  return embedInsertionAtRange(document, range, selectedText, embeddedRegion);
}
