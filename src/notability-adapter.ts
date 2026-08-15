import type { NormalizedRect } from "./model";
import type { CssRect } from "./geometry";
import type { ElectronWebviewElement } from "./webview-types";

export type PageSnapshot = {
  title: string;
  page: number;
  pageCount: number;
  pageRect: { x: number; y: number; width: number; height: number };
  pageAspect: number;
};

/**
 * The selected text is deliberately transient. Callers may use it for the
 * immediate, user-visible Markdown link label, but must not put it in region
 * metadata, cache records, logs, or hidden persisted state.
 */
export type TextSelectionSnapshot = PageSnapshot & {
  rect: NormalizedRect;
  text: string;
};

export type NotabilityTextSelectionErrorCode =
  | "no-selection"
  | "ambiguous-selection"
  | "whitespace-selection"
  | "text-layer-unavailable"
  | "cross-page-selection"
  | "ambiguous-page"
  | "unmappable-selection"
  | "stale-selection"
  | "invalid-response";

export class NotabilityTextSelectionError extends Error {
  constructor(
    public readonly code: NotabilityTextSelectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "NotabilityTextSelectionError";
  }
}

/**
 * Notability renders every logical note page in an ordered page-layout layer.
 * The layer is independent from the optional PDF.js background: native paper,
 * handwriting-only pages, and imported-PDF pages all use the same page frames.
 * We therefore assign ordinals by page-frame DOM order and never trust the
 * PDF asset's data-page-number, which can repeat in mixed notes.
 */
const PAGE_HELPERS = String.raw`
  const noteRoot = () => document.querySelector('main#note-view-container, #note-view-container');
  const usableRect = (element) => {
    const rect = element?.getBoundingClientRect?.();
    return rect && Number.isFinite(rect.left) && Number.isFinite(rect.top) && rect.width > 80 && rect.height > 80
      ? rect
      : null;
  };
  const orderedPageFrames = () => {
    const root = noteRoot();
    if (!root) return { root: null, pages: [] };
    const layers = [...root.querySelectorAll('*')].flatMap((parent) => {
      const style = getComputedStyle(parent);
      if (style.position !== 'absolute' || style.zIndex !== '-2') return [];
      const children = [...parent.children];
      if (!children.length) return [];
      const pages = children.flatMap((element, index) => {
        const rect = usableRect(element);
        const childStyle = getComputedStyle(element);
        if (!rect || childStyle.overflow !== 'hidden') return [];
        return [{ element, rect, page: index + 1 }];
      });
      if (pages.length !== children.length) return [];
      if (pages.some((entry, index) => index > 0 && entry.rect.top < pages[index - 1].rect.top)) return [];
      return [{ parent, pages }];
    }).sort((a, b) => b.pages.length - a.pages.length);
    if (layers.length) {
      const pages = layers[0].pages;
      pages.forEach((entry) => entry.element.setAttribute('data-obsidian-notability-page', String(entry.page)));
      return { root, pages };
    }

    // Compatibility fallback for an older/partially rendered PDF-backed view.
    // Ordinals still come from DOM order, never from PDF data-page-number.
    const seen = new Set();
    const pages = [...root.querySelectorAll('.canvasWrapper canvas, .page canvas')].flatMap((canvas) => {
      if (seen.has(canvas)) return [];
      seen.add(canvas);
      const element = canvas.closest('.page') || canvas.parentElement || canvas;
      const rect = usableRect(canvas);
      if (!rect) return [];
      return [{ element, rect, page: seen.size }];
    });
    pages.forEach((entry) => entry.element.setAttribute('data-obsidian-notability-page', String(entry.page)));
    return { root, pages };
  };
  const dispatchScroll = (root, deltaX, deltaY) => {
    const rect = root.getBoundingClientRect();
    root.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaX,
      deltaY,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }));
  };
`;

