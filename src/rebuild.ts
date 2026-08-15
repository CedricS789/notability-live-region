import {
  REGION_BLOCK_LANGUAGE,
  parseRegionJson,
  type NotabilityRegionV1
} from "./model";
import {
  parseRegionMarkdownUrl
} from "./url-policy";

export type MarkdownRegionOccurrenceKind = "link" | "fence";

export type MarkdownRegionOccurrence = {
  sourcePath: string;
  kind: MarkdownRegionOccurrenceKind;
  from: number;
  to: number;
  region: NotabilityRegionV1;
};

const markdownLinkExpression = /\[((?:\\.|[^\]\\\r\n])*)\]\(([^()\s]+)\)/g;

type OpenMarkdownFence = {
  marker: "`" | "~";
  length: number;
  from: number;
  contentFrom: number;
  info: string;
};

type MarkdownCodeFence = {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  info: string;
  closed: boolean;
};

/** Parse top-level CommonMark-style code fences, including unclosed fences. */
function markdownCodeFences(markdown: string): MarkdownCodeFence[] {
  const fences: MarkdownCodeFence[] = [];
  const lines = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  let open: OpenMarkdownFence | null = null;
  let match: RegExpExecArray | null;

  while ((match = lines.exec(markdown)) !== null) {
    if (match[0].length === 0) break;
    const line = match[0].replace(/(?:\r\n|\n|\r)$/, "");
    if (open) {
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)?.[1];
      if (closing && closing[0] === open.marker && closing.length >= open.length) {
        fences.push({
          from: open.from,
          to: match.index + line.length,
          contentFrom: open.contentFrom,
          contentTo: match.index,
          info: open.info,
          closed: true
        });
        open = null;
      }
      continue;
    }

    const openingMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const opening = openingMatch?.[1];
    if (!opening || !openingMatch) continue;
    open = {
      marker: opening[0] as "`" | "~",
      length: opening.length,
      from: match.index,
      contentFrom: match.index + match[0].length,
      info: openingMatch[2]?.trim() ?? ""
    };
  }

  if (open) {
    fences.push({
      from: open.from,
      to: markdown.length,
      contentFrom: open.contentFrom,
      contentTo: markdown.length,
      info: open.info,
      closed: false
    });
  }
  return fences;
}

/**
 * Scan one Markdown string without changing it. Invalid blocks and unrelated
 * links remain source-visible and are simply absent from the returned scan.
 */
export function scanMarkdownRegions(markdown: string, sourcePath = ""): MarkdownRegionOccurrence[] {
  const occurrences: Array<MarkdownRegionOccurrence & { scanOrder: number }> = [];
  const fences = markdownCodeFences(markdown);
  const fenceRanges = fences.map(({ from, to }) => ({ from, to }));
  let scanOrder = 0;

  for (const fence of fences) {
    if (!fence.closed || fence.info !== REGION_BLOCK_LANGUAGE) continue;
    try {
      occurrences.push({
        sourcePath,
        kind: "fence",
        from: fence.from,
        to: fence.to,
        region: parseRegionJson(markdown.slice(fence.contentFrom, fence.contentTo)),
        scanOrder: scanOrder++
      });
    } catch {
      // The existing region parser is the authority; invalid source is ignored.
    }
  }

  for (const match of markdown.matchAll(markdownLinkExpression)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (fenceRanges.some((range) => from >= range.from && to <= range.to)) continue;
    const region = parseRegionMarkdownUrl(match[2] ?? "");
    if (!region) continue;
    occurrences.push({ sourcePath, kind: "link", from, to, region, scanOrder: scanOrder++ });
  }

  return occurrences
    .sort((left, right) => left.from - right.from || left.scanOrder - right.scanOrder)
    .map(({ scanOrder: _scanOrder, ...occurrence }) => occurrence);
}
