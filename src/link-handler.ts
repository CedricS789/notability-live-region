import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  HoverPopover,
  MarkdownRenderChild,
  Notice,
  type HoverParent,
  type MarkdownPostProcessorContext
} from "obsidian";
import type { NotabilityRegionV1 } from "./model";
import { findRegionLinkAtOffset } from "./editor-format";
import type { RegionService } from "./service-types";
import { renderPreview } from "./preview";
import { parseRegionMarkdownUrl } from "./url-policy";

type RegionAnchor = {
  anchor: HTMLAnchorElement;
  region: NotabilityRegionV1;
};

type RegionHoverTarget = {
  target: HTMLElement;
  region: NotabilityRegionV1;
  key: string;
  point?: HoverPoint;
};

type HoverPoint = { x: number; y: number };

function htmlElementFromElement(element: Element, root: HTMLElement): HTMLElement {
  const HTMLElementConstructor = root.ownerDocument.defaultView?.HTMLElement;
  return HTMLElementConstructor && element.instanceOf(HTMLElementConstructor)
    ? element
    : root;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Avoid global DOM constructors because Obsidian pop-out windows have their own realm. */
function elementFromTarget(target: EventTarget | null, root: HTMLElement): Element | null {
  const ElementConstructor = root.ownerDocument.defaultView?.Element;
  return ElementConstructor && target instanceof ElementConstructor ? target : null;
}

function anchorFromTarget(target: EventTarget | null, root: HTMLElement): RegionAnchor | null {
  const element = elementFromTarget(target, root);
  if (!element) return null;
  const candidate = element.closest("a[href]");
  if (!candidate || candidate.tagName.toLowerCase() !== "a" || !root.contains(candidate)) return null;
  const anchor = candidate as HTMLAnchorElement;
  const rawHref = anchor.getAttribute("href") ?? anchor.href;
  const region = parseRegionMarkdownUrl(rawHref);
  return region ? { anchor, region } : null;
}

function movedWithinAnchor(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  const NodeConstructor = anchor.ownerDocument.defaultView?.Node;
  return Boolean(NodeConstructor && event.relatedTarget instanceof NodeConstructor && anchor.contains(event.relatedTarget));
}

function syntaxRegionAtPointer(view: EditorView, event: MouseEvent): RegionHoverTarget | null {
  const target = elementFromTarget(event.target, view.dom);
  if (!target) return null;
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position === null) return null;
  const hit = findRegionLinkAtOffset(view.state.doc.toString(), position);
  const line = target.closest(".cm-line");
  return hit ? {
    target: htmlElementFromElement(line ?? target, view.contentDOM),
    region: hit.region,
    key: `${hit.range.from}:${hit.range.to}`
  } : null;
}

function setPopoverStatus(popover: HoverPopover, message: string, state: "loading" | "missing" | "error"): void {
  popover.hoverEl.replaceChildren();
  popover.hoverEl.classList.remove("has-preview", "is-loading", "is-missing", "is-error");
  popover.hoverEl.classList.add(`is-${state}`);
  const status = popover.hoverEl.ownerDocument.win.createDiv();
  status.className = "notability-live-region-hover-status";
  status.textContent = message;
  popover.hoverEl.append(status);
}

type RuntimeHoverPopover = HoverPopover & { hide(this: HoverPopover): void };

/** Obsidian's runtime exposes hide(), though the public 1.13 type omits it. */
function callNativeHoverPopoverHide(popover: HoverPopover): void {
  (HoverPopover.prototype as RuntimeHoverPopover).hide.call(popover);
}

/** Report native hides even before Component.load(), when register() callbacks do not run. */
class CacheHoverPopover extends HoverPopover {
  private didReportHide = false;

  constructor(
    parent: HoverParent,
    target: HTMLElement,
    private readonly reportHide: (popover: HoverPopover) => void,
    point?: HoverPoint
  ) {
    super(parent, target, undefined, point);
  }

  hide(): void {
    callNativeHoverPopoverHide(this);
    if (this.didReportHide) return;
    this.didReportHide = true;
    this.reportHide(this);
  }
}

function hidePopover(popover: HoverPopover): void {
  (popover as RuntimeHoverPopover).hide();
}

