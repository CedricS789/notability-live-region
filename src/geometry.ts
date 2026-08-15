import type { NormalizedRect } from "./model";

export type CssRect = { x: number; y: number; width: number; height: number };

export function normalizeSelection(selection: CssRect, page: CssRect): NormalizedRect {
  const left = Math.max(selection.x, page.x);
  const top = Math.max(selection.y, page.y);
  const right = Math.min(selection.x + selection.width, page.x + page.width);
  const bottom = Math.min(selection.y + selection.height, page.y + page.height);
  if (right - left < 3 || bottom - top < 3 || page.width <= 0 || page.height <= 0) {
    throw new Error("Draw a rectangle inside the rendered page.");
  }
  return {
    x: (left - page.x) / page.width,
    y: (top - page.y) / page.height,
    width: (right - left) / page.width,
    height: (bottom - top) / page.height
  };
}

export function denormalizeRect(rect: NormalizedRect, page: CssRect): CssRect {
  return {
    x: page.x + rect.x * page.width,
    y: page.y + rect.y * page.height,
    width: rect.width * page.width,
    height: rect.height * page.height
  };
}

export function sameCssRect(left: CssRect, right: CssRect, tolerance = 0.75): boolean {
  return Math.abs(left.x - right.x) <= tolerance
    && Math.abs(left.y - right.y) <= tolerance
    && Math.abs(left.width - right.width) <= tolerance
    && Math.abs(left.height - right.height) <= tolerance;
}

/** Convert a normalized crop to integer capture pixels without clipping it. */
export function capturePixelRect(
  rect: NormalizedRect,
  page: CssRect,
  viewport: { width: number; height: number },
  tolerance = 0.75
): CssRect {
  const raw = denormalizeRect(rect, page);
  const values = [raw.x, raw.y, raw.width, raw.height, viewport.width, viewport.height];
  if (values.some((value) => !Number.isFinite(value)) || raw.width <= 0 || raw.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error("The Notability viewer returned invalid crop geometry.");
  }
  if (
    raw.x < -tolerance
    || raw.y < -tolerance
    || raw.x + raw.width > viewport.width + tolerance
    || raw.y + raw.height > viewport.height + tolerance
  ) {
    throw new Error("The selected region moved outside the visible Notability viewer. Select it again.");
  }
  const x = Math.max(0, Math.floor(raw.x));
  const y = Math.max(0, Math.floor(raw.y));
  const right = Math.min(Math.floor(viewport.width), Math.ceil(raw.x + raw.width));
  const bottom = Math.min(Math.floor(viewport.height), Math.ceil(raw.y + raw.height));
  if (right <= x || bottom <= y) throw new Error("The visible Notability crop is empty.");
  return { x, y, width: right - x, height: bottom - y };
}

export function aspectDrift(expected: number, current: number): number {
  if (expected <= 0 || current <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(current - expected) / expected;
}

export function rectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): CssRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}
