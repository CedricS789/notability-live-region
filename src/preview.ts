import type { PreviewDescriptor } from "./cache";

export type RenderedPreview = {
  image: HTMLImageElement;
  metadata: HTMLElement;
};

export type RenderPreviewOptions = {
  loading?: "eager" | "lazy";
};

export type PreviewImageReadiness = "ready" | "error" | "timeout";

/**
 * Native PDF export waits for Markdown processor promises, but an image can
 * still be loading after its element has been inserted. Keep that promise
 * bounded so an unreadable resource URL cannot stall an export indefinitely.
 */
export const PREVIEW_IMAGE_READY_TIMEOUT_MS = 3_000;

function cssPixelValue(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`;
}

export function formatCapturedAt(capturedAt: string): string {
  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) return capturedAt;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

/**
 * Display captures at their preferred CSS size only when the stored raster has
 * enough physical pixels for the current window. On a high-DPI display, a
 * nominally "1x" preview otherwise gets enlarged by the browser and looks
 * softer than the cached PNG really is.
 */
export function applyPreviewImageLayout(image: HTMLImageElement, preview: PreviewDescriptor): void {
  const reportedScale = image.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  const deviceScale = Number.isFinite(reportedScale) && reportedScale > 0 ? reportedScale : 1;
  const densityScale = Math.min(
    1,
    preview.pixelWidth / (preview.cssWidth * deviceScale),
    preview.pixelHeight / (preview.cssHeight * deviceScale)
  );
  image.style.setProperty(
    "--notability-live-region-preview-width",
    cssPixelValue(preview.cssWidth * densityScale)
  );
  image.style.setProperty(
    "--notability-live-region-preview-aspect",
    `${preview.cssWidth} / ${preview.cssHeight}`
  );
}

/**
 * Wait until Chromium reports that an image can be painted. Both decode() and
 * the native load/error events are observed because resource URLs and cached
 * images do not behave identically across Obsidian windows.
 */
export function awaitPreviewImageReady(
  image: HTMLImageElement,
  timeoutMs = PREVIEW_IMAGE_READY_TIMEOUT_MS
): Promise<PreviewImageReadiness> {
  if (image.complete) {
    return Promise.resolve(image.naturalWidth > 0 ? "ready" : "error");
  }

  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : PREVIEW_IMAGE_READY_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let cancelTimeout: (() => void) | null = null;

    const cleanup = (): void => {
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
      cancelTimeout?.();
    };
    const finish = (readiness: PreviewImageReadiness): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(readiness);
    };
    const onLoad = (): void => finish("ready");
    const onError = (): void => finish("error");

    image.addEventListener("load", onLoad, { once: true });
    image.addEventListener("error", onError, { once: true });

    const ownerWindow = image.ownerDocument.defaultView ?? window;
    const handle = ownerWindow.setTimeout(() => finish("timeout"), boundedTimeout);
    cancelTimeout = () => ownerWindow.clearTimeout(handle);

    // The image may have completed between the first check and listener setup.
    if (image.complete) {
      finish(image.naturalWidth > 0 ? "ready" : "error");
      return;
    }

    if (typeof image.decode === "function") {
      try {
        void image.decode().then(
          () => finish("ready"),
          () => {
            // Some custom resource schemes reject decode() before their
            // eventual load event. Let the load/error listeners or bounded
            // timeout decide unless Chromium has reached a terminal state.
            if (image.complete) finish(image.naturalWidth > 0 ? "ready" : "error");
          }
        );
      } catch {
        if (image.complete) finish(image.naturalWidth > 0 ? "ready" : "error");
      }
    }
  });
}

export function renderPreview(
  container: HTMLElement,
  preview: PreviewDescriptor,
  alt: string,
  options: RenderPreviewOptions = {}
): RenderedPreview {
  const document = container.ownerDocument;
  const previewEl = document.win.createDiv();
  previewEl.className = "notability-live-region-preview";

  const image = document.win.createEl("img");
  image.className = "notability-live-region-preview-image";
  image.src = preview.url;
  image.alt = alt;
  image.draggable = false;
  image.loading = options.loading ?? "lazy";
  image.width = preview.pixelWidth;
  image.height = preview.pixelHeight;
  applyPreviewImageLayout(image, preview);
  previewEl.append(image);

  const metadata = document.win.createDiv();
  metadata.className = "notability-live-region-preview-meta";
  metadata.append("Captured ");
  const time = document.win.createEl("time");
  time.dateTime = preview.capturedAt;
  time.textContent = formatCapturedAt(preview.capturedAt);
  metadata.append(time, ". The live note may have changed.");
  previewEl.append(metadata);
  container.append(previewEl);
  return { image, metadata };
}