const SNAPSHOT_SCRIPT = String.raw`(() => {
  ${PAGE_HELPERS}
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const { root: noteContainer, pages } = orderedPageFrames();
  if (!noteContainer || !pages.length) return { ok: false, reason: 'Notability note page frames are unavailable.' };
  const labelledTitle = noteContainer.getAttribute('aria-labelledby');
  const titleCandidates = [
    labelledTitle ? document.getElementById(labelledTitle)?.textContent : '',
    document.querySelector('input[aria-label*="title" i]')?.value,
    document.querySelector('input[placeholder*="title" i]')?.value,
    document.querySelector('[data-testid*="title" i]')?.textContent,
    document.title.replace(/\s*[|–-]\s*Notability.*$/i, '')
  ];
  const viewportRect = noteContainer.getBoundingClientRect();
  const visible = pages
    .map((entry) => {
      const rect = entry.rect;
      const left = Math.max(rect.left, viewportRect.left);
      const top = Math.max(rect.top, viewportRect.top);
      const right = Math.min(rect.right, viewportRect.right);
      const bottom = Math.min(rect.bottom, viewportRect.bottom);
      return { ...entry, rect, visibleArea: Math.max(0, right - left) * Math.max(0, bottom - top) };
    })
    .sort((a, b) => b.visibleArea - a.visibleArea)[0];
  if (!visible || visible.visibleArea <= 0) return { ok: false, reason: 'No rendered Notability page is visible.' };
  const rect = visible.rect;
  return {
    ok: true,
    title: clean(titleCandidates.find((value) => clean(value))) || 'Notability note',
    page: visible.page,
    pageCount: pages.length,
    pageRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    pageAspect: rect.width / rect.height
  };
})()`;

const exactPageSnapshotScript = (
  page: number,
  captureToken: string | null = null,
  claimToken = false
): string => String.raw`(() => {
  ${PAGE_HELPERS}
  const requestedPage = ${page};
  const captureToken = ${JSON.stringify(captureToken)};
  const claimToken = ${claimToken ? "true" : "false"};
  const captureTokenAttribute = 'data-obsidian-notability-capture-token';
  const captureRegistryKey = Symbol.for('obsidian-notability-capture-pages');
  const captureRegistry = window[captureRegistryKey] instanceof Map
    ? window[captureRegistryKey]
    : (window[captureRegistryKey] = new Map());
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const initial = orderedPageFrames();
  if (!initial.root || !initial.pages.length) {
    return { ok: false, reason: 'Notability note page frames are unavailable.' };
  }
  const target = initial.pages[requestedPage - 1];
  if (!target || target.page !== requestedPage) {
    return { ok: false, reason: 'Requested logical Notability page is unavailable.' };
  }
  if (!target.element.isConnected) {
    return { ok: false, reason: 'Requested logical Notability page is stale.' };
  }
  if (captureToken) {
    if (claimToken) {
      captureRegistry.set(captureToken, target.element);
      target.element.setAttribute(captureTokenAttribute, captureToken);
    } else if (captureRegistry.get(captureToken) !== target.element) {
      return { ok: false, reason: 'Requested logical Notability page identity changed.' };
    }
  }

  // Re-enumerate before returning so a removed, replaced, or reordered frame
  // cannot be reported under the requested logical ordinal.
  const refreshed = orderedPageFrames();
  const current = refreshed.pages[requestedPage - 1];
  if (refreshed.root !== initial.root
    || refreshed.pages.length !== initial.pages.length
    || !current
    || current.page !== requestedPage
    || current.element !== target.element
    || !current.element.isConnected
    || (captureToken && captureRegistry.get(captureToken) !== current.element)) {
    return { ok: false, reason: 'Requested logical Notability page is stale.' };
  }
  const rect = current.rect;
  if (rect.left !== target.rect.left
    || rect.top !== target.rect.top
    || rect.width !== target.rect.width
    || rect.height !== target.rect.height) {
    return { ok: false, reason: 'Requested logical Notability page geometry is stale.' };
  }

  const labelledTitle = initial.root.getAttribute('aria-labelledby');
  const titleCandidates = [
    labelledTitle ? document.getElementById(labelledTitle)?.textContent : '',
    document.querySelector('input[aria-label*="title" i]')?.value,
    document.querySelector('input[placeholder*="title" i]')?.value,
    document.querySelector('[data-testid*="title" i]')?.textContent,
    document.title.replace(/\s*[|–-]\s*Notability.*$/i, '')
  ];
  return {
    ok: true,
    title: clean(titleCandidates.find((value) => clean(value))) || 'Notability note',
    page: current.page,
    pageCount: refreshed.pages.length,
    pageRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    pageAspect: rect.width / rect.height
  };
})()`;