abstract class CacheHoverHost implements HoverParent {
  hoverPopover: HoverPopover | null = null;
  private hoverGeneration = 0;
  private pendingPopover: HoverPopover | null = null;
  private hoverTarget: HTMLElement | null = null;
  private hoverKey: string | null = null;
  private pointerTarget: RegionHoverTarget | null = null;
  private scheduledHide: { window: Window; handle: number } | null = null;
  private readonly modifierKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Control" || event.repeat) return;
    this.showPointerTarget();
  };
  private readonly modifierKeyUp = (event: KeyboardEvent): void => {
    if (event.key === "Control" || !event.ctrlKey) this.hideCachedHover();
  };
  private readonly windowBlur = (): void => {
    this.pointerTarget = null;
    this.hideCachedHover();
  };

  constructor(
    protected readonly service: RegionService,
    private readonly ownerWindow: Window | null
  ) {
    ownerWindow?.addEventListener("keydown", this.modifierKeyDown);
    ownerWindow?.addEventListener("keyup", this.modifierKeyUp);
    ownerWindow?.addEventListener("blur", this.windowBlur);
  }

  private showPointerTarget(): void {
    const pointer = this.pointerTarget;
    if (!pointer) return;
    this.showCachedHover(pointer.target, pointer.region, pointer.key, pointer.point);
  }

  protected trackPointerTarget(
    target: HTMLElement,
    region: NotabilityRegionV1,
    key: string,
    event: MouseEvent,
    point?: HoverPoint
  ): void {
    this.pointerTarget = {
      target,
      region,
      key,
      ...(point ? { point } : {})
    };
    if (event.ctrlKey) this.showPointerTarget();
    else this.hideCachedHover();
  }

  protected clearPointerTarget(event: MouseEvent, document: Document): void {
    this.pointerTarget = null;
    if (event.ctrlKey) this.scheduleCachedHoverHide(document);
    else this.hideCachedHover();
  }

  protected disposeCachedHover(): void {
    this.pointerTarget = null;
    this.ownerWindow?.removeEventListener("keydown", this.modifierKeyDown);
    this.ownerWindow?.removeEventListener("keyup", this.modifierKeyUp);
    this.ownerWindow?.removeEventListener("blur", this.windowBlur);
    this.hideCachedHover();
  }

  private clearScheduledHide(): void {
    if (!this.scheduledHide) return;
    this.scheduledHide.window.clearTimeout(this.scheduledHide.handle);
    this.scheduledHide = null;
  }

  protected scheduleCachedHoverHide(document: Document): void {
    if (this.scheduledHide || (!this.pendingPopover && !this.hoverPopover)) return;
    const window = document.defaultView;
    if (!window) {
      this.hideCachedHover();
      return;
    }
    this.scheduledHide = {
      window,
      handle: window.setTimeout(() => {
        this.scheduledHide = null;
        this.hideCachedHover();
      }, 300)
    };
  }

  protected showCachedHover(
    target: HTMLElement,
    region: NotabilityRegionV1,
    key = region.id,
    point?: HoverPoint
  ): void {
    this.clearScheduledHide();
    if (
      this.hoverTarget === target
      && this.hoverKey === key
      && (this.pendingPopover || this.hoverPopover)
    ) return;
    this.hideCachedHover();
    this.hoverTarget = target;
    this.hoverKey = key;
    const generation = ++this.hoverGeneration;

    // HoverPopover owns its normal show/hide delay and pointer transition from
    // the target into the popover. In particular, its delayed onShow owns the
    // parent hoverPopover slot; preassigning that slot makes it hide itself.
    const popover = new CacheHoverPopover(this, target, (hidden) => {
      if (this.pendingPopover !== hidden && this.hoverPopover !== hidden) return;
      this.clearScheduledHide();
      this.hoverGeneration += 1;
      if (this.pendingPopover === hidden) this.pendingPopover = null;
      this.hoverTarget = null;
      this.hoverKey = null;
    }, point);
    this.pendingPopover = popover;
    popover.hoverEl.classList.add("notability-live-region-hover");
    popover.hoverEl.addEventListener("mouseover", () => this.clearScheduledHide());
    setPopoverStatus(popover, "Loading saved preview...", "loading");
    void this.service.preview(region).then((preview) => {
      if (
        generation !== this.hoverGeneration
        || (this.pendingPopover !== popover && this.hoverPopover !== popover)
        || !target.isConnected
      ) return;
      if (!preview) {
        setPopoverStatus(popover, "No saved preview yet. Open the region to create one.", "missing");
        return;
      }

      popover.hoverEl.replaceChildren();
      popover.hoverEl.classList.remove("is-loading", "is-missing", "is-error");
      popover.hoverEl.classList.add("has-preview");
      const { image } = renderPreview(popover.hoverEl, preview, `${region.title}, page ${region.page}`);
      image.addEventListener("error", () => {
        if (
          generation === this.hoverGeneration
          && (this.pendingPopover === popover || this.hoverPopover === popover)
        ) {
          setPopoverStatus(popover, "The saved preview could not be read.", "error");
        }
      }, { once: true });
    }).catch(() => {
      if (
        generation === this.hoverGeneration
        && (this.pendingPopover === popover || this.hoverPopover === popover)
      ) {
        setPopoverStatus(popover, "The saved preview could not be read.", "error");
      }
    });
  }

  protected hideCachedHover(): void {
    this.clearScheduledHide();
    this.hoverGeneration += 1;
    this.hoverTarget = null;
    this.hoverKey = null;
    const pending = this.pendingPopover;
    this.pendingPopover = null;
    if (pending) hidePopover(pending);
    if (this.hoverPopover && this.hoverPopover !== pending) hidePopover(this.hoverPopover);
  }

  protected open(event: MouseEvent, region: NotabilityRegionV1): void {
    // This method is reached only after strict current-or-legacy URL parsing.
    event.preventDefault();
    event.stopImmediatePropagation();
    this.hideCachedHover();
    void this.service.openRegion(region).catch((error) => {
      new Notice(`Could not open the Notability region: ${messageFrom(error)}`);
    });
  }
}

