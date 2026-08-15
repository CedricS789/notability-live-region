import {
  MarkdownRenderChild,
  Notice,
  setIcon,
  type MarkdownPostProcessorContext
} from "obsidian";
import {
  REGION_BLOCK_LANGUAGE,
  canonicalRegionJson,
  isFullPageRect,
  parseRegionJson,
  type NotabilityRegionV1
} from "./model";
import type { RegionService } from "./service-types";
import { awaitPreviewImageReady, renderPreview } from "./preview";

export type CardMount = {
  dispose(): void;
  /** Resolves when the initial cache-backed card is safe to print. */
  ready: Promise<void>;
  refresh(): Promise<void>;
};

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stable equality key shared by Reading View and Live Preview. Rendering must
 * change whenever any persisted field changes, not merely when the id changes.
 */
export function regionRenderKey(region: NotabilityRegionV1): string {
  return canonicalRegionJson(region);
}

export function mountRegionCard(
  container: HTMLElement,
  region: NotabilityRegionV1,
  service: RegionService,
  compact = false,
  imageLoading: "eager" | "lazy" = "lazy"
): CardMount {
  container.empty();
  const card = container.createDiv({ cls: "notability-live-region-card" });
  card.dataset.regionId = region.id;
  if (compact) card.addClass("is-compact");
  if (isFullPageRect(region.rect)) card.addClass("is-full-page");

  const body = card.createDiv({
    cls: "notability-live-region-placeholder",
    attr: {
      role: "button",
      tabindex: "0",
      "aria-label": `Show ${region.title}, page ${region.page}, in the Notability viewer`
    }
  });
  const controls = card.createDiv({ cls: "notability-live-region-card-controls" });
  controls.createSpan({ text: `${region.title}, p. ${region.page}` });
  controls.createSpan({ cls: "spacer" });

  const openButton = controls.createEl("button", {
    attr: { "aria-label": "Open exact Notability region", type: "button" }
  });
  setIcon(openButton, "panel-right-open");
  const refreshButton = controls.createEl("button", {
    attr: { "aria-label": "Refresh saved preview", type: "button" }
  });
  setIcon(refreshButton, "refresh-cw");

  let disposed = false;
  let renderGeneration = 0;

  const renderMessage = (message: string): void => {
    body.empty();
    body.addClass("notability-live-region-placeholder");
    body.setText(message);
  };

  const renderCache = async (): Promise<void> => {
    const generation = ++renderGeneration;
    renderMessage("Loading saved preview...");
    try {
      const preview = await service.preview(region);
      if (disposed || generation !== renderGeneration) return;
      if (!preview) {
        renderMessage("No saved preview. Open or refresh the region to render it from Notability.");
        return;
      }
      body.empty();
      body.removeClass("notability-live-region-placeholder");
      const { image } = renderPreview(
        body,
        preview,
        `${region.title}, page ${region.page}`,
        { loading: imageLoading }
      );
      const readiness = await awaitPreviewImageReady(image);
      if (disposed || generation !== renderGeneration) return;
      if (readiness === "error") {
        renderMessage("The saved preview could not be read.");
        return;
      }
      if (readiness === "timeout") {
        renderMessage("The saved preview did not finish loading in time.");
        return;
      }
      const ownerWindow = body.ownerDocument.defaultView;
      if (ownerWindow) ownerWindow.dispatchEvent(new ownerWindow.Event("resize"));
    } catch {
      if (disposed || generation !== renderGeneration) return;
      renderMessage("The saved preview could not be read.");
    }
  };

  const openHandler = (event: MouseEvent): void => {
    event.preventDefault();
    void service.openRegion(region).catch((error) => {
      new Notice(`Could not open the Notability region: ${messageFrom(error)}`);
    });
  };
  const openKeyHandler = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void service.openRegion(region).catch((error) => {
      new Notice(`Could not open the Notability region: ${messageFrom(error)}`);
    });
  };
  const refreshHandler = (event: MouseEvent): void => {
    event.preventDefault();
    refreshButton.disabled = true;
    void service
      .refreshRegion(region)
      .catch((error) => {
        new Notice(`Could not refresh the Notability region: ${messageFrom(error)}`);
      })
      .finally(() => {
        if (!disposed) refreshButton.disabled = false;
      });
  };

  openButton.addEventListener("click", openHandler);
  body.addEventListener("click", openHandler);
  body.addEventListener("keydown", openKeyHandler);
  refreshButton.addEventListener("click", refreshHandler);
  let latestRender = renderCache();
  const requestRender = (): Promise<void> => {
    latestRender = renderCache();
    return latestRender;
  };
  const awaitLatestRender = async (initial: Promise<void>): Promise<void> => {
    let observed = initial;
    for (;;) {
      await observed;
      if (observed === latestRender) return;
      observed = latestRender;
    }
  };
  const ready = awaitLatestRender(latestRender);
  const unsubscribeCacheUpdates = service.subscribeCacheUpdates((regionId) => {
    if (!disposed && (regionId === region.id || regionId === "*")) void requestRender();
  });

  return {
    dispose() {
      disposed = true;
      renderGeneration += 1;
      unsubscribeCacheUpdates();
      openButton.removeEventListener("click", openHandler);
      body.removeEventListener("click", openHandler);
      body.removeEventListener("keydown", openKeyHandler);
      refreshButton.removeEventListener("click", refreshHandler);
    },
    ready,
    refresh: async () => await awaitLatestRender(requestRender())
  };
}

function renderInvalidSource(container: HTMLElement, source: string): void {
  container.empty();
  container.createDiv({
    cls: "notability-live-region-error",
    text: "Invalid Notability region metadata. The source is shown unchanged."
  });
  const pre = container.createEl("pre");
  pre.createEl("code", {
    cls: `language-${REGION_BLOCK_LANGUAGE}`,
    text: source
  });
}

export class RegionRenderChild extends MarkdownRenderChild {
  private mount: CardMount | null = null;
  readonly ready: Promise<void>;

  constructor(container: HTMLElement, source: string, service: RegionService) {
    super(container);
    try {
      this.mount = mountRegionCard(container, parseRegionJson(source), service, false, "eager");
      this.ready = this.mount.ready;
    } catch {
      renderInvalidSource(container, source);
      this.ready = Promise.resolve();
    }
  }

  onunload(): void {
    this.mount?.dispose();
    this.mount = null;
  }
}

/** Handler suitable for Plugin.registerMarkdownCodeBlockProcessor. */
export function readingViewRegionProcessor(service: RegionService) {
  return (source: string, element: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> => {
    const child = new RegionRenderChild(element, source, service);
    context.addChild(child);
    return child.ready;
  };
}