const releasePageCaptureTokenScript = (page: number, captureToken: string): string => String.raw`(() => {
  void ${page};
  const captureToken = ${JSON.stringify(captureToken)};
  const captureRegistry = window[Symbol.for('obsidian-notability-capture-pages')];
  const claimed = captureRegistry instanceof Map ? captureRegistry.get(captureToken) : null;
  if (claimed?.getAttribute?.('data-obsidian-notability-capture-token') === captureToken) {
    claimed.removeAttribute('data-obsidian-notability-capture-token');
  }
  if (captureRegistry instanceof Map) captureRegistry.delete(captureToken);
  let removed = false;
  for (const element of document.querySelectorAll('[data-obsidian-notability-capture-token]')) {
    if (element.getAttribute('data-obsidian-notability-capture-token') === captureToken) {
      element.removeAttribute('data-obsidian-notability-capture-token');
      removed = true;
    }
  }
  return removed || Boolean(claimed);
})()`;

const VIEWPORT_SCRIPT = String.raw`(() => {
  ${PAGE_HELPERS}
  const initial = orderedPageFrames();
  if (!initial.root || !initial.pages.length || !initial.root.isConnected) {
    return { ok: false, reason: 'Notability note viewport is unavailable.' };
  }
  const raw = initial.root.getBoundingClientRect();
  const clientWidth = initial.root.clientWidth > 0 ? initial.root.clientWidth : raw.width;
  const clientHeight = initial.root.clientHeight > 0 ? initial.root.clientHeight : raw.height;
  const contentLeft = raw.left + (initial.root.clientLeft || 0);
  const contentTop = raw.top + (initial.root.clientTop || 0);
  const left = Math.max(0, contentLeft);
  const top = Math.max(0, contentTop);
  const right = Math.min(window.innerWidth, raw.right, contentLeft + clientWidth);
  const bottom = Math.min(window.innerHeight, raw.bottom, contentTop + clientHeight);
  const refreshed = orderedPageFrames();
  if (refreshed.root !== initial.root || refreshed.pages.length !== initial.pages.length || !refreshed.root?.isConnected) {
    return { ok: false, reason: 'Notability note viewport is stale.' };
  }
  return {
    ok: true,
    rect: { x: left, y: top, width: right - left, height: bottom - top }
  };
})()`;

/*
 * This is intentionally separate from SNAPSHOT_SCRIPT. Selection inspection is
 * performed only when the text-selection command explicitly calls it.
 *
 * Page ownership is spatial: PDF asset page numbers are not consulted because
 * imported assets can restart or duplicate those numbers inside one note.
 */