/** Lifecycle-scoped delegated link handling for one Reading View render section. */
class ReadingLinkHost extends CacheHoverHost {
  pointerOver(anchor: HTMLAnchorElement, region: NotabilityRegionV1, event: MouseEvent): void {
    this.trackPointerTarget(anchor, region, `anchor:${region.id}`, event);
  }

  pointerOut(event: MouseEvent, document: Document): void {
    this.clearPointerTarget(event, document);
  }

  dispose(): void {
    this.disposeCachedHover();
  }

  openRegion(event: MouseEvent, region: NotabilityRegionV1): void {
    this.open(event, region);
  }
}

export class RegionLinkRenderChild extends MarkdownRenderChild {
  private readonly host: ReadingLinkHost;

  constructor(container: HTMLElement, service: RegionService) {
    super(container);
    this.host = new ReadingLinkHost(service, container.ownerDocument.defaultView);

    this.registerDomEvent(
      container,
      "click",
      (event) => {
        const hit = anchorFromTarget(event.target, container);
        if (hit) this.host.openRegion(event, hit.region);
      },
      true
    );
    this.registerDomEvent(container, "mouseover", (event) => {
      const hit = anchorFromTarget(event.target, container);
      if (!hit || movedWithinAnchor(event, hit.anchor)) return;
      this.host.pointerOver(hit.anchor, hit.region, event);
    });
    this.registerDomEvent(container, "mouseout", (event) => {
      const hit = anchorFromTarget(event.target, container);
      if (!hit || movedWithinAnchor(event, hit.anchor)) return;
      this.host.pointerOut(event, container.ownerDocument);
    });
  }

  onunload(): void {
    this.host.dispose();
  }
}

/** Handler suitable for Plugin.registerMarkdownPostProcessor. */
export function readingViewRegionLinksProcessor(service: RegionService) {
  return (element: HTMLElement, context: MarkdownPostProcessorContext): void => {
    context.addChild(new RegionLinkRenderChild(element, service));
  };
}

class LivePreviewRegionLinks extends CacheHoverHost {
  constructor(
    private readonly view: EditorView,
    service: RegionService
  ) {
    super(service, view.dom.ownerDocument.defaultView);
  }

  click(event: MouseEvent): boolean {
    const hit = anchorFromTarget(event.target, this.view.dom);
    if (!hit) return false;
    this.open(event, hit.region);
    return true;
  }

  pointermove(event: MouseEvent): boolean {
    const hit = anchorFromTarget(event.target, this.view.dom);
    if (hit) {
      if (!movedWithinAnchor(event, hit.anchor)) {
        this.trackPointerTarget(hit.anchor, hit.region, `anchor:${hit.region.id}`, event);
      }
      return false;
    }
    const syntax = syntaxRegionAtPointer(this.view, event);
    if (syntax) {
      this.trackPointerTarget(
        syntax.target,
        syntax.region,
        `syntax:${syntax.key}`,
        event,
        { x: event.clientX, y: event.clientY }
      );
    } else {
      this.clearPointerTarget(event, this.view.dom.ownerDocument);
    }
    return false;
  }

  destroy(): void {
    this.disposeCachedHover();
  }
}

/** CodeMirror extension for internal and strictly validated legacy region links. */
export function livePreviewRegionLinksExtension(service: RegionService): Extension {
  return ViewPlugin.define(
    (view) => new LivePreviewRegionLinks(view, service),
    {
      eventHandlers: {
        click(event) {
          return this.click(event);
        },
        mousemove(event) {
          return this.pointermove(event);
        }
      }
    }
  );
}
