import { denormalizeRect, type CssRect } from "./geometry";
import type { NormalizedRect } from "./model";

/** A stable visual contract: a full Notability page is 900 CSS px wide. */
export const CANONICAL_PAGE_DISPLAY_WIDTH = 900;
export const TARGET_PAGE_RASTER_WIDTH = CANONICAL_PAGE_DISPLAY_WIDTH * 2;
export const MAX_CAPTURE_WEBVIEW_ZOOM = 2;
const EDGE_GUARD_PX = 4;
const EPSILON = 0.000001;

export type Size = { width: number; height: number };

export type GuestCaptureMetrics = {
  devicePixelRatio: number;
  viewport: Size;
};

export type CaptureZoomPlan = {
  zoomFactor: number;
  desiredZoom: number;
  viewportFitZoom: number;
};

export type WholePageZoomPlan = {
  zoomFactor: number;
  desiredZoom: number;
};

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive.`);
  return value;
}

function validateNormalizedRect(rect: NormalizedRect): void {
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (
    values.some((value) => !Number.isFinite(value))
    || rect.x < 0
    || rect.y < 0
    || rect.width <= 0
    || rect.height <= 0
    || rect.x + rect.width > 1 + EPSILON
    || rect.y + rect.height > 1 + EPSILON
  ) throw new Error("The saved Notability rectangle is invalid.");
}

/**
 * Choose the smallest useful zoom toward a real 2-raster-pixel/CSS-pixel
 * preview, while keeping the entire region inside the host webview.
 */
export function planCaptureZoom(
  page: CssRect,
  rect: NormalizedRect,
  viewport: Size,
  baseDeviceScale: number
): CaptureZoomPlan {
  validateNormalizedRect(rect);
  positive(page.width, "Page width");
  positive(page.height, "Page height");
  positive(viewport.width, "Viewport width");
  positive(viewport.height, "Viewport height");
  positive(baseDeviceScale, "Device scale");
  const crop = denormalizeRect(rect, page);
  const availableWidth = Math.max(1, viewport.width - EDGE_GUARD_PX * 2);
  const availableHeight = Math.max(1, viewport.height - EDGE_GUARD_PX * 2);
  const viewportFitZoom = Math.min(availableWidth / crop.width, availableHeight / crop.height);
  if (viewportFitZoom < 1 - EPSILON) {
    throw new Error("The selected region is not fully visible at the normal viewer scale.");
  }
  const desiredZoom = TARGET_PAGE_RASTER_WIDTH / (page.width * baseDeviceScale);
  const bounded = Math.max(1, Math.min(MAX_CAPTURE_WEBVIEW_ZOOM, desiredZoom, viewportFitZoom));
  // Round down so floating-point noise never turns a fitting crop into a clip.
  const zoomFactor = Math.max(1, Math.floor(bounded * 1000) / 1000);
  return { zoomFactor, desiredZoom, viewportFitZoom };
}

/**
 * Whole-page capture is tiled, so it is not constrained by viewport fit.
 * Keep the live viewer at normal scale or above and raise its real sampling
 * density toward the same two-raster-pixel target used by area captures.
 */
export function planWholePageZoom(page: CssRect, baseDeviceScale: number): WholePageZoomPlan {
  positive(page.width, "Page width");
  positive(page.height, "Page height");
  positive(baseDeviceScale, "Device scale");
  const desiredZoom = TARGET_PAGE_RASTER_WIDTH / (page.width * baseDeviceScale);
  const bounded = Math.max(1, Math.min(MAX_CAPTURE_WEBVIEW_ZOOM, desiredZoom));
  const zoomFactor = Math.max(1, Math.floor(bounded * 1000) / 1000);
  return { zoomFactor, desiredZoom };
}

/** Map guest CSS geometry to the embedder coordinates expected by capturePage. */
export function captureRectAtZoom(
  rect: NormalizedRect,
  page: CssRect,
  guestViewport: Size,
  hostViewport: Size,
  zoomFactor: number,
  tolerance = 0.75
): CssRect {
  validateNormalizedRect(rect);
  positive(guestViewport.width, "Guest viewport width");
  positive(guestViewport.height, "Guest viewport height");
  positive(hostViewport.width, "Host viewport width");
  positive(hostViewport.height, "Host viewport height");
  positive(zoomFactor, "Capture zoom");
  const raw = denormalizeRect(rect, page);
  if (
    raw.x < -tolerance
    || raw.y < -tolerance
    || raw.x + raw.width > guestViewport.width + tolerance
    || raw.y + raw.height > guestViewport.height + tolerance
  ) throw new Error("The selected region is clipped in the zoomed Notability viewer.");

  const rawLeft = raw.x * zoomFactor;
  const rawTop = raw.y * zoomFactor;
  const rawRight = (raw.x + raw.width) * zoomFactor;
  const rawBottom = (raw.y + raw.height) * zoomFactor;
  if (
    rawLeft < -tolerance * zoomFactor
    || rawTop < -tolerance * zoomFactor
    || rawRight > hostViewport.width + tolerance * zoomFactor
    || rawBottom > hostViewport.height + tolerance * zoomFactor
  ) throw new Error("The zoomed Notability crop falls outside the capture surface.");

  const x = Math.max(0, Math.floor(rawLeft));
  const y = Math.max(0, Math.floor(rawTop));
  const right = Math.min(Math.floor(hostViewport.width), Math.ceil(rawRight));
  const bottom = Math.min(Math.floor(hostViewport.height), Math.ceil(rawBottom));
  if (right <= x || bottom <= y) throw new Error("The zoomed Notability crop is empty.");
  return { x, y, width: right - x, height: bottom - y };
}

/** Stable CSS display size, reduced only when real raster pixels are insufficient. */
export function previewDisplaySize(
  rect: NormalizedRect,
  pageAspect: number,
  raster: Size
): Size {
  validateNormalizedRect(rect);
  positive(pageAspect, "Page aspect");
  positive(raster.width, "Raster width");
  positive(raster.height, "Raster height");
  const idealWidth = rect.width * CANONICAL_PAGE_DISPLAY_WIDTH;
  const idealHeight = rect.height * CANONICAL_PAGE_DISPLAY_WIDTH / pageAspect;
  const realPixelCap = Math.min(1, raster.width / idealWidth, raster.height / idealHeight);
  return {
    width: idealWidth * realPixelCap,
    height: idealHeight * realPixelCap
  };
}

/** Restoration is part of capture success; a failed restore invalidates pixels. */
export function captureResultAfterRestoration<T>(
  result: T | null,
  captureError: unknown,
  restorationError: unknown
): T {
  if (restorationError) {
    const detail = restorationError instanceof Error
      ? restorationError.message
      : typeof restorationError === "string"
        ? restorationError
        : "Unknown restoration error.";
    throw new Error(`Preview discarded because the Notability viewer could not be restored: ${detail}`);
  }
  if (captureError) {
    throw captureError instanceof Error
      ? captureError
      : new Error(typeof captureError === "string" ? captureError : "Unknown preview capture error.");
  }
  if (result === null) throw new Error("The Notability preview capture produced no result.");
  return result;
}

export function validateGuestCaptureMetrics(value: unknown): GuestCaptureMetrics {
  if (!value || typeof value !== "object") throw new Error("The Notability viewer returned no capture metrics.");
  const record = value as Record<string, unknown>;
  const viewport = record.viewport as Record<string, unknown> | undefined;
  const devicePixelRatio = record.devicePixelRatio;
  const width = viewport?.width;
  const height = viewport?.height;
  if (
    typeof devicePixelRatio !== "number"
    || typeof width !== "number"
    || typeof height !== "number"
  ) throw new Error("The Notability viewer returned invalid capture metrics.");
  return {
    devicePixelRatio: positive(devicePixelRatio, "Device scale"),
    viewport: {
      width: positive(width, "Guest viewport width"),
      height: positive(height, "Guest viewport height")
    }
  };
}