const TEXT_SELECTION_SCRIPT = String.raw`(() => {
  ${PAGE_HELPERS}
  const fail = (code) => ({ ok: false, code });
  const clean = (value) => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const layerSelector = '.textLayer, [data-text-layer-id]';
  const tolerance = 1.5;
  const elementForNode = (node) => node?.nodeType === 1 ? node : node?.parentElement;
  const layerForNode = (node) => elementForNode(node)?.closest?.(layerSelector) || null;
  const finiteRectGeometry = (rect) => rect
    && [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite)
    && rect.width >= 0
    && rect.height >= 0;
  const finiteRect = (rect) => finiteRectGeometry(rect)
    && rect.width > 0
    && rect.height > 0;
  const containsRect = (outer, inner) => inner.left >= outer.left - tolerance
    && inner.top >= outer.top - tolerance
    && inner.right <= outer.right + tolerance
    && inner.bottom <= outer.bottom + tolerance;
  const intersectsRect = (left, right) => Math.min(left.right, right.right) > Math.max(left.left, right.left)
    && Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top);
  const shownInRoot = (element, root) => {
    if (!element?.isConnected || !root.contains(element)) return false;
    for (let current = element; current && current !== root; current = current.parentElement) {
      if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return false;
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  const positiveClientRects = (range) => {
    const raw = [...range.getClientRects()];
    if (raw.some((rect) => rect && !finiteRectGeometry(rect))) return null;
    const positive = raw.filter(finiteRect);
    return positive.length ? positive : null;
  };
  const mapSelectionToPage = (clientRects, pageFrames) => {
    const owners = clientRects.map((rect) => pageFrames.filter((entry) => containsRect(entry.rect, rect)));
    if (owners.some((matches) => matches.length > 1)) {
      return { ok: false, code: 'ambiguous-page' };
    }
    const spatialPages = new Set(owners.flatMap((matches) => matches.map((entry) => entry.page)));
    if (spatialPages.size > 1) return { ok: false, code: 'cross-page-selection' };
    if (owners.some((matches) => matches.length === 0)) {
      const intersectedPages = new Set(clientRects.flatMap((rect) => pageFrames
        .filter((entry) => intersectsRect(entry.rect, rect))
        .map((entry) => entry.page)));
      if (intersectedPages.size > 1) return { ok: false, code: 'cross-page-selection' };
      return { ok: false, code: 'unmappable-selection' };
    }

    const pageNumber = owners[0][0].page;
    if (owners.some((matches) => matches[0].page !== pageNumber)) {
      return { ok: false, code: 'cross-page-selection' };
    }
    const pageEntry = pageFrames.find((entry) => entry.page === pageNumber);
    if (!pageEntry || !pageEntry.element.isConnected) {
      return { ok: false, code: 'stale-selection' };
    }
    return { ok: true, pageEntry };
  };

  const { root, pages } = orderedPageFrames();
  if (!root || !pages.length) return fail('unmappable-selection');

  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return fail('no-selection');
  }
  if (selection.rangeCount !== 1) {
    return fail('ambiguous-selection');
  }

  const range = selection.getRangeAt(0);
  if (!range || range.collapsed) return fail('no-selection');
  const selectedText = clean(selection.toString());
  if (!selectedText) return fail('whitespace-selection');

  const initialSelection = {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset
  };
  const endpointNodes = [
    selection.anchorNode,
    selection.focusNode,
    range.startContainer,
    range.endContainer
  ];
  if ([...endpointNodes, range.commonAncestorContainer].some((node) => !node?.isConnected)) {
    return fail('stale-selection');
  }
  const endpointLayers = endpointNodes.map(layerForNode);
  if (endpointLayers.some((layer) => !layer)) {
    return fail('text-layer-unavailable');
  }
  const layer = endpointLayers[0];
  if (endpointLayers.some((candidate) => candidate !== layer)) {
    return fail('cross-page-selection');
  }
  if (layerForNode(range.commonAncestorContainer) !== layer) {
    return fail('ambiguous-selection');
  }
  if (!shownInRoot(layer, root) || !layer.querySelector('span')) {
    return fail('text-layer-unavailable');
  }
  const eligibleSpanForNode = (node) => {
    const element = elementForNode(node);
    const span = element?.closest?.('span') || null;
    return span
      && layer.contains(span)
      && span.closest(layerSelector) === layer
      && shownInRoot(span, root)
      ? span
      : null;
  };
  if (endpointNodes.some((node) => !eligibleSpanForNode(node))) {
    return fail('text-layer-unavailable');
  }
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!clean(node.nodeValue) || !range.intersectsNode(node)) continue;
    if (!eligibleSpanForNode(node)) return fail('text-layer-unavailable');
  }

  const layerRect = layer.getBoundingClientRect();
  if (!finiteRect(layerRect)) {
    return fail('stale-selection');
  }

  const clientRects = positiveClientRects(range);
  if (!clientRects || clientRects.some((rect) => !containsRect(layerRect, rect))) {
    return fail('stale-selection');
  }
  const initialMapping = mapSelectionToPage(clientRects, pages);
  if (!initialMapping.ok) return fail(initialMapping.code);
  const pageNumber = initialMapping.pageEntry.page;
  const pageEntry = initialMapping.pageEntry;

  const currentSelection = document.getSelection();
  if (!currentSelection || currentSelection.rangeCount !== 1 || currentSelection.isCollapsed) {
    return fail('stale-selection');
  }
  const currentRange = currentSelection.getRangeAt(0);
  if (currentRange.startContainer !== initialSelection.startContainer
    || currentRange.startOffset !== initialSelection.startOffset
    || currentRange.endContainer !== initialSelection.endContainer
    || currentRange.endOffset !== initialSelection.endOffset
    || currentSelection.anchorNode !== initialSelection.anchorNode
    || currentSelection.anchorOffset !== initialSelection.anchorOffset
    || currentSelection.focusNode !== initialSelection.focusNode
    || currentSelection.focusOffset !== initialSelection.focusOffset
    || clean(currentSelection.toString()) !== selectedText
    || !layer.isConnected
    || !pageEntry.element.isConnected) {
    return fail('stale-selection');
  }
  const refreshed = orderedPageFrames();
  const refreshedPage = refreshed.pages.find((entry) => entry.page === pageNumber);
  const currentLayerRect = layer.getBoundingClientRect();
  const currentClientRects = positiveClientRects(currentRange);
  if (refreshed.root !== root
    || refreshed.pages.length !== pages.length
    || !refreshedPage
    || refreshedPage.element !== pageEntry.element
    || !finiteRect(currentLayerRect)
    || !currentClientRects
    || currentClientRects.some((rect) => !containsRect(currentLayerRect, rect))) {
    return fail('stale-selection');
  }
  const currentMapping = mapSelectionToPage(currentClientRects, refreshed.pages);
  if (!currentMapping.ok) return fail(currentMapping.code);
  if (currentMapping.pageEntry !== refreshedPage) return fail('cross-page-selection');

  const union = currentClientRects.reduce((result, rect) => ({
    left: Math.min(result.left, rect.left),
    top: Math.min(result.top, rect.top),
    right: Math.max(result.right, rect.right),
    bottom: Math.max(result.bottom, rect.bottom)
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const pageRect = refreshedPage.rect;
  const left = Math.max(pageRect.left, union.left);
  const top = Math.max(pageRect.top, union.top);
  const right = Math.min(pageRect.right, union.right);
  const bottom = Math.min(pageRect.bottom, union.bottom);
  if (right <= left || bottom <= top) {
    return fail('unmappable-selection');
  }

  const labelledTitle = root.getAttribute('aria-labelledby');
  const titleCandidates = [
    labelledTitle ? document.getElementById(labelledTitle)?.textContent : '',
    document.querySelector('input[aria-label*="title" i]')?.value,
    document.querySelector('input[placeholder*="title" i]')?.value,
    document.querySelector('[data-testid*="title" i]')?.textContent,
    document.title.replace(/\s*[|â€“-]\s*Notability.*$/i, '')
  ];
  return {
    ok: true,
    title: clean(titleCandidates.find((value) => clean(value))) || 'Notability note',
    page: pageEntry.page,
    pageCount: pages.length,
    pageRect: { x: pageRect.left, y: pageRect.top, width: pageRect.width, height: pageRect.height },
    pageAspect: pageRect.width / pageRect.height,
    rect: {
      x: (left - pageRect.left) / pageRect.width,
      y: (top - pageRect.top) / pageRect.height,
      width: (right - left) / pageRect.width,
      height: (bottom - top) / pageRect.height
    },
    text: selectedText
  };
})()`;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateSnapshot(value: unknown): PageSnapshot {
  if (!value || typeof value !== "object") throw new Error("Notability returned no page state.");
  const record = value as Record<string, unknown>;
  if (record.ok !== true) throw new Error(typeof record.reason === "string" ? record.reason : "Notability page DOM is unavailable.");
  const rect = record.pageRect as Record<string, unknown> | undefined;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(finite)) throw new Error("Notability returned invalid page geometry.");
  const page = record.page;
  const pageCount = record.pageCount;
  const pageAspect = record.pageAspect;
  if (!finite(page) || !Number.isInteger(page) || page < 1 || !finite(pageCount) || !Number.isInteger(pageCount) || pageCount < page || !finite(pageAspect) || pageAspect <= 0) {
    throw new Error("Notability returned invalid page ordinals.");
  }
  return {
    title: typeof record.title === "string" ? record.title : "Notability note",
    page,
    pageCount,
    pageRect: { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number },
    pageAspect
  };
}

const TEXT_SELECTION_ERROR_CODES = new Set<NotabilityTextSelectionErrorCode>([
  "no-selection",
  "ambiguous-selection",
  "whitespace-selection",
  "text-layer-unavailable",
  "cross-page-selection",
  "ambiguous-page",
  "unmappable-selection",
  "stale-selection",
  "invalid-response"
]);

const TEXT_SELECTION_ERROR_MESSAGES: Record<NotabilityTextSelectionErrorCode, string> = {
  "no-selection": "Select text from an imported PDF first.",
  "ambiguous-selection": "Select one continuous range entirely inside one PDF text layer.",
  "whitespace-selection": "The PDF text selection contains only whitespace.",
  "text-layer-unavailable": "This content has no live selectable PDF text layer. Use Area selection instead.",
  "cross-page-selection": "Keep the PDF text selection on one page.",
  "ambiguous-page": "The PDF text selection does not map unambiguously to one logical Notability page.",
  "unmappable-selection": "The PDF text selection is outside a logical Notability page. Select it again.",
  "stale-selection": "The PDF text selection or page changed. Select the text again.",
  "invalid-response": "Notability returned invalid PDF text selection state."
};

function selectionErrorCode(value: unknown): NotabilityTextSelectionErrorCode {
  return typeof value === "string" && TEXT_SELECTION_ERROR_CODES.has(value as NotabilityTextSelectionErrorCode)
    ? value as NotabilityTextSelectionErrorCode
    : "invalid-response";
}

function validateTextSelection(value: unknown): TextSelectionSnapshot {
  if (!value || typeof value !== "object") {
    throw new NotabilityTextSelectionError("invalid-response", "Notability returned no PDF text selection state.");
  }
  const record = value as Record<string, unknown>;
  if (record.ok !== true) {
    const code = selectionErrorCode(record.code);
    throw new NotabilityTextSelectionError(
      code,
      TEXT_SELECTION_ERROR_MESSAGES[code]
    );
  }

  let snapshot: PageSnapshot;
  try {
    snapshot = validateSnapshot(record);
  } catch {
    throw new NotabilityTextSelectionError("invalid-response", "Notability returned invalid PDF page state.");
  }

  const rect = record.rect as Record<string, unknown> | undefined;
  const values = rect ? [rect.x, rect.y, rect.width, rect.height] : [];
  if (!rect || values.length !== 4 || !values.every(finite)) {
    throw new NotabilityTextSelectionError("invalid-response", "Notability returned invalid PDF text-selection geometry.");
  }
  const x = rect.x as number;
  const y = rect.y as number;
  const width = rect.width as number;
  const height = rect.height as number;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
    throw new NotabilityTextSelectionError("invalid-response", "Notability returned PDF text-selection geometry outside the page.");
  }

  const text = typeof record.text === "string" ? record.text.normalize("NFC").replace(/\s+/gu, " ").trim() : "";
  if (!text) {
    throw new NotabilityTextSelectionError("whitespace-selection", "The PDF text selection contains only whitespace.");
  }
  return {
    ...snapshot,
    rect: { x, y, width, height },
    text
  };
}

export async function inspectNotabilityPage(webview: ElectronWebviewElement): Promise<PageSnapshot> {
  const snapshot = validateSnapshot(await webview.executeJavaScript(SNAPSHOT_SCRIPT));
  return snapshot;
}

/** Inspect one exact 1-based logical page by ordered Notability page-frame DOM ordinal. */
export async function inspectNotabilityPageAt(
  webview: ElectronWebviewElement,
  page: number,
  captureToken: string | null = null
): Promise<PageSnapshot> {
  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    throw new Error("Notability page ordinal is invalid.");
  }
  if (captureToken !== null && !/^nlr-[a-z0-9-]{8,}$/.test(captureToken)) {
    throw new Error("Notability page capture token is invalid.");
  }
  return validateSnapshot(await webview.executeJavaScript(exactPageSnapshotScript(page, captureToken)));
}

/** Claim one live logical page frame for a bounded capture transaction. */
export async function claimNotabilityPageCapture(
  webview: ElectronWebviewElement,
  page: number,
  captureToken: string
): Promise<PageSnapshot> {
  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    throw new Error("Notability page ordinal is invalid.");
  }
  if (!/^nlr-[a-z0-9-]{8,}$/.test(captureToken)) {
    throw new Error("Notability page capture token is invalid.");
  }
  return validateSnapshot(await webview.executeJavaScript(exactPageSnapshotScript(page, captureToken, true)));
}

export async function releaseNotabilityPageCapture(
  webview: ElectronWebviewElement,
  page: number,
  captureToken: string
): Promise<void> {
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !/^nlr-[a-z0-9-]{8,}$/.test(captureToken)) return;
  await webview.executeJavaScript(releasePageCaptureTokenScript(page, captureToken));
}

/** Visible Notability note viewport, intersected with the guest webview. */
export async function inspectNotabilityViewport(webview: ElectronWebviewElement): Promise<CssRect> {
  const value = await webview.executeJavaScript(VIEWPORT_SCRIPT);
  if (!value || typeof value !== "object") throw new Error("Notability returned no viewport state.");
  const record = value as Record<string, unknown>;
  if (record.ok !== true) {
    throw new Error(typeof record.reason === "string" ? record.reason : "Notability note viewport is unavailable.");
  }
  const rect = record.rect as Record<string, unknown> | undefined;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(finite)) {
    throw new Error("Notability returned invalid viewport geometry.");
  }
  const result = {
    x: rect.x as number,
    y: rect.y as number,
    width: rect.width as number,
    height: rect.height as number
  };
  if (result.x < 0 || result.y < 0 || result.width <= 0 || result.height <= 0) {
    throw new Error("Notability returned an empty note viewport.");
  }
  return result;
}

/** Inspect the current PDF.js selection on explicit user request. */
export async function inspectNotabilityTextSelection(webview: ElectronWebviewElement): Promise<TextSelectionSnapshot> {
  try {
    return validateTextSelection(await webview.executeJavaScript(TEXT_SELECTION_SCRIPT));
  } catch (error) {
    if (error instanceof NotabilityTextSelectionError) throw error;
    throw new NotabilityTextSelectionError("invalid-response", TEXT_SELECTION_ERROR_MESSAGES["invalid-response"]);
  }
}

export async function scrollToPage(webview: ElectronWebviewElement, page: number): Promise<boolean> {
  if (!Number.isInteger(page) || page < 1 || page > 100000) return false;
  const script = `(() => { ${PAGE_HELPERS} const { root, pages } = orderedPageFrames(); const target = pages[${page - 1}]; if (!root || !target) return false; const raw = root.getBoundingClientRect(); const left = Math.max(0, raw.left + (root.clientLeft || 0)); const top = Math.max(0, raw.top + (root.clientTop || 0)); const right = Math.min(window.innerWidth, raw.right, raw.left + (root.clientLeft || 0) + (root.clientWidth || raw.width)); const bottom = Math.min(window.innerHeight, raw.bottom, raw.top + (root.clientTop || 0) + (root.clientHeight || raw.height)); if (right <= left || bottom <= top) return false; const rect = target.element.getBoundingClientRect(); dispatchScroll(root, rect.left + rect.width / 2 - (left + right) / 2, rect.top + rect.height / 2 - (top + bottom) / 2); return true; })()`;
  return (await webview.executeJavaScript(script)) === true;
}

export async function scrollRegionIntoView(webview: ElectronWebviewElement, page: number, rect: NormalizedRect): Promise<boolean> {
  if (!Number.isInteger(page) || page < 1 || page > 100000) return false;
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return false;
  const script = `(() => { ${PAGE_HELPERS} const { root, pages } = orderedPageFrames(); const target = pages[${page - 1}]; if (!root || !target) return false; const raw = root.getBoundingClientRect(); const contentLeft = raw.left + (root.clientLeft || 0); const contentTop = raw.top + (root.clientTop || 0); const viewport = { left: Math.max(0, contentLeft), top: Math.max(0, contentTop), right: Math.min(window.innerWidth, raw.right, contentLeft + (root.clientWidth || raw.width)), bottom: Math.min(window.innerHeight, raw.bottom, contentTop + (root.clientHeight || raw.height)) }; viewport.width = viewport.right - viewport.left; viewport.height = viewport.bottom - viewport.top; if (viewport.width <= 0 || viewport.height <= 0) return false; const r = target.element.getBoundingClientRect(); const x = r.left + ${(rect.x + rect.width / 2).toFixed(8)} * r.width; const y = r.top + ${(rect.y + rect.height / 2).toFixed(8)} * r.height; dispatchScroll(root, x - (viewport.left + viewport.width / 2), y - (viewport.top + viewport.height / 2)); return true; })()`;
  return (await webview.executeJavaScript(script)) === true;
}
