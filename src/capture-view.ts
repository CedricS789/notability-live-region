import { ItemView, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { PreviewCaptureInput, PreviewDescriptor } from "./cache";
import {
  CaptureCancellationGate,
  CaptureCancelledError,
  CaptureSelectionState,
  LatestRequestGate,
  OneShotRegionAlignment,
  canReuseLoadedNote
} from "./capture-state";
import {
  aspectDrift,
  capturePixelRect,
  denormalizeRect,
  normalizeSelection,
  rectFromPoints,
  sameCssRect,
  type CssRect
} from "./geometry";
import { ViewerLatencyTracker, isAuthenticationRedirect, type ViewerLatencySnapshot } from "./latency";
import {
  FULL_PAGE_RECT,
  isFullPageRect,
  newRegionId,
  regionFence,
  textSelectionFingerprint,
  type NormalizedRect,
  type NotabilityRegionV1,
  type RegionFingerprint
} from "./model";
import { encodeBestPreviewImage } from "./native-image";
import {
  assertNotabilityCaptureChromeHidden,
  hideNotabilityCaptureChrome,
  restoreNotabilityCaptureChrome
} from "./notability-capture-chrome";
import {
  NotabilityTextSelectionError,
  claimNotabilityPageCapture,
  inspectNotabilityPage,
  inspectNotabilityPageAt,
  inspectNotabilityViewport,
  releaseNotabilityPageCapture,
  inspectNotabilityTextSelection,
  scrollRegionIntoView,
  scrollToPage,
  type PageSnapshot
} from "./notability-adapter";
import { renderPreview } from "./preview";
import {
  GUEST_CAPTURE_ESCAPE_MESSAGE,
  buildGuestCaptureEscapeSealScript,
  buildGuestCaptureEscapeScript,
  buildSelectionScrollLockScript,
  selectionModeLocksScrolling
} from "./selection-scroll-lock";
import {
  captureRectAtZoom,
  captureResultAfterRestoration,
  planCaptureZoom,
  planWholePageZoom,
  previewDisplaySize,
  TARGET_PAGE_RASTER_WIDTH,
  validateGuestCaptureMetrics
} from "./sharp-capture";
import { defaultRegionLabel, extractNoteId, markdownRegionLink, sanitizeNotabilityNoteUrl, textSelectionLabel } from "./url-policy";
import type { PreparedEmbedInsertion } from "./embed-insertion";
import { prepareNotabilityWebview, type NotabilityWebviewHandle } from "./viewer";
import {
  buildCaptureViewState,
  OpenedRegionModeState,
  parseCaptureViewState,
  type CaptureViewStateV2
} from "./view-state";
import type { ElectronWebviewElement } from "./webview-types";
import {
  assertWholePageCaptureIdentity,
  assertWholePageCapturePhaseLayout,
  captureStableWholePageTile,
  capturedTileSourceRect,
  DEFAULT_WHOLE_PAGE_CAPTURE_LIMITS,
  planWholePageCapture,
  stitchWholePageCapture,
  type WholePageCapturePlan,
  type WholePageEncodedTile,
  type WholePageRect
} from "./whole-page-capture";

type WholePageCanvasSurface = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};

export const NOTABILITY_REGION_VIEW = "notability-live-region-view";

export type CaptureMode = "link" | "embed";
export type InteractionMode = "browse" | "area" | "text";

export class NotabilityViewerUnavailableError extends Error {
  override readonly name = "NotabilityViewerUnavailableError";
}

export interface CaptureHost {
  viewerPartition(): string;
  savePreview(
    region: NotabilityRegionV1,
    bytes: Uint8Array,
    capture: Omit<PreviewCaptureInput, "captureVersion">
  ): Promise<void>;
  preview(region: NotabilityRegionV1): Promise<PreviewDescriptor | null>;
  rememberUrl(url: string): Promise<void>;
  requestLayoutSave(): void;
  focusMarkdownAfterCopy(): Promise<void>;
  resolveEmbedInsertionTarget(leaf: WorkspaceLeaf | null): EmbedInsertionTarget | null;
  prepareEmbedInsertion(leaf: WorkspaceLeaf | null): PreparedEmbedInsertion | null;
}

export type EmbedInsertionTarget = {
  leaf: WorkspaceLeaf;
  label: string;
  identity: object;
};

export { CAPTURE_VIEW_STATE_VERSION, parseCaptureViewState } from "./view-state";

type SelectionState = {
  kind: "area" | "text" | "page";
  pageRect: CssRect;
  rect: NormalizedRect;
  overlayRect: CssRect;
  page: number;
  fingerprint: RegionFingerprint;
  fallbackLabel: string | null;
};

type PendingNavigation = {
  requestId: number;
  url: string;
  targetRegion: NotabilityRegionV1 | null;
  targetMode: InteractionMode;
};

type EmbedDeliveryIntent = {
  requested: boolean;
  insertion: PreparedEmbedInsertion | null;
  targetLeaf: WorkspaceLeaf | null;
  targetLabel: string | null;
};

type WebviewNavigationEvent = Event & {
  errorCode?: number;
  errorDescription?: string;
  isInPlace?: boolean;
  isMainFrame?: boolean;
  url?: string;
};

function sameNormalizedRect(left: NormalizedRect, right: NormalizedRect): boolean {
  const tolerance = 0.000001;
  return Math.abs(left.x - right.x) <= tolerance
    && Math.abs(left.y - right.y) <= tolerance
    && Math.abs(left.width - right.width) <= tolerance
    && Math.abs(left.height - right.height) <= tolerance;
}

function sameFingerprint(left: RegionFingerprint, right: RegionFingerprint): boolean {
  return left.kind === right.kind
    && (left.kind === "none"
      || (right.kind === "text-sha256" && left.digest === right.digest && left.characters === right.characters));
}

function sameNotabilityNote(left: string | null, right: string): boolean {
  if (!left) return false;
  try {
    return extractNoteId(left) === extractNoteId(right);
  } catch {
    return false;
  }
}

export class NotabilityCaptureView extends ItemView {
  private webview: ElectronWebviewElement | null = null;
  private webviewHandle: NotabilityWebviewHandle | null = null;
  private stage: HTMLElement | null = null;
  private shield: HTMLElement | null = null;
  private selectionEl: HTMLElement | null = null;
  private loadingPreviewEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private urlInput: HTMLInputElement | null = null;
  private browseButton: HTMLButtonElement | null = null;
  private areaButton: HTMLButtonElement | null = null;
  private textButton: HTMLButtonElement | null = null;
  private areaFallbackButton: HTMLButtonElement | null = null;
  private copyLinkButton: HTMLButtonElement | null = null;
  private copyEmbedButton: HTMLButtonElement | null = null;
  private copyPageEmbedButton: HTMLButtonElement | null = null;
  private autoInsertButton: HTMLButtonElement | null = null;
  private refreshButton: HTMLButtonElement | null = null;
  private selection: SelectionState | null = null;
  private readonly captureState = new CaptureSelectionState();
  private captureCancellation = new CaptureCancellationGate();
  private readonly navigationRequests = new LatestRequestGate();
  private readonly regionAlignment = new OneShotRegionAlignment();
  private readonly latency = new ViewerLatencyTracker();
  private readonly viewCreatedAt = performance.now();
  private interactionMode: InteractionMode = "browse";
  private attached = false;
  private loaded = false;
  private domReadyHandler: EventListener | null = null;
  private didFinishHandler: EventListener | null = null;
  private didStartHandler: EventListener | null = null;
  private didNavigateHandler: EventListener | null = null;
  private didNavigateInPageHandler: EventListener | null = null;
  private didFailHandler: EventListener | null = null;
  private consoleMessageHandler: EventListener | null = null;
  private readyPromise: Promise<void> | null = null;
  private targetNoteUrl: string | null = null;
  private browseStateUrl: string | null = null;
  private browseStateTitle: string | null = null;
  private browseStatePage: number | null = null;
  private restoredMode: InteractionMode = "browse";
  private readonly openedRegionMode = new OpenedRegionModeState();
  private returnMarkdownLeaf: WorkspaceLeaf | null = null;
  private returnMarkdownTargetIdentity: object | null = null;
  private pendingNavigation: PendingNavigation | null = null;
  private physicalLoad: { requestId: number; url: string } | null = null;
  private navigationGeneration = 0;
  private selectionRequestGeneration = 0;
  private loadingPreviewGeneration = 0;
  private loadingPreviewRequestId: number | null = null;
  private captureInProgress = false;
  private clipboardOperationInProgress = false;
  private pageEmbedPreparing = false;
  private activeCaptureCancellationTicket: number | null = null;
  private captureCancellationChecksSuspended = false;
  private autoInsertEmbeds = false;
  private captureInteractionBlocker: HTMLElement | null = null;
  private captureEscapeHandler: ((event: KeyboardEvent) => void) | null = null;
  private cancelAreaSelectionDrag: (() => boolean) | null = null;
  private guestCaptureEscapeGeneration = 0;
  private guestCaptureEscapeId: string | null = null;
  private guestCaptureEscapeArmed = false;
  private selectionScrollLockGeneration = 0;
  private selectionScrollLockReady = false;

  constructor(leaf: WorkspaceLeaf, private readonly host: CaptureHost) {
    super(leaf);
  }

  getViewType(): string { return NOTABILITY_REGION_VIEW; }
  getDisplayText(): string { return this.browseStateTitle ? `Notability: ${this.browseStateTitle}` : "Notability viewer"; }
  getIcon(): string { return "scan"; }

  noteUrl(): string | null { return this.targetNoteUrl ?? this.browseStateUrl; }

  matchesNote(value: string): boolean {
    return sameNotabilityNote(this.noteUrl(), value);
  }

  setReturnMarkdownLeaf(leaf: WorkspaceLeaf | null): void {
    const previousLeaf = this.returnMarkdownLeaf;
    const previousIdentity = this.returnMarkdownTargetIdentity;
    const target = this.host.resolveEmbedInsertionTarget(leaf);
    this.returnMarkdownLeaf = target?.leaf ?? null;
    this.returnMarkdownTargetIdentity = target?.identity ?? null;
    if (
      this.autoInsertEmbeds
      && previousIdentity !== null
      && target
      && (target.identity !== previousIdentity || target.leaf !== previousLeaf)
    ) {
      this.autoInsertEmbeds = false;
      this.setStatus(`Insert-on-copy was turned off because the Markdown target changed to ${target.label}. Enable it again to confirm the new destination.`);
    } else if (this.autoInsertEmbeds && !target) {
      this.autoInsertEmbeds = false;
      this.setStatus("Insert-on-copy was turned off because its editable Markdown target is no longer available.");
    }
    this.updateControls();
  }

  /** Session-only and scoped to this exact viewer tab. */
  toggleAutoInsertEmbeds(): boolean {
    if (this.captureInProgress || this.clipboardOperationInProgress || this.pageEmbedPreparing) {
      return this.autoInsertEmbeds;
    }
    if (!this.autoInsertEmbeds) {
      const target = this.host.resolveEmbedInsertionTarget(this.returnMarkdownLeaf);
      if (!target) {
        this.returnMarkdownLeaf = null;
        this.updateControls();
        this.setStatus("Insert-on-copy remains off. Put the cursor in an editable Markdown note, then return to this viewer and enable it again.");
        new Notice("Insert on copy needs an editable Markdown target.");
        return false;
      }
      this.returnMarkdownLeaf = target.leaf;
      this.returnMarkdownTargetIdentity = target.identity;
      this.autoInsertEmbeds = true;
      this.updateControls();
      this.setStatus(`Insert-on-copy is on for ${target.label}. Click Copy + insert or Embed page; selecting alone does not start a capture.`);
      return true;
    }
    this.autoInsertEmbeds = false;
    this.updateControls();
    this.setStatus("Insert-on-copy is off for this viewer. Embeds will remain on the clipboard for manual paste.");
    return false;
  }

  /** Ephemeral diagnostics only. This snapshot contains durations and counts, never note identity. */
  latencySnapshot(): ViewerLatencySnapshot { return this.latency.snapshot(); }

  getState(): CaptureViewStateV2 {
    const url = this.noteUrl();
    const region = this.captureState.openedRegion();
    const page = region?.page ?? this.browseStatePage;
    return buildCaptureViewState({
      url,
      title: this.browseStateTitle,
      page,
      mode: this.interactionMode,
      region
    });
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const restored = parseCaptureViewState(state);
    if (!restored) return;
    this.browseStateUrl = restored.url;
    this.browseStateTitle = restored.title ?? restored.region?.title ?? null;
    this.browseStatePage = restored.page;
    this.restoredMode = restored.mode;
    this.setInteractionMode(restored.mode);
    if (restored.region) {
      this.captureState.open(restored.region);
      this.openedRegionMode.open(restored.mode);
    } else {
      this.captureState.clear();
      this.openedRegionMode.clear();
    }
    if (this.urlInput) this.urlInput.value = restored.url ?? "";
    if (!this.webview || !this.attached || !restored.url) return;
    if (restored.region) await this.openRegion(restored.region, { restoredMode: restored.mode });
    else if (!sameNotabilityNote(this.targetNoteUrl, restored.url)) await this.loadUrl(restored.url);
    else if (restored.page) await this.restorePage(restored.page);
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("notability-live-region-view");
    if (this.captureEscapeHandler) this.contentEl.removeEventListener("keydown", this.captureEscapeHandler, true);
    this.captureEscapeHandler = (event) => {
      if (event.key !== "Escape" || event.isComposing || !this.requestCaptureCancellation()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    this.contentEl.addEventListener("keydown", this.captureEscapeHandler, true);

    const toolbar = this.contentEl.createDiv({
      cls: "notability-live-region-toolbar",
      attr: { "aria-label": "Notability viewer controls" }
    });
    toolbar.addEventListener("mousedown", (event) => {
      if (this.interactionMode !== "text" || event.button !== 0) return;
      const target = event.target;
      const ElementConstructor = toolbar.ownerDocument.defaultView?.Element;
      if (!ElementConstructor || !(target instanceof ElementConstructor) || !target.closest("button:not(:disabled)")) return;
      // A mouse press normally moves focus out of the guest webview and can
      // collapse its live PDF selection before the ensuing click is handled.
      // Preventing only that mouse default preserves the selection while
      // leaving keyboard focus and activation semantics unchanged.
      event.preventDefault();
    });
    const addressRow = toolbar.createDiv({ cls: "notability-live-region-address-row" });
    const addressIcon = addressRow.createSpan({ cls: "notability-live-region-address-icon" });
    setIcon(addressIcon, "notebook-pen");
    this.urlInput = addressRow.createEl("input", {
      type: "url",
      placeholder: "https://notability.com/app/note/...",
      attr: {
        "aria-label": "Notability note URL",
        autocomplete: "off",
        spellcheck: "false"
      }
    });
    const loadButton = addressRow.createEl("button", {
      text: "Load",
      cls: "notability-live-region-load",
      attr: { "aria-label": "Load Notability note" }
    });

    const controlRow = toolbar.createDiv({ cls: "notability-live-region-control-row" });
    const modeGroup = controlRow.createDiv({
      cls: "notability-live-region-segmented",
      attr: { role: "group", "aria-label": "Viewer interaction mode" }
    });
    this.browseButton = modeGroup.createEl("button", {
      text: "Browse",
      cls: "notability-live-region-mode",
      attr: { "aria-label": "Browse and scroll Notability", "aria-pressed": "true" }
    });
    this.areaButton = modeGroup.createEl("button", {
      text: "Area",
      cls: "notability-live-region-mode",
      attr: { "aria-label": "Select a rectangular region", "aria-pressed": "false" }
    });
    this.textButton = modeGroup.createEl("button", {
      text: "Text",
      cls: "notability-live-region-mode",
      attr: { "aria-label": "Select PDF text", "aria-pressed": "false" }
    });

    const actionGroup = controlRow.createDiv({
      cls: "notability-live-region-actions",
      attr: { role: "group", "aria-label": "Notability capture actions" }
    });
    this.copyLinkButton = actionGroup.createEl("button", {
      text: "Copy link",
      cls: "mod-cta notability-live-region-copy-link",
      attr: { "aria-label": "Copy internal Notability region link" }
    });
    this.copyEmbedButton = actionGroup.createEl("button", {
      text: "Copy embed",
      cls: "notability-live-region-copy-embed",
      attr: { "aria-label": "Copy Notability region embed" }
    });
    this.copyPageEmbedButton = actionGroup.createEl("button", {
      text: "Embed page",
      cls: "notability-live-region-copy-page",
      attr: { "aria-label": "Copy the entire current Notability page as an embed" }
    });
    this.autoInsertButton = actionGroup.createEl("button", {
      cls: "notability-live-region-auto-insert",
      attr: {
        "aria-label": "Toggle insertion of embeds when copying",
        "aria-pressed": "false",
        title: "Insert embeds on copy: off"
      }
    });
    setIcon(this.autoInsertButton, "clipboard-paste");
    this.refreshButton = actionGroup.createEl("button", {
      text: "Refresh preview",
      cls: "notability-live-region-refresh",
      attr: { "aria-label": "Refresh the saved region preview" }
    });

    this.stage = this.contentEl.createDiv({ cls: "notability-live-region-stage" });
    const statusRow = this.contentEl.createDiv({ cls: "notability-live-region-status-row" });
    this.statusEl = statusRow.createDiv({
      cls: "notability-live-region-status",
      text: "Preparing the Notability viewer.",
      attr: { role: "status", "aria-live": "polite" }
    });
    this.areaFallbackButton = statusRow.createEl("button", {
      text: "Use area",
      cls: "notability-live-region-area-fallback",
      attr: { "aria-label": "Switch to rectangular area selection" }
    });
    this.areaFallbackButton.hide();
    this.latency.leafReady(performance.now() - this.viewCreatedAt);

    loadButton.addEventListener("click", () => this.runToolbarTask("Load note", () => this.loadInputUrl()));
    this.urlInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.runToolbarTask("Load note", () => this.loadInputUrl());
    });
    this.browseButton.addEventListener("click", () => this.chooseInteractionMode("browse"));
    this.areaButton.addEventListener("click", () => this.chooseInteractionMode("area"));
    this.textButton.addEventListener("click", () => this.chooseInteractionMode("text"));
    this.areaFallbackButton.addEventListener("click", () => this.chooseInteractionMode("area"));
    this.copyLinkButton.addEventListener("click", () => this.runToolbarTask("Copy link", () => this.copySelection("link")));
    this.copyEmbedButton.addEventListener("click", () => this.runToolbarTask("Copy embed", () => this.copySelection("embed")));
    this.copyPageEmbedButton.addEventListener("click", () => this.runToolbarTask("Embed page", () => this.copyCurrentPageEmbed()));
    this.autoInsertButton.addEventListener("click", () => this.toggleAutoInsertEmbeds());
    this.refreshButton.addEventListener("click", () => this.runToolbarTask("Refresh preview", () => this.refreshExistingPreview()));
    this.updateControls();

    try {
      await this.createNotabilityWebview();
      this.setStatus("Load a shared Notability note, then choose Area or Text.");
      const initialUrl = this.browseStateUrl ?? this.targetNoteUrl;
      const initialRegion = this.captureState.openedRegion();
      const initialMode = this.restoredMode;
      this.setInteractionMode(initialMode);
      if (initialRegion) this.openedRegionMode.open(initialMode);
      if (initialUrl) await this.loadUrl(initialUrl, initialRegion ?? undefined, initialMode);
      if (!initialRegion && this.browseStatePage) await this.restorePage(this.browseStatePage);
    } catch (error) {
      const errorHost = this.stage?.createDiv({ cls: "notability-live-region-blocker" });
      errorHost?.empty();
      errorHost?.createEl("h3", { text: "Notability viewer unavailable" });
      errorHost?.createEl("p", { text: error instanceof Error ? error.message : String(error) });
      this.setStatus("No Notability page was loaded.");
    }
  }

  async onClose(): Promise<void> {
    if (this.captureEscapeHandler) this.contentEl.removeEventListener("keydown", this.captureEscapeHandler, true);
    this.captureEscapeHandler = null;
    this.cancelAreaSelectionDrag = null;
    this.captureCancellation.cancel();
    this.activeCaptureCancellationTicket = null;
    this.captureCancellationChecksSuspended = false;
    if (this.webview && this.domReadyHandler) this.webview.removeEventListener("dom-ready", this.domReadyHandler);
    if (this.webview && this.didFinishHandler) this.webview.removeEventListener("did-finish-load", this.didFinishHandler);
    if (this.webview && this.didStartHandler) this.webview.removeEventListener("did-start-navigation", this.didStartHandler);
    if (this.webview && this.didNavigateHandler) this.webview.removeEventListener("did-navigate", this.didNavigateHandler);
    if (this.webview && this.didNavigateInPageHandler) this.webview.removeEventListener("did-navigate-in-page", this.didNavigateInPageHandler);
    if (this.webview && this.didFailHandler) this.webview.removeEventListener("did-fail-load", this.didFailHandler);
    if (this.webview && this.consoleMessageHandler) this.webview.removeEventListener("console-message", this.consoleMessageHandler);
    this.consoleMessageHandler = null;
    this.nextGuestCaptureEscapeGeneration();
    this.guestCaptureEscapeId = null;
    this.guestCaptureEscapeArmed = false;
    this.navigationGeneration += 1;
    this.navigationRequests.invalidate();
    this.regionAlignment.cancel();
    this.selectionRequestGeneration += 1;
    this.pendingNavigation = null;
    this.physicalLoad = null;
    this.captureState.clear();
    this.openedRegionMode.clear();
    this.hideLoadingPreview();
    this.setCaptureInteractionBlocked(false);
    this.webviewHandle?.dispose();
    this.webviewHandle = null;
    this.webview?.remove();
    this.webview = null;
    this.stage = null;
    this.shield = null;
    this.selectionEl = null;
    this.loaded = false;
    this.attached = false;
  }

  private async createNotabilityWebview(): Promise<void> {
    if (!this.stage) throw new Error("The Notability surface is unavailable.");
    const attachmentStartedAt = performance.now();
    const webview = this.stage.ownerDocument.win.createEl("webview");
    webview.classList.add("notability-live-region-webview");
    webview.setAttribute("aria-label", "Notability note viewer");
    this.webviewHandle = prepareNotabilityWebview(webview, this.host.viewerPartition());
    let resolveReady: (() => void) | null = null;
    this.readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.domReadyHandler = () => {
      if (!this.attached) {
        this.attached = true;
        // Guest CSS pixels and capturePage pixels must remain identical.
        webview.setZoomFactor(1);
        this.latency.webviewAttached(performance.now() - attachmentStartedAt);
        resolveReady?.();
      }
      // Every replacement document needs its own trusted-input scroll guard.
      this.syncGuestSelectionScrollLock();
    };
    this.didFinishHandler = () => {
      const unexpected = this.isUnexpectedPendingNavigation(webview.getURL());
      if (!unexpected) this.loaded = webview.getURL() !== "about:blank";
      this.syncGuestSelectionScrollLock();
      if (unexpected) return;
      this.latency.navigationFinished();
      this.updateControls();
      if (this.loaded) void this.afterPageLoad();
    };
    this.didStartHandler = (event) => {
      const navigation = event as WebviewNavigationEvent;
      if (navigation.isMainFrame === false || navigation.isInPlace === true) return;
      this.selectionScrollLockGeneration += 1;
      this.selectionScrollLockReady = false;
      this.applyInteractionShield();
      this.updateControls();
      if (this.pendingNavigation && isAuthenticationRedirect(navigation.url)) {
        this.latency.authenticationRedirect();
      }
      if (this.isUnexpectedPendingNavigation(navigation.url)) return;
      this.navigationGeneration += 1;
      this.loaded = false;
      this.captureState.clear();
      if (!this.pendingNavigation?.targetRegion) {
        this.openedRegionMode.clear();
        this.regionAlignment.cancel();
      }
      this.clearSelectionGeometry();
      if (
        this.loadingPreviewRequestId === null
        || !this.navigationRequests.isCurrent(this.loadingPreviewRequestId)
      ) this.hideLoadingPreview();
    };
    this.didNavigateHandler = (event) => this.commitNavigation(event, false);
    // In-page history/route noise may describe ordinary user scrolling. It can
    // update the canonical URL, but must never re-arm saved-region alignment.
    this.didNavigateInPageHandler = (event) => this.commitNavigation(event, false);
    this.didFailHandler = (event) => {
      const failure = event as WebviewNavigationEvent;
      if (failure.isMainFrame === false || failure.errorCode === -3) return;
      if (this.isUnexpectedPendingNavigation(failure.url)) return;
      this.selectionScrollLockGeneration += 1;
      this.selectionScrollLockReady = false;
      this.applyInteractionShield();
      this.navigationGeneration += 1;
      this.loaded = false;
      this.pendingNavigation = null;
      this.regionAlignment.cancel();
      this.captureState.clear();
      this.openedRegionMode.clear();
      this.clearSelectionGeometry();
      this.hideLoadingPreview();
      if (this.targetNoteUrl) {
        this.browseStateUrl = this.targetNoteUrl;
        if (this.urlInput) this.urlInput.value = this.targetNoteUrl;
      } else {
        this.browseStateUrl = null;
        if (this.urlInput) this.urlInput.value = "";
      }
      this.host.requestLayoutSave();
      this.setStatus(`Notability failed to load${failure.errorDescription ? `: ${failure.errorDescription}` : "."}`);
    };
    this.consoleMessageHandler = (event) => this.handleGuestConsoleMessage(event);
    webview.addEventListener("dom-ready", this.domReadyHandler);
    webview.addEventListener("did-finish-load", this.didFinishHandler);
    webview.addEventListener("did-start-navigation", this.didStartHandler);
    webview.addEventListener("did-navigate", this.didNavigateHandler);
    webview.addEventListener("did-navigate-in-page", this.didNavigateInPageHandler);
    webview.addEventListener("did-fail-load", this.didFailHandler);
    webview.addEventListener("console-message", this.consoleMessageHandler);
    this.stage.appendChild(webview);
    this.webview = webview;
    this.shield = this.stage.createDiv({
      cls: "notability-live-region-shield",
      attr: { "aria-label": "Drag to select a Notability region" }
    });
    this.selectionEl = this.stage.createDiv({ cls: "notability-live-region-selection" });
    this.selectionEl.hide();
    this.installSelectionHandlers(this.shield);
    this.setInteractionMode("browse");
    await Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("Notability viewer attachment timed out.")), 8000))
    ]);
  }

  private installSelectionHandlers(shield: HTMLElement): void {
    let start: { x: number; y: number } | null = null;
    let pointerId: number | null = null;
    shield.tabIndex = -1;
    const relativePoint = (event: PointerEvent) => {
      const rect = shield.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const cancelDrag = (): boolean => {
      if (!start) return false;
      const capturedPointer = pointerId;
      start = null;
      pointerId = null;
      if (capturedPointer !== null && shield.hasPointerCapture(capturedPointer)) {
        shield.releasePointerCapture(capturedPointer);
      }
      this.clearSelectionGeometry();
      this.setStatus("Selection cancelled. Drag again to select a region.");
      return true;
    };
    this.cancelAreaSelectionDrag = cancelDrag;
    shield.addEventListener("pointerdown", (event) => {
      if (
        this.captureInProgress
        || this.clipboardOperationInProgress
        || this.pageEmbedPreparing
        || this.activeCaptureCancellationTicket != null
        || this.interactionMode !== "area"
        || !event.isPrimary
        || event.button !== 0
      ) return;
      start = relativePoint(event);
      pointerId = event.pointerId;
      shield.setPointerCapture(event.pointerId);
      shield.focus({ preventScroll: true });
      this.detachOpenedRegionForManualNavigation();
      this.setStatus("Selecting a new region...");
    });
    shield.addEventListener("pointermove", (event) => {
      if (this.captureInProgress || !start || !this.selectionEl) return;
      this.paintSelection(rectFromPoints(start, relativePoint(event)));
    });
    shield.addEventListener("pointerup", (event) => {
      if (this.captureInProgress || !start) return;
      const selected = rectFromPoints(start, relativePoint(event));
      start = null;
      if (pointerId !== null && shield.hasPointerCapture(pointerId)) shield.releasePointerCapture(pointerId);
      pointerId = null;
      const cancellationTicket = this.beginCaptureCancellation();
      this.updateControls();
      this.setStatus("Checking the selected area... Press Esc to cancel.");
      this.runToolbarTask("Selection", async () => {
        try {
          await this.finalizeSelection(selected, cancellationTicket);
        } finally {
          this.finishCaptureCancellation(cancellationTicket);
          this.updateControls();
        }
      });
    });
    shield.addEventListener("pointercancel", () => {
      cancelDrag();
    });
    shield.addEventListener("wheel", (event) => {
      if (this.interactionMode === "browse") return;
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });
  }

  private chooseInteractionMode(mode: InteractionMode): void {
    if (this.captureInProgress) return;
    // Clicking Area or Text always starts a fresh capture intent, even when
    // that mode is already selected. This cancels an older saved-region
    // alignment before the user begins the new drag or PDF text selection.
    if (mode !== "browse" || mode !== this.interactionMode) {
      this.detachOpenedRegionForManualNavigation();
    }
    this.setInteractionMode(mode);
  }

  private detachOpenedRegionForManualNavigation(): void {
    const pendingTarget = this.pendingNavigation?.targetRegion ?? null;
    if (
      !this.captureState.openedRegion()
      && !this.captureState.reusableRegion()
      && !this.selection
      && !this.loadingPreviewEl
      && !pendingTarget
      && this.loadingPreviewRequestId === null
    ) return;
    this.navigationGeneration += 1;
    this.regionAlignment.cancel();
    // Preserve an in-flight note load, but strip its old rectangle target so
    // the eventual navigation commit cannot reopen and align that region.
    if (pendingTarget && this.pendingNavigation) {
      this.pendingNavigation.targetRegion = null;
    }
    this.captureState.clear();
    this.openedRegionMode.clear();
    this.clearSelectionGeometry();
    this.hideLoadingPreview();
    this.host.requestLayoutSave();
  }

  private syncGuestSelectionScrollLock(): void {
    const webview = this.webview;
    if (!webview || !this.attached) return;
    const generation = ++this.selectionScrollLockGeneration;
    const locked = selectionModeLocksScrolling(this.interactionMode);
    this.selectionScrollLockReady = false;
    this.applyInteractionShield();
    const script = buildSelectionScrollLockScript(locked, generation);
    // Navigation can replace the guest document while this request is in
    // flight. Only an acknowledgement for the latest document/mode may expose
    // Text pointer input; failures leave the host shield in place.
    void webview.executeJavaScript<unknown>(script).then((value) => {
      if (generation !== this.selectionScrollLockGeneration || webview !== this.webview) return;
      const result = value && typeof value === "object" ? value as Record<string, unknown> : null;
      if (result?.generation !== generation || result.locked !== locked) {
        throw new Error("Notability returned an invalid selection scroll-lock acknowledgement.");
      }
      this.selectionScrollLockReady = true;
      this.applyInteractionShield();
      this.updateControls();
    }).catch(() => {
      if (generation !== this.selectionScrollLockGeneration || webview !== this.webview) return;
      this.selectionScrollLockReady = false;
      this.applyInteractionShield();
      this.updateControls();
      this.setStatus(this.interactionMode === "browse"
        ? "Browse scrolling could not be restored. Reload the note and try again."
        : `${this.interactionMode === "area" ? "Area" : "Text"} mode is blocked because scrolling could not be locked. Switch to Browse, then try again.`);
    });
  }

  private applyInteractionShield(): void {
    if (!this.shield) return;
    const textPending = this.interactionMode === "text"
      && (!this.loaded || !this.selectionScrollLockReady);
    const shieldOwnsPointer = this.interactionMode === "area" || textPending;
    this.shield.style.pointerEvents = shieldOwnsPointer ? "auto" : "none";
    this.shield.style.cursor = this.interactionMode === "area"
      ? "crosshair"
      : textPending
        ? "wait"
        : "default";
  }

  private async finalizeSelection(selected: CssRect, cancellationTicket?: number): Promise<void> {
    const webview = this.webview;
    if (!webview || this.captureInProgress) return;
    if (cancellationTicket !== undefined) this.captureCancellation.assertCurrent(cancellationTicket);
    const generation = this.navigationGeneration;
    const requestGeneration = ++this.selectionRequestGeneration;
    try {
      const snapshot = await inspectNotabilityPage(webview);
      if (cancellationTicket !== undefined) this.captureCancellation.assertCurrent(cancellationTicket);
      if (
        webview !== this.webview
        || generation !== this.navigationGeneration
        || requestGeneration !== this.selectionRequestGeneration
      ) return;
      const rect = normalizeSelection(selected, snapshot.pageRect);
      const overlayRect = denormalizeRect(rect, snapshot.pageRect);
      this.selection = {
        kind: "area",
        pageRect: snapshot.pageRect,
        rect,
        overlayRect,
        page: snapshot.page,
        fingerprint: { kind: "none" },
        fallbackLabel: null
      };
      this.paintSelection(overlayRect);
      this.showPageSnapshot(snapshot);
      this.updateControls();
      this.setStatus(`Selected an area on page ${snapshot.page}. Copy a link or embed.`);
    } catch (error) {
      if (cancellationTicket !== undefined && !this.captureCancellation.isCurrent(cancellationTicket)) {
        throw new CaptureCancelledError();
      }
      if (
        webview !== this.webview
        || generation !== this.navigationGeneration
        || requestGeneration !== this.selectionRequestGeneration
      ) return;
      this.clearSelectionGeometry();
      throw error;
    }
  }

  private async finalizeTextSelection(): Promise<void> {
    const webview = this.webview;
    if (!webview || this.captureInProgress) return;
    const generation = this.navigationGeneration;
    const requestGeneration = ++this.selectionRequestGeneration;
    try {
      const snapshot = await inspectNotabilityTextSelection(webview);
      if (
        webview !== this.webview
        || generation !== this.navigationGeneration
        || requestGeneration !== this.selectionRequestGeneration
      ) return;
      const overlayRect = denormalizeRect(snapshot.rect, snapshot.pageRect);
      const fingerprint = textSelectionFingerprint(snapshot.text);
      const previous = this.selection;
      const sameSelection = previous?.kind === "text"
        && previous.page === snapshot.page
        && sameNormalizedRect(previous.rect, snapshot.rect)
        && sameFingerprint(previous.fingerprint, fingerprint);
      if (!sameSelection) {
        this.detachOpenedRegionForManualNavigation();
      }
      this.selection = {
        kind: "text",
        pageRect: snapshot.pageRect,
        rect: snapshot.rect,
        overlayRect,
        page: snapshot.page,
        fingerprint,
        fallbackLabel: textSelectionLabel(snapshot.text)
      };
      this.paintSelection(overlayRect);
      this.showPageSnapshot(snapshot);
      this.updateControls();
      this.setStatus(`Selected PDF text on page ${snapshot.page}. The words will be used only as a transient link label.`);
    } catch (error) {
      if (
        webview !== this.webview
        || generation !== this.navigationGeneration
        || requestGeneration !== this.selectionRequestGeneration
      ) return;
      this.clearSelectionGeometry();
      if (error instanceof NotabilityTextSelectionError) {
        this.setStatus(error.message, true);
      }
      throw error;
    }
  }

  private paintSelection(rect: CssRect): void {
    if (!this.selectionEl) return;
    this.selectionEl.show();
    this.selectionEl.style.left = `${rect.x}px`;
    this.selectionEl.style.top = `${rect.y}px`;
    this.selectionEl.style.width = `${rect.width}px`;
    this.selectionEl.style.height = `${rect.height}px`;
  }

  private setInteractionMode(mode: InteractionMode, persist = true): void {
    if (this.captureInProgress) return;
    const changed = this.interactionMode !== mode;
    this.interactionMode = mode;
    this.syncGuestSelectionScrollLock();
    this.browseButton?.classList.toggle("is-active", mode === "browse");
    this.areaButton?.classList.toggle("is-active", mode === "area");
    this.textButton?.classList.toggle("is-active", mode === "text");
    this.browseButton?.setAttribute("aria-pressed", String(mode === "browse"));
    this.areaButton?.setAttribute("aria-pressed", String(mode === "area"));
    this.textButton?.setAttribute("aria-pressed", String(mode === "text"));
    this.applyInteractionShield();
    if (changed) {
      this.clearSelectionGeometry();
      if (!this.captureState.openedRegion()) this.captureState.clear();
      if (persist) this.host.requestLayoutSave();
    }
    this.updateControls();
    this.setStatus(mode === "browse"
      ? "Browse mode: you are interacting with Notability's web app. Notability owns editing and synchronization."
      : mode === "area"
        ? "Area mode: wheel and trackpad scrolling are locked. Position the page in Browse, then return here and drag a rectangle."
        : "Text mode: wheel and trackpad scrolling are locked. Position the page in Browse, then return here and select imported-PDF text with Notability's Pointer tool.");
  }

  private isUnexpectedPendingNavigation(value: string | undefined): boolean {
    const pending = this.pendingNavigation;
    if (!pending || !this.navigationRequests.isCurrent(pending.requestId) || !value) return false;
    try {
      return !sameNotabilityNote(pending.url, sanitizeNotabilityNoteUrl(value));
    } catch {
      // about:blank is the expected pre-load state. Any other non-note main
      // frame event cannot belong to the currently pending canonical note.
      return value !== "about:blank";
    }
  }

  private commitNavigation(event: WebviewNavigationEvent, rerunAfterLoad: boolean): void {
    if (event.isMainFrame === false) return;
    const value = event.url ?? this.webview?.getURL();
    if (!value) return;
    let canonicalUrl: string;
    try {
      canonicalUrl = sanitizeNotabilityNoteUrl(value);
    } catch {
      return;
    }

    const pendingNavigation = this.pendingNavigation;
    if (
      pendingNavigation
      && this.navigationRequests.isCurrent(pendingNavigation.requestId)
      && !sameNotabilityNote(pendingNavigation.url, canonicalUrl)
    ) {
      // An older load can still emit a late navigation event after a newer
      // request has started. Keep the latest pending target intact.
      return;
    }
    if (pendingNavigation && this.navigationRequests.isCurrent(pendingNavigation.requestId)) this.pendingNavigation = null;
    if (pendingNavigation && this.navigationRequests.isCurrent(pendingNavigation.requestId) && sameNotabilityNote(pendingNavigation.url, canonicalUrl)) {
      this.captureState.clear();
      this.openedRegionMode.clear();
      if (pendingNavigation.targetRegion) {
        this.captureState.open(pendingNavigation.targetRegion);
        this.openedRegionMode.open(pendingNavigation.targetMode);
      }
    } else if (!sameNotabilityNote(this.targetNoteUrl, canonicalUrl)) {
      // Notability may switch notes through an in-page SPA route. Treat that
      // as a real document identity change even though Electron did not emit a
      // full navigation start: an old rectangle must never remain copyable on
      // the newly displayed note.
      this.navigationGeneration += 1;
      this.regionAlignment.cancel();
      this.captureState.clear();
      this.openedRegionMode.clear();
      this.clearSelectionGeometry();
      this.hideLoadingPreview();
      this.browseStateTitle = null;
      this.browseStatePage = null;
    } else if (this.captureState.openedRegion() && !sameNotabilityNote(this.captureState.openedRegion()!.url, canonicalUrl)) {
      this.regionAlignment.cancel();
      this.captureState.clear();
      this.openedRegionMode.clear();
    }

    this.targetNoteUrl = canonicalUrl;
    this.browseStateUrl = canonicalUrl;
    if (this.urlInput) this.urlInput.value = canonicalUrl;
    this.loaded = true;
    this.updateControls();
    this.host.requestLayoutSave();
    if (rerunAfterLoad) void this.afterPageLoad();
  }

  private clearSelectionGeometry(): void {
    this.selectionRequestGeneration += 1;
    this.selection = null;
    this.selectionEl?.hide();
    this.updateControls();
  }

  private updateControls(): void {
    const hasSelection = this.selection !== null;
    const opened = this.captureState.openedRegion();
    const operationInProgress = this.captureInProgress
      || this.clipboardOperationInProgress
      || this.pageEmbedPreparing
      || this.activeCaptureCancellationTicket != null;
    const refreshMatches = Boolean(
      opened
      && this.selection
      && this.selection.page === opened.page
      && sameNormalizedRect(this.selection.rect, opened.rect)
    );
    const textReady = this.interactionMode !== "text" || this.selectionScrollLockReady;
    const canCopy = (hasSelection || (this.interactionMode === "text" && this.loaded))
      && textReady
      && !operationInProgress;
    if (this.copyLinkButton) this.copyLinkButton.disabled = !canCopy;
    if (this.copyEmbedButton) {
      this.copyEmbedButton.disabled = !canCopy;
      this.copyEmbedButton.textContent = this.autoInsertEmbeds ? "Copy + insert" : "Copy embed";
      this.copyEmbedButton.setAttribute(
        "aria-label",
        this.autoInsertEmbeds ? "Copy and insert Notability region embed" : "Copy Notability region embed"
      );
    }
    if (this.copyPageEmbedButton) {
      this.copyPageEmbedButton.disabled = !this.loaded || operationInProgress;
    }
    if (this.autoInsertButton) {
      const target = this.autoInsertEmbeds
        ? this.host.resolveEmbedInsertionTarget(this.returnMarkdownLeaf)
        : null;
      this.autoInsertButton.disabled = operationInProgress;
      this.autoInsertButton.classList.toggle("is-active", this.autoInsertEmbeds);
      this.autoInsertButton.setAttribute("aria-pressed", String(this.autoInsertEmbeds));
      this.autoInsertButton.title = this.autoInsertEmbeds
        ? `Insert embeds on copy: on${target ? ` → ${target.label}` : " (target unavailable)"}`
        : "Insert embeds on copy: off";
      this.autoInsertButton.setAttribute("aria-label", this.autoInsertButton.title);
    }
    if (this.refreshButton) this.refreshButton.disabled = !refreshMatches || operationInProgress;
  }

  private showPageSnapshot(snapshot: PageSnapshot): void {
    const previousTitle = this.browseStateTitle;
    const previousPage = this.browseStatePage;
    this.browseStateTitle = snapshot.title.trim() || this.browseStateTitle;
    this.browseStatePage = snapshot.page;
    if (this.browseStateTitle !== previousTitle || this.browseStatePage !== previousPage) {
      this.host.requestLayoutSave();
    }
  }

  private async restorePage(page: number): Promise<void> {
    const webview = this.webview;
    if (!webview || !this.loaded) return;
    const generation = this.navigationGeneration;
    try {
      if (!(await scrollToPage(webview, page))) return;
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      if (webview !== this.webview || generation !== this.navigationGeneration) return;
      const snapshot = await inspectNotabilityPage(webview);
      if (webview !== this.webview || generation !== this.navigationGeneration) return;
      this.showPageSnapshot(snapshot);
    } catch {
      // A restored page is a best-effort reading position; the note itself is
      // still usable when Notability has not rendered that page yet.
    }
  }

  private showLoadingPreview(region: NotabilityRegionV1, requestId: number): void {
    this.hideLoadingPreview();
    this.loadingPreviewRequestId = requestId;
    const generation = this.loadingPreviewGeneration;
    void this.host.preview(region).then((preview) => {
      if (
        !preview
        || generation !== this.loadingPreviewGeneration
        || !this.navigationRequests.isCurrent(requestId)
        || !this.stage
      ) return;
      const container = this.stage.createDiv({
        cls: "notability-live-region-loading-preview",
        attr: { "aria-label": "Saved Notability preview shown while the live note loads" }
      });
      container.createDiv({
        cls: "notability-live-region-loading-preview-heading",
        text: "Saved preview while the live note loads"
      });
      const body = container.createDiv({ cls: "notability-live-region-loading-preview-body" });
      renderPreview(body, preview, `${region.title}, page ${region.page}`);
      if (generation !== this.loadingPreviewGeneration) {
        container.remove();
        return;
      }
      this.loadingPreviewEl = container;
    }).catch(() => {
      // A missing or unreadable cache never blocks the live viewer.
    });
  }

  private hideLoadingPreview(): void {
    this.loadingPreviewGeneration += 1;
    this.loadingPreviewRequestId = null;
    this.loadingPreviewEl?.remove();
    this.loadingPreviewEl = null;
  }

  private runToolbarTask(label: string, task: () => Promise<void>): void {
    void task().catch((error) => {
      if (error instanceof CaptureCancelledError) {
        this.setStatus(label === "Selection"
          ? "Selection cancelled. Drag again to select a region."
          : "Capture cancelled. The Notability viewer was restored, and no new preview was committed.");
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.setStatus(`${label} failed: ${detail}`, error instanceof NotabilityTextSelectionError);
      new Notice(`Notability ${label.toLowerCase()} failed: ${detail}`);
    });
  }

  private beginCaptureCancellation(): number {
    if (this.activeCaptureCancellationTicket != null) {
      throw new Error("A cancellable Notability capture is already active.");
    }
    const gate = this.captureCancellation ??= new CaptureCancellationGate();
    const ticket = gate.snapshot();
    this.activeCaptureCancellationTicket = ticket;
    this.nextGuestCaptureEscapeGeneration();
    this.guestCaptureEscapeId = `capture:${newRegionId()}`;
    this.guestCaptureEscapeArmed = false;
    return ticket;
  }

  private nextGuestCaptureEscapeGeneration(): number {
    const current = Number.isSafeInteger(this.guestCaptureEscapeGeneration)
      ? this.guestCaptureEscapeGeneration
      : 0;
    this.guestCaptureEscapeGeneration = current + 1;
    return this.guestCaptureEscapeGeneration;
  }

  private finishCaptureCancellation(ticket: number, guestAlreadyDisarmed = false): void {
    if (this.activeCaptureCancellationTicket !== ticket) return;
    this.activeCaptureCancellationTicket = null;
    this.guestCaptureEscapeArmed = false;
    if (!guestAlreadyDisarmed) this.nextGuestCaptureEscapeGeneration();
    this.guestCaptureEscapeId = null;
    if (!guestAlreadyDisarmed) {
      void this.syncGuestCaptureEscape(null, this.guestCaptureEscapeGeneration).catch(() => undefined);
    }
  }

  /** End the Esc window immediately before the first non-abortable write. */
  private async sealCaptureCancellation(ticket: number): Promise<void> {
    this.captureCancellation.assertCurrent(ticket);
    if (this.guestCaptureEscapeArmed) {
      const webview = this.webview;
      const id = this.guestCaptureEscapeId;
      const armedGeneration = this.guestCaptureEscapeGeneration;
      if (!webview || !id || !this.attached) throw new CaptureCancelledError();
      const sealGeneration = this.nextGuestCaptureEscapeGeneration();
      const value = await webview.executeJavaScript<unknown>(
        buildGuestCaptureEscapeSealScript(id, armedGeneration, sealGeneration)
      );
      const result = value && typeof value === "object" ? value as Record<string, unknown> : null;
      const sealed = webview === this.webview
        && result?.available === true
        && result.generation === sealGeneration
        && result.id === null
        && result.matched === true;
      if (!sealed) {
        this.captureCancellation.assertCurrent(ticket);
        throw new Error("Text capture could not close its Escape cancellation window safely.");
      }
      if (result?.requested === true) this.captureCancellation.cancel();
      this.captureCancellation.assertCurrent(ticket);
      this.finishCaptureCancellation(ticket, true);
    } else {
      this.finishCaptureCancellation(ticket);
    }
    if (this.captureInteractionBlocker) {
      this.captureInteractionBlocker.setAttribute(
        "aria-label",
        "Saving the completed Notability preview; this final write cannot be cancelled"
      );
      this.captureInteractionBlocker.removeAttribute("aria-keyshortcuts");
    }
  }

  private requestCaptureCancellation(): boolean {
    if (this.cancelAreaSelectionDrag?.()) return true;
    const ticket = this.activeCaptureCancellationTicket;
    if (ticket == null) return false;
    // Continue consuming Escape while mandatory viewer restoration is still
    // settling so a repeated key press cannot cascade into unrelated Obsidian
    // navigation or close behavior.
    if (!this.captureCancellation.isCurrent(ticket)) return true;
    this.captureCancellation.cancel();
    this.setStatus("Cancelling capture... Restoring the Notability viewer.");
    return true;
  }

  private handleGuestConsoleMessage(event: Event): void {
    const message = (event as Event & { message?: unknown }).message;
    const id = this.guestCaptureEscapeId;
    if (!id || message !== `${GUEST_CAPTURE_ESCAPE_MESSAGE}${id}`) return;
    this.requestCaptureCancellation();
  }

  private async syncGuestCaptureEscape(id: string | null, generation: number): Promise<boolean> {
    const webview = this.webview;
    if (!webview || !this.attached) return false;
    const value = await webview.executeJavaScript<unknown>(buildGuestCaptureEscapeScript(id, generation));
    if (webview !== this.webview) return false;
    const result = value && typeof value === "object" ? value as Record<string, unknown> : null;
    return result?.available === true
      && result.generation === generation
      && result.id === id;
  }

  private async armGuestCaptureEscape(ticket: number): Promise<void> {
    const id = this.guestCaptureEscapeId;
    const generation = this.guestCaptureEscapeGeneration;
    if (!id || this.activeCaptureCancellationTicket !== ticket) throw new CaptureCancelledError();
    const armed = await this.syncGuestCaptureEscape(id, generation);
    this.captureCancellation.assertCurrent(ticket);
    if (!armed || id !== this.guestCaptureEscapeId || generation !== this.guestCaptureEscapeGeneration) {
      throw new Error("Text capture could not arm Escape cancellation in the Notability viewer.");
    }
    this.guestCaptureEscapeArmed = true;
  }

  private async loadInputUrl(): Promise<void> {
    if (!this.urlInput) return;
    await this.loadUrl(this.urlInput.value);
  }

  async loadUrl(
    value: string,
    target?: NotabilityRegionV1,
    targetMode: InteractionMode = "area"
  ): Promise<void> {
    const requestId = this.navigationRequests.begin();
    if (target) this.regionAlignment.arm(target.id);
    else this.regionAlignment.cancel();
    await this.loadUrlForRequest(value, target, requestId, targetMode);
  }

  private async loadUrlForRequest(
    value: string,
    target: NotabilityRegionV1 | undefined,
    requestId: number,
    targetMode: InteractionMode = "area"
  ): Promise<void> {
    if (this.captureInProgress) throw new Error("Wait for the current capture to finish before loading another note.");
    if (!this.webview || !this.webviewHandle || !this.attached) throw new Error("The Notability viewer is not ready.");
    const webview = this.webview;
    const url = sanitizeNotabilityNoteUrl(value);
    const isCurrentRequest = () => this.navigationRequests.isCurrent(requestId) && webview === this.webview;
    let actualWebviewMatches = false;
    try {
      actualWebviewMatches = sameNotabilityNote(webview.getURL(), url);
    } catch {
      actualWebviewMatches = false;
    }
    if (
      !target
      && canReuseLoadedNote(
        this.loaded,
        sameNotabilityNote(this.targetNoteUrl, url),
        actualWebviewMatches,
        this.physicalLoad !== null || this.pendingNavigation !== null
      )
    ) {
      this.hideLoadingPreview();
      this.browseStateUrl = url;
      if (this.urlInput) this.urlInput.value = url;
      await this.host.rememberUrl(url);
      if (!isCurrentRequest()) return;
      this.host.requestLayoutSave();
      this.setStatus("This Notability note is already displayed; no reload was needed.");
      await this.afterPageLoad();
      return;
    }
    const pendingNavigation: PendingNavigation = {
      requestId,
      url,
      targetRegion: target ?? null,
      targetMode
    };
    this.pendingNavigation = pendingNavigation;
    if (target) this.showLoadingPreview(target, requestId);
    else this.hideLoadingPreview();
    this.browseStateUrl = url;
    if (this.urlInput) this.urlInput.value = url;
    this.captureState.clear();
    if (!target) this.openedRegionMode.clear();
    this.clearSelectionGeometry();
    let physicalLoad: { requestId: number; url: string } | null = null;
    try {
      await this.host.rememberUrl(url);
      if (!isCurrentRequest()) return;
      if (!this.attached) throw new Error("The Notability viewer closed before loading began.");
      this.setStatus("Loading Notability note...");
      this.host.requestLayoutSave();
      this.latency.reset();
      this.latency.navigationStarted();
      physicalLoad = { requestId, url };
      this.physicalLoad = physicalLoad;
      await webview.loadURL(url);
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (this.pendingNavigation === pendingNavigation) this.pendingNavigation = null;
      this.hideLoadingPreview();
      if (this.targetNoteUrl) {
        this.browseStateUrl = this.targetNoteUrl;
        if (this.urlInput) this.urlInput.value = this.targetNoteUrl;
      } else {
        this.browseStateUrl = null;
        if (this.urlInput) this.urlInput.value = "";
      }
      this.host.requestLayoutSave();
      throw error;
    } finally {
      if (physicalLoad && this.physicalLoad === physicalLoad) this.physicalLoad = null;
    }
  }

  async openRegion(region: NotabilityRegionV1, options: { restoredMode?: InteractionMode } = {}): Promise<void> {
    const targetMode = options.restoredMode ?? "area";
    const requestId = this.navigationRequests.begin();
    this.regionAlignment.arm(region.id);
    const isCurrentRequest = () => this.navigationRequests.isCurrent(requestId);
    const url = sanitizeNotabilityNoteUrl(region.url);
    this.browseStateUrl = url;
    if (this.urlInput) this.urlInput.value = url;
    if (!this.webview || !this.webviewHandle || !this.attached) {
      if (isCurrentRequest()) {
        this.captureState.open(region);
        this.openedRegionMode.open(targetMode);
      }
      return;
    }
    const webview = this.webview;
    let actualWebviewMatches = false;
    try {
      actualWebviewMatches = sameNotabilityNote(webview.getURL(), url);
    } catch {
      actualWebviewMatches = false;
    }
    if (canReuseLoadedNote(
      this.loaded,
      sameNotabilityNote(this.targetNoteUrl, url),
      actualWebviewMatches,
      this.physicalLoad !== null || this.pendingNavigation !== null
    )) {
      this.pendingNavigation = null;
      this.captureState.open(region);
      this.openedRegionMode.open(targetMode);
      this.clearSelectionGeometry();
      this.showLoadingPreview(region, requestId);
      await this.host.rememberUrl(url);
      if (!isCurrentRequest()) return;
      this.host.requestLayoutSave();
      await this.afterPageLoad();
      return;
    }
    await this.loadUrlForRequest(url, region, requestId, targetMode);
  }

  /** Open an existing region, wait for exact alignment, then recapture its cache entry. */
  async refreshRegion(region: NotabilityRegionV1, options: { silent?: boolean } = {}): Promise<void> {
    await this.openRegion(region);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const opened = this.captureState.openedRegion();
      const selection = this.selection;
      if (
        opened?.id === region.id
        && selection
        && selection.page === region.page
        && sameNormalizedRect(selection.rect, region.rect)
        && this.interactionMode === "area"
      ) {
        await this.refreshExistingPreview(options.silent === true);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    const webview = this.webview;
    if (!webview || !this.loaded) {
      throw new NotabilityViewerUnavailableError("The live Notability page is unavailable. Complete login in Browse mode, then resume.");
    }
    try {
      const currentUrl = sanitizeNotabilityNoteUrl(webview.getURL());
      if (!sameNotabilityNote(currentUrl, region.url)) {
        throw new Error("A different page is displayed.");
      }
      await inspectNotabilityPage(webview);
    } catch {
      throw new NotabilityViewerUnavailableError("The live Notability page is unavailable. Complete login in Browse mode, then resume.");
    }
    throw new Error("The saved Notability rectangle could not be aligned for refresh.");
  }

  private async afterPageLoad(): Promise<void> {
    const webview = this.webview;
    if (!webview) return;
    let currentNoteUrl: string | null = null;
    try {
      currentNoteUrl = sanitizeNotabilityNoteUrl(webview.getURL());
    } catch {
      // Login and auxiliary Notability pages intentionally have no note identity.
    }
    const openedState = this.captureState.openedRegion();
    const targetRegion = currentNoteUrl
      && sameNotabilityNote(this.targetNoteUrl, currentNoteUrl)
      && openedState
      && sameNotabilityNote(openedState.url, currentNoteUrl)
      ? openedState
      : null;
    const alignmentGeneration = targetRegion ? this.regionAlignment.claim(targetRegion.id) : null;
    if (openedState && (!targetRegion || alignmentGeneration === null)) return;
    const generation = targetRegion ? ++this.navigationGeneration : this.navigationGeneration;
    const isCurrent = () => generation === this.navigationGeneration
      && webview === this.webview
      && openedState === this.captureState.openedRegion()
      && (alignmentGeneration === null || this.regionAlignment.isCurrent(alignmentGeneration));

    if (!targetRegion) {
      try {
        const snapshot = await this.waitForPageSnapshot(webview);
        if (!isCurrent()) return;
        this.latency.firstPage();
        this.showPageSnapshot(snapshot);
        if (!this.pendingNavigation?.targetRegion) this.hideLoadingPreview();
        this.setStatus("Note pages are ready. Choose Area or Text.");
      } catch {
        if (!isCurrent()) return;
        if (!this.pendingNavigation?.targetRegion) this.hideLoadingPreview();
        this.setStatus("Pages are not rendered yet. If Notability shows Log in, complete it in Browse mode.");
      }
      return;
    }

    this.latency.regionAlignmentStarted();
    try {
      await this.waitForPageSnapshot(webview);
      if (!isCurrent()) return;
      this.latency.firstPage();
      if (!(await scrollToPage(webview, targetRegion.page))) {
        throw new Error(`Page ${targetRegion.page} is not currently rendered.`);
      }
      if (!isCurrent()) return;
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      if (!isCurrent()) return;
      if (!(await scrollRegionIntoView(webview, targetRegion.page, targetRegion.rect))) {
        throw new Error("The saved rectangle could not be centered.");
      }
      if (!isCurrent()) return;
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      if (!isCurrent()) return;
      const snapshot = await inspectNotabilityPage(webview);
      if (!isCurrent()) return;
      if (snapshot.page !== targetRegion.page) {
        throw new Error(`Expected page ${targetRegion.page}, but Notability rendered page ${snapshot.page}.`);
      }
      const overlayRect = denormalizeRect(targetRegion.rect, snapshot.pageRect);
      const mode = this.openedRegionMode.current();
      this.setInteractionMode("area", mode === "area");
      this.selectionRequestGeneration += 1;
      this.selection = {
        kind: "area",
        pageRect: snapshot.pageRect,
        rect: targetRegion.rect,
        overlayRect,
        page: targetRegion.page,
        fingerprint: targetRegion.fingerprint,
        fallbackLabel: null
      };
      this.paintSelection(overlayRect);
      this.showPageSnapshot(snapshot);
      this.updateControls();
      this.latency.regionAligned();
      this.hideLoadingPreview();
      const changed = snapshot.pageCount !== targetRegion.expectedPageCount
        || aspectDrift(targetRegion.pageAspect, snapshot.pageAspect) > 0.02;
      this.setStatus(changed
        ? `Opened page ${targetRegion.page}. The note layout changed; refresh still uses the exact saved rectangle.`
        : `Opened the saved region on page ${targetRegion.page}.`);
      if (mode !== "area") this.setInteractionMode(mode);
    } catch (error) {
      if (!isCurrent()) return;
      this.hideLoadingPreview();
      this.setStatus(`Opened the note, but exact region alignment failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (alignmentGeneration !== null) this.regionAlignment.complete(alignmentGeneration);
    }
  }

  private async waitForPageSnapshot(webview: ElectronWebviewElement, timeoutMs = 8000): Promise<PageSnapshot> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = new Error("Notability page DOM is unavailable.");
    while (Date.now() < deadline) {
      try {
        return await inspectNotabilityPage(webview);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    }
    throw lastError;
  }

  private assertCaptureOperationCurrent(
    generation: number,
    webview: ElectronWebviewElement,
    selection: SelectionState,
    openedRegion: NotabilityRegionV1 | null,
    noteUrl: string
  ): void {
    const cancellationTicket = this.activeCaptureCancellationTicket;
    if (cancellationTicket != null && !this.captureCancellationChecksSuspended) {
      this.captureCancellation.assertCurrent(cancellationTicket);
    }
    const changed: string[] = [];
    if (generation !== this.navigationGeneration) changed.push("viewer generation");
    if (webview !== this.webview) changed.push("viewer instance");
    if (selection !== this.selection) changed.push("selection");
    if (openedRegion !== this.captureState.openedRegion()) changed.push("opened region");
    if (noteUrl !== this.targetNoteUrl) changed.push("note target");
    if (changed.length) {
      throw new Error(`The Notability page or selection changed during capture (${changed.join(", ")}). Select the region again.`);
    }
  }

  private captureRectForSnapshot(
    snapshot: PageSnapshot,
    webview: ElectronWebviewElement,
    selection: SelectionState,
    regionRect: NormalizedRect,
    expectedPage: number
  ): CssRect {
    if (snapshot.page !== expectedPage) {
      throw new Error(`The page changed from ${expectedPage} to ${snapshot.page} after selection. Select the area again.`);
    }
    if (!sameCssRect(snapshot.pageRect, selection.pageRect)) {
      throw new Error("The Notability page moved after selection. Select the region again before capturing.");
    }
    return capturePixelRect(regionRect, snapshot.pageRect, {
      width: webview.clientWidth,
      height: webview.clientHeight
    });
  }

  private setCaptureInteractionBlocked(blocked: boolean): void {
    if (!this.stage) return;
    if (!blocked) {
      this.captureInteractionBlocker?.remove();
      this.captureInteractionBlocker = null;
      return;
    }
    if (this.captureInteractionBlocker) return;
    const blocker = this.stage.ownerDocument.win.createDiv();
    blocker.className = "notability-live-region-capture-blocker";
    blocker.setAttribute("aria-label", "Capturing Notability preview; press escape to cancel");
    blocker.setAttribute("aria-keyshortcuts", "Escape");
    blocker.tabIndex = -1;
    blocker.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });
    this.stage.append(blocker);
    this.captureInteractionBlocker = blocker;
    blocker.focus({ preventScroll: true });
  }

  private async guestCaptureMetrics(webview: ElectronWebviewElement) {
    return validateGuestCaptureMetrics(await webview.executeJavaScript(`(() => ({
      devicePixelRatio: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    }))()`));
  }

  private async waitForBoundedGuestPaint(webview: ElectronWebviewElement, timeoutMs = 250): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) {
      throw new Error("The whole-page paint timeout is invalid.");
    }
    const ownerWindow = webview.ownerDocument?.defaultView ?? window;
    let timer: number | null = null;
    try {
      await Promise.race([
        webview.executeJavaScript(
          `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
        ),
        new Promise<void>((_, reject) => {
          timer = ownerWindow.setTimeout(
            () => reject(new Error("Notability did not present a painted whole-page tile in time.")),
            timeoutMs
          );
        })
      ]);
    } finally {
      if (timer !== null) ownerWindow.clearTimeout(timer);
    }
  }

  private wholePageTargetDensity(snapshot: PageSnapshot, sourceDensity: number): number {
    const width = snapshot.pageRect.width;
    const height = snapshot.pageRect.height;
    const limits = DEFAULT_WHOLE_PAGE_CAPTURE_LIMITS;
    const density = Math.min(
      sourceDensity,
      TARGET_PAGE_RASTER_WIDTH / width,
      limits.maxRasterDimension / width,
      limits.maxRasterDimension / height,
      Math.sqrt(limits.maxRasterArea / (width * height))
    );
    if (!Number.isFinite(density) || density <= 0) {
      throw new Error("The complete Notability page is too large to capture safely.");
    }
    return density;
  }

  private async stitchWholePage(
    plan: WholePageCapturePlan,
    chunks: readonly WholePageEncodedTile<Uint8Array>[]
  ): Promise<Uint8Array> {
    const document = this.contentEl.ownerDocument;
    const bitmapFactory = document.defaultView?.createImageBitmap?.bind(document.defaultView);
    if (!bitmapFactory) throw new Error("This Obsidian window cannot decode whole-page capture tiles.");

    return stitchWholePageCapture<Uint8Array, ImageBitmap, WholePageCanvasSurface, Uint8Array>(plan, chunks, {
      createSurface: ({ width, height }) => {
        const canvas = document.win.createEl("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("This Obsidian window cannot compose a whole-page preview.");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        return { canvas, context };
      },
      decode: async (bytes) => {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return bitmapFactory(new Blob([buffer], { type: "image/png" }));
      },
      imageSize: (image) => ({ width: image.width, height: image.height }),
      draw: (surface, image, source, destination) => {
        surface.context.drawImage(
          image,
          source.x,
          source.y,
          source.width,
          source.height,
          destination.x,
          destination.y,
          destination.width,
          destination.height
        );
      },
      encode: (surface) => new Promise<Uint8Array>((resolve, reject) => {
        surface.canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("The whole-page preview could not be encoded."));
            return;
          }
          void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
        }, "image/png");
      }),
      releaseImage: (image) => image.close(),
      releaseSurface: (surface) => {
        surface.canvas.width = 1;
        surface.canvas.height = 1;
      }
    });
  }

  private async captureWholePageAtZoom(
    webview: ElectronWebviewElement,
    expectedPage: number,
    snapshot: PageSnapshot,
    zoomedMetrics: ReturnType<typeof validateGuestCaptureMetrics>,
    actualCaptureZoom: number,
    generation: number,
    selection: SelectionState,
    openedRegion: NotabilityRegionV1 | null,
    noteUrl: string,
    phaseBaseline: PageSnapshot,
    pageCaptureToken: string,
    captureChromeToken: string
  ): Promise<{ bytes: Uint8Array; pixelWidth: number; pixelHeight: number }> {
    const hostViewport = { width: webview.clientWidth, height: webview.clientHeight };
    const edgeGuard = 4;
    if (hostViewport.width <= edgeGuard * 2 + 1 || hostViewport.height <= edgeGuard * 2 + 1) {
      throw new Error("The Notability viewer pane is too small for whole-page capture.");
    }
    const noteViewport = await inspectNotabilityViewport(webview);
    await assertNotabilityCaptureChromeHidden(webview, captureChromeToken);
    this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
    const captureLeft = Math.max(edgeGuard, noteViewport.x * actualCaptureZoom + edgeGuard);
    const captureTop = Math.max(edgeGuard, noteViewport.y * actualCaptureZoom + edgeGuard);
    const captureRight = Math.min(
      hostViewport.width - edgeGuard,
      (noteViewport.x + noteViewport.width) * actualCaptureZoom - edgeGuard
    );
    const captureBottom = Math.min(
      hostViewport.height - edgeGuard,
      (noteViewport.y + noteViewport.height) * actualCaptureZoom - edgeGuard
    );
    if (captureRight - captureLeft < 1 || captureBottom - captureTop < 1) {
      throw new Error("The rendered Notability note viewport is too small for whole-page capture.");
    }
    assertWholePageCapturePhaseLayout(phaseBaseline, snapshot);
    const targetDensity = this.wholePageTargetDensity(snapshot, zoomedMetrics.devicePixelRatio);
    const plan = planWholePageCapture({
      page: { width: snapshot.pageRect.width, height: snapshot.pageRect.height },
      captureViewport: {
        x: captureLeft,
        y: captureTop,
        width: captureRight - captureLeft,
        height: captureBottom - captureTop
      },
      captureScale: actualCaptureZoom,
      targetDensity
    });
    const chunks: WholePageEncodedTile<Uint8Array>[] = [];

    for (const tile of plan.tiles) {
      this.setStatus(`Capturing the entire page (${tile.index + 1} of ${plan.tiles.length})... Press Esc to cancel.`);
      const current = await this.settleSharpCapture(
        webview,
        expectedPage,
        tile.normalized,
        generation,
        selection,
        openedRegion,
        noteUrl,
        pageCaptureToken
      );
      assertWholePageCapturePhaseLayout(phaseBaseline, current);
      const currentMetrics = await this.guestCaptureMetrics(webview);
      const currentViewport = await inspectNotabilityViewport(webview);
      this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
      if (
        Math.abs(currentMetrics.viewport.width - zoomedMetrics.viewport.width) > 0.75
        || Math.abs(currentMetrics.viewport.height - zoomedMetrics.viewport.height) > 0.75
        || Math.abs(currentMetrics.devicePixelRatio - zoomedMetrics.devicePixelRatio) > 0.01
        || !sameCssRect(noteViewport, currentViewport, 0.75)
      ) {
        throw new Error("The Notability viewer scale changed during whole-page capture.");
      }
      const crop = captureRectAtZoom(
        tile.normalized,
        current.pageRect,
        currentMetrics.viewport,
        hostViewport,
        actualCaptureZoom
      );
      // Notability virtualizes page canvases after scrolling. Give its guest
      // renderer two animation frames plus a bounded paint dwell before the
      // first sample, then require three identical compositor frames below.
      // This avoids accepting two copies of the previous tile during a late
      // PDF/ink repaint while keeping the wait finite and cancellable by the
      // surrounding capture-operation guards.
      await this.waitForBoundedGuestPaint(webview);
      await new Promise((resolve) => window.setTimeout(resolve, 220));
      this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
      const encoded = await captureStableWholePageTile(
        async () => {
          // A viewer leaf can become backgrounded at any point in the bounded
          // stability window. Prove that the guest compositor is still
          // presenting frames for every sample, on both sides of capturePage,
          // so identical frozen pixels can never qualify as stable output.
          await this.waitForBoundedGuestPaint(webview);
          this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
          await assertNotabilityCaptureChromeHidden(webview, captureChromeToken);
          const image = await webview.capturePage(crop);
          await assertNotabilityCaptureChromeHidden(webview, captureChromeToken);
          await this.waitForBoundedGuestPaint(webview);
          this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
          const postCapture = await inspectNotabilityPageAt(webview, expectedPage, pageCaptureToken);
          const postMetrics = await this.guestCaptureMetrics(webview);
          this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
          if (
            !sameCssRect(current.pageRect, postCapture.pageRect, 0.75)
            || Math.abs(postMetrics.viewport.width - currentMetrics.viewport.width) > 0.75
            || Math.abs(postMetrics.viewport.height - currentMetrics.viewport.height) > 0.75
            || Math.abs(postMetrics.devicePixelRatio - currentMetrics.devicePixelRatio) > 0.01
          ) {
            throw new Error("The Notability page moved while capturing a whole-page tile.");
          }
          assertWholePageCapturePhaseLayout(phaseBaseline, postCapture);
          return encodeBestPreviewImage(image);
        },
        (value) => value.bytes,
        () => new Promise((resolve) => window.setTimeout(resolve, 160)),
        8,
        3
      );
      const logical = denormalizeRect(tile.normalized, current.pageRect);
      const contentInHost: WholePageRect = {
        x: logical.x * actualCaptureZoom,
        y: logical.y * actualCaptureZoom,
        width: logical.width * actualCaptureZoom,
        height: logical.height * actualCaptureZoom
      };
      const source = capturedTileSourceRect(contentInHost, crop, {
        width: encoded.pixelWidth,
        height: encoded.pixelHeight
      });
      if (
        source.width + 1.01 < tile.destination.width
        || source.height + 1.01 < tile.destination.height
      ) {
        throw new Error("A whole-page tile did not contain enough real pixels for the requested preview density.");
      }
      chunks.push({ tileIndex: tile.index, encoded: encoded.bytes, source });
    }

    const bytes = await this.stitchWholePage(plan, chunks);
    return { bytes, pixelWidth: plan.raster.width, pixelHeight: plan.raster.height };
  }

  private async settleSharpCapture(
    webview: ElectronWebviewElement,
    expectedPage: number,
    regionRect: NormalizedRect,
    generation: number,
    selection: SelectionState,
    openedRegion: NotabilityRegionV1 | null,
    noteUrl: string,
    pageCaptureToken: string | null = null
  ): Promise<PageSnapshot> {
    let previous: PageSnapshot | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
      if (!(await scrollRegionIntoView(webview, expectedPage, regionRect))) {
        throw new Error("The selected region could not be centered for sharp capture.");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
      const current = await inspectNotabilityPageAt(webview, expectedPage, pageCaptureToken);
      if (previous && sameCssRect(previous.pageRect, current.pageRect, 0.75)) return current;
      previous = current;
    }
    throw new Error("The Notability page did not settle for sharp capture.");
  }

  /** Capture one complete logical page without requiring an Area or Text selection. */
  private async copyCurrentPageEmbed(): Promise<void> {
    if (this.captureInProgress || this.clipboardOperationInProgress || this.pageEmbedPreparing) {
      throw new Error("A Notability preview capture is already in progress.");
    }
    const delivery = this.prepareEmbedDelivery("embed");
    const webview = this.webview;
    const noteUrl = this.targetNoteUrl;
    if (!webview || !this.loaded || !noteUrl || !sameNotabilityNote(noteUrl, webview.getURL())) {
      throw new Error("Wait for a rendered Notability page before embedding the entire page.");
    }

    const cancellationTicket = this.beginCaptureCancellation();
    const previousCaptureState = this.captureState.snapshot();
    const previousOpenedMode = this.openedRegionMode.current();
    const previousSelection = this.selection
      ? {
          ...this.selection,
          pageRect: { ...this.selection.pageRect },
          rect: { ...this.selection.rect },
          overlayRect: { ...this.selection.overlayRect },
          fingerprint: { ...this.selection.fingerprint }
        }
      : null;
    this.pageEmbedPreparing = true;
    this.setCaptureInteractionBlocked(true);
    this.updateControls();
    this.setStatus("Preparing the entire current Notability page... Press Esc to cancel.");
    const generation = this.navigationGeneration;
    try {
      const snapshot = await inspectNotabilityPage(webview);
      this.captureCancellation.assertCurrent(cancellationTicket);
      if (
        webview !== this.webview
        || generation !== this.navigationGeneration
        || noteUrl !== this.targetNoteUrl
        || !sameNotabilityNote(noteUrl, webview.getURL())
      ) {
        throw new Error("The Notability note changed while preparing the page embed.");
      }

      const reusable = this.captureState.reusableRegion();
      const reusablePage = Boolean(
        reusable
        && sameNotabilityNote(reusable.url, noteUrl)
        && reusable.page === snapshot.page
        && reusable.expectedPageCount === snapshot.pageCount
        && isFullPageRect(reusable.rect)
        && reusable.fingerprint.kind === "none"
        && aspectDrift(reusable.pageAspect, snapshot.pageAspect) <= 0.02
      );
      if (!reusablePage) {
        this.captureState.startManualSelection();
        this.openedRegionMode.clear();
      }

      this.selectionRequestGeneration += 1;
      this.selection = {
        kind: "page",
        pageRect: snapshot.pageRect,
        rect: { ...FULL_PAGE_RECT },
        overlayRect: { ...snapshot.pageRect },
        page: snapshot.page,
        fingerprint: { kind: "none" },
        fallbackLabel: null
      };
      this.paintSelection(snapshot.pageRect);
      this.showPageSnapshot(snapshot);
      this.updateControls();
      this.captureCancellation.assertCurrent(cancellationTicket);
      await this.copySelection("embed", delivery, cancellationTicket);
    } catch (error) {
      if (error instanceof CaptureCancelledError) {
        const restoredPageRect = previousSelection && this.selection?.page === previousSelection.page
          ? this.selection.pageRect
          : previousSelection?.pageRect;
        this.captureState.restore(previousCaptureState);
        if (previousCaptureState.opened) this.openedRegionMode.open(previousOpenedMode);
        else this.openedRegionMode.clear();
        this.selection = previousSelection && restoredPageRect
          ? {
              ...previousSelection,
              pageRect: { ...restoredPageRect },
              overlayRect: denormalizeRect(previousSelection.rect, restoredPageRect)
            }
          : null;
        if (this.selection) this.paintSelection(this.selection.overlayRect);
        else this.selectionEl?.hide();
        this.updateControls();
        this.host.requestLayoutSave();
        throw error;
      }
      throw error;
    } finally {
      this.finishCaptureCancellation(cancellationTicket);
      this.setCaptureInteractionBlocked(false);
      this.pageEmbedPreparing = false;
      this.updateControls();
    }
  }

  /** Capture the current rectangle and place an internal plugin reference on the clipboard. */
  async copySelection(
    mode: CaptureMode,
    preparedDelivery?: EmbedDeliveryIntent,
    preparedCancellationTicket?: number
  ): Promise<void> {
    if (this.clipboardOperationInProgress) {
      throw new Error("A Notability copy operation is already in progress.");
    }
    const ownsCancellation = preparedCancellationTicket === undefined;
    const cancellationTicket = preparedCancellationTicket ?? this.beginCaptureCancellation();
    this.captureCancellation.assertCurrent(cancellationTicket);
    this.clipboardOperationInProgress = true;
    this.updateControls();
    // Preserve a live guest PDF text selection until finalizeTextSelection has
    // inspected it. Moving focus to the host blocker first can collapse it.
    if (this.interactionMode !== "text" || this.selection?.kind === "page") {
      this.setCaptureInteractionBlocked(true);
      this.setStatus("Preparing the selected region... Press Esc to cancel.");
    }
    try {
      if (this.interactionMode === "text" && this.selection?.kind !== "page") {
        await this.armGuestCaptureEscape(cancellationTicket);
      }
      const delivery = preparedDelivery ?? this.prepareEmbedDelivery(mode);
      const region = await this.captureSelectionPreview(false, cancellationTicket);
      // Clipboard writes cannot be aborted or rolled back. The cancellable
      // phase is sealed by captureSelectionPreview immediately before cache
      // persistence, so Escape is deliberately ignored beyond this point.
      const fallbackLabel = this.selection?.fallbackLabel || defaultRegionLabel(region);
      const markdown = mode === "link"
        ? markdownRegionLink(fallbackLabel, region)
        : regionFence(region);
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard access is unavailable in this Obsidian window.");
      }
      await navigator.clipboard.writeText(markdown);
      let inserted = false;
      if (delivery.requested && delivery.insertion) {
        try {
          inserted = delivery.insertion.commit(markdown);
        } catch {
          inserted = false;
        }
      }
      // A successful copy completes the capture gesture. Return control to the
      // live Notability page before focusing Markdown so the user cannot
      // accidentally remain in a locked selection mode. Failed captures or
      // clipboard writes deliberately keep the current mode for retrying.
      // Whole-page capture can start and finish in Browse, so a mode change is
      // not guaranteed to clear its synthetic full-page outline. Clear that
      // completed selection explicitly before applying the Browse transition.
      if (this.interactionMode === "browse") this.clearSelectionGeometry();
      this.setInteractionMode("browse");
      if (inserted) {
        this.setStatus(`Inserted the embed for ${defaultRegionLabel(region)} into ${delivery.targetLabel ?? "its Markdown target"}. The viewer returned to Browse, and the same embed remains on the clipboard.`);
        new Notice("Notability embed inserted.");
      } else if (delivery.requested) {
        this.setStatus(`Copied the embed for ${defaultRegionLabel(region)}, but insertion${delivery.targetLabel ? ` into ${delivery.targetLabel}` : ""} was skipped because the Markdown target changed or was unavailable. The viewer returned to Browse; paste manually.`);
        new Notice("Notability embed copied; automatic insertion was skipped.");
      } else {
        this.setStatus(`Copied ${mode === "link" ? "link" : "embed"} for ${defaultRegionLabel(region)}. The viewer returned to Browse; paste it into a Markdown note.`);
        new Notice(`Notability ${mode} copied.`);
      }
      await this.focusMarkdownAfterCopy(delivery.targetLeaf);
    } finally {
      if (ownsCancellation) this.finishCaptureCancellation(cancellationTicket);
      this.setCaptureInteractionBlocked(false);
      this.clipboardOperationInProgress = false;
      this.updateControls();
    }
  }

  private prepareEmbedDelivery(mode: CaptureMode): EmbedDeliveryIntent {
    const requested = mode === "embed" && this.autoInsertEmbeds;
    const focusTarget = this.host.resolveEmbedInsertionTarget(this.returnMarkdownLeaf);
    if (!requested) {
      return {
        requested: false,
        insertion: null,
        targetLeaf: focusTarget?.leaf ?? null,
        targetLabel: focusTarget?.label ?? null
      };
    }
    try {
      const target = focusTarget;
      if (!target) return { requested: true, insertion: null, targetLeaf: null, targetLabel: null };
      if (this.returnMarkdownTargetIdentity && target.identity !== this.returnMarkdownTargetIdentity) {
        this.autoInsertEmbeds = false;
        this.returnMarkdownTargetIdentity = target.identity;
        this.updateControls();
        return {
          requested: true,
          insertion: null,
          targetLeaf: target.leaf,
          targetLabel: target.label
        };
      }
      this.returnMarkdownLeaf = target.leaf;
      this.returnMarkdownTargetIdentity = target.identity;
      return {
        requested: true,
        insertion: this.host.prepareEmbedInsertion(target.leaf),
        targetLeaf: target.leaf,
        targetLabel: target.label
      };
    } catch {
      // The originating editor may disappear while a capture is starting.
      // Clipboard delivery remains the recovery path and must still succeed.
      return { requested: true, insertion: null, targetLeaf: focusTarget?.leaf ?? null, targetLabel: focusTarget?.label ?? null };
    }
  }

  private async focusMarkdownAfterCopy(preferredLeaf: WorkspaceLeaf | null): Promise<void> {
    const target = this.host.resolveEmbedInsertionTarget(preferredLeaf);
    if (target) {
      this.returnMarkdownLeaf = target.leaf;
      try {
        await this.app.workspace.revealLeaf(target.leaf);
        this.app.workspace.setActiveLeaf(target.leaf, { focus: true });
        return;
      } catch {
        this.returnMarkdownLeaf = null;
        this.returnMarkdownTargetIdentity = null;
      }
    }
    if (preferredLeaf) return;
    try {
      await this.host.focusMarkdownAfterCopy();
    } catch {
      // Clipboard delivery and a completed editor transaction must not be
      // reported as failed merely because the destination tab could not focus.
    }
  }

  private async refreshExistingPreview(silent = false): Promise<void> {
    const cancellationTicket = this.beginCaptureCancellation();
    this.setCaptureInteractionBlocked(true);
    try {
      const region = await this.captureSelectionPreview(true, cancellationTicket);
      if (!silent) {
        this.setStatus(`Refreshed the preview for ${defaultRegionLabel(region)} from its exact saved rectangle.`);
        new Notice("Notability preview refreshed.");
      }
    } finally {
      this.finishCaptureCancellation(cancellationTicket);
      this.setCaptureInteractionBlocked(false);
    }
  }

  private async captureSelectionPreview(
    requireOpenedRegion: boolean,
    cancellationTicket: number
  ): Promise<NotabilityRegionV1> {
    this.captureCancellation.assertCurrent(cancellationTicket);
    if (this.captureInProgress) throw new Error("A region capture is already in progress.");
    if (!requireOpenedRegion && this.interactionMode === "text" && this.selection?.kind !== "page") {
      try {
        await this.finalizeTextSelection();
      } catch (error) {
        if (!this.captureCancellation.isCurrent(cancellationTicket)) throw new CaptureCancelledError();
        throw error;
      }
      this.captureCancellation.assertCurrent(cancellationTicket);
    }
    const webview = this.webview;
    const selection = this.selection;
    const noteUrl = this.targetNoteUrl;
    const openedRegion = this.captureState.openedRegion();
    if (!webview || !selection) throw new Error("Select a rendered Notability region first.");
    if (this.interactionMode === "browse" && selection.kind !== "page") {
      throw new Error("Choose Area or Text before capturing.");
    }
    if (!noteUrl || !sameNotabilityNote(noteUrl, webview.getURL())) {
      throw new Error("Wait for the requested Notability note to finish loading before capturing.");
    }
    if (requireOpenedRegion && !openedRegion) {
      throw new Error("Refresh preview is available after opening an existing saved region.");
    }
    if (openedRegion) {
      if (!sameNotabilityNote(openedRegion.url, noteUrl)) {
        throw new Error("The saved region belongs to a different Notability note.");
      }
      if (selection.page !== openedRegion.page || !sameNormalizedRect(selection.rect, openedRegion.rect)) {
        throw new Error("Refresh uses the exact saved page and rectangle. Reopen the saved region first.");
      }
    }

    const generation = this.navigationGeneration;
    const originalZoom = webview.getZoomFactor();
    this.captureInProgress = true;
    this.setCaptureInteractionBlocked(true);
    this.updateControls();
    this.setStatus(requireOpenedRegion
      ? "Refreshing the saved preview... Press Esc to cancel."
      : "Capturing the selected region... Press Esc to cancel.");
    let captureError: unknown = null;
    let restorationError: unknown = null;
    let pageCaptureToken: string | null = null;
    let pageCapturePage: number | null = null;
    let wholePageIdentityBaseline: PageSnapshot | null = null;
    let wholePagePhaseBaseline: PageSnapshot | null = null;
    let captureChromeToken: string | null = null;
    let pendingSave: {
      region: NotabilityRegionV1;
      bytes: Uint8Array;
      capture: Omit<PreviewCaptureInput, "captureVersion">;
    } | null = null;
    try {
      if (!Number.isFinite(originalZoom) || Math.abs(originalZoom - 1) > 0.001) {
        throw new Error("Sharp capture requires the normal Notability viewer zoom.");
      }
      this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
      const expectedPage = openedRegion?.page ?? selection.page;
      const regionRect = openedRegion?.rect ?? selection.rect;
      const wholePage = isFullPageRect(regionRect);
      let snapshot: PageSnapshot;
      if (wholePage) {
        pageCaptureToken = `nlr-${newRegionId().slice(3)}`;
        pageCapturePage = expectedPage;
        snapshot = await claimNotabilityPageCapture(webview, expectedPage, pageCaptureToken);
        wholePageIdentityBaseline = snapshot;
        if (snapshot.page !== selection.page || !sameCssRect(snapshot.pageRect, selection.pageRect, 0.75)) {
          throw new Error("The current Notability page moved before whole-page capture began.");
        }
      } else {
        snapshot = await inspectNotabilityPage(webview);
      }
      this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
      if (!wholePage) this.captureRectForSnapshot(snapshot, webview, selection, regionRect, expectedPage);
      const baseMetrics = await this.guestCaptureMetrics(webview);
      this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
      const zoomPlan = wholePage
        ? planWholePageZoom(snapshot.pageRect, baseMetrics.devicePixelRatio)
        : planCaptureZoom(
          snapshot.pageRect,
          regionRect,
          { width: webview.clientWidth, height: webview.clientHeight },
          baseMetrics.devicePixelRatio
        );
      captureChromeToken = `nlr-ui-${newRegionId().slice(3)}`;
      await hideNotabilityCaptureChrome(webview, captureChromeToken);
      this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
      const region = this.captureState.materialize(() => ({
        v: 1,
        id: newRegionId(),
        url: noteUrl,
        title: snapshot.title,
        page: snapshot.page,
        expectedPageCount: Math.max(snapshot.pageCount, snapshot.page),
        rect: regionRect,
        pageAspect: snapshot.pageAspect,
        fingerprint: selection.fingerprint,
        adapter: "notability-web-v1",
        capturedAt: new Date().toISOString()
      }));
      webview.setZoomFactor(zoomPlan.zoomFactor);
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
      const actualCaptureZoom = webview.getZoomFactor();
      if (!Number.isFinite(actualCaptureZoom) || Math.abs(actualCaptureZoom - zoomPlan.zoomFactor) > 0.01) {
        throw new Error("The Notability viewer could not apply the sharp capture scale.");
      }
      snapshot = await this.settleSharpCapture(
        webview,
        expectedPage,
        regionRect,
        generation,
        selection,
        openedRegion,
        noteUrl,
        pageCaptureToken
      );
      if (wholePage && wholePageIdentityBaseline) {
        assertWholePageCaptureIdentity(wholePageIdentityBaseline, snapshot);
        wholePagePhaseBaseline = snapshot;
      }
      const zoomedMetrics = await this.guestCaptureMetrics(webview);
      this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
      const expectedDeviceScale = baseMetrics.devicePixelRatio * actualCaptureZoom / originalZoom;
      if (Math.abs(zoomedMetrics.devicePixelRatio - expectedDeviceScale) / expectedDeviceScale > 0.04) {
        throw new Error("The Notability viewer did not reach a stable sharp capture scale.");
      }
      let bytes: Uint8Array;
      let pixelWidth: number;
      let pixelHeight: number;
      let chosenScale: number;
      let availableScales: number[];
      if (wholePage) {
        const complete = await this.captureWholePageAtZoom(
          webview,
          expectedPage,
          snapshot,
          zoomedMetrics,
          actualCaptureZoom,
          generation,
          selection,
          openedRegion,
          noteUrl,
          wholePagePhaseBaseline!,
          pageCaptureToken!,
          captureChromeToken
        );
        bytes = complete.bytes;
        pixelWidth = complete.pixelWidth;
        pixelHeight = complete.pixelHeight;
        chosenScale = 1;
        availableScales = [1];
      } else {
        const crop = captureRectAtZoom(
          regionRect,
          snapshot.pageRect,
          zoomedMetrics.viewport,
          { width: webview.clientWidth, height: webview.clientHeight },
          actualCaptureZoom
        );
        await assertNotabilityCaptureChromeHidden(webview, captureChromeToken);
        const image = await webview.capturePage(crop);
        await assertNotabilityCaptureChromeHidden(webview, captureChromeToken);
        this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
        const postCaptureSnapshot = await inspectNotabilityPageAt(webview, expectedPage);
        this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
        if (!sameCssRect(snapshot.pageRect, postCaptureSnapshot.pageRect, 0.75)) {
          throw new Error("The Notability page moved during sharp capture.");
        }
        const postCaptureMetrics = await this.guestCaptureMetrics(webview);
        if (
          Math.abs(postCaptureMetrics.viewport.width - zoomedMetrics.viewport.width) > 0.75
          || Math.abs(postCaptureMetrics.viewport.height - zoomedMetrics.viewport.height) > 0.75
          || Math.abs(postCaptureMetrics.devicePixelRatio - zoomedMetrics.devicePixelRatio) > 0.01
        ) {
          throw new Error("The Notability viewer scale changed during sharp capture.");
        }
        captureRectAtZoom(
          regionRect,
          postCaptureSnapshot.pageRect,
          postCaptureMetrics.viewport,
          { width: webview.clientWidth, height: webview.clientHeight },
          actualCaptureZoom
        );
        const encoded = encodeBestPreviewImage(image);
        bytes = encoded.bytes;
        pixelWidth = encoded.pixelWidth;
        pixelHeight = encoded.pixelHeight;
        chosenScale = encoded.chosenScale;
        availableScales = encoded.availableScales;
      }
      const display = previewDisplaySize(regionRect, region.pageAspect, {
        width: pixelWidth,
        height: pixelHeight
      });
      pendingSave = { region, bytes, capture: {
        cssWidth: display.width,
        cssHeight: display.height,
        pixelWidth,
        pixelHeight,
        chosenScale,
        availableScales,
        capturedAt: new Date().toISOString()
      } };
    } catch (error) {
      captureError = this.captureCancellation.isCurrent(cancellationTicket)
        ? error
        : new CaptureCancelledError();
    } finally {
      this.captureCancellationChecksSuspended = true;
      try {
        if (webview !== this.webview) {
          restorationError = new Error("The Notability viewer closed during capture.");
        } else {
          try {
            webview.setZoomFactor(originalZoom);
            await new Promise((resolve) => window.setTimeout(resolve, 150));
            const restoredZoom = webview.getZoomFactor();
            if (!Number.isFinite(restoredZoom) || Math.abs(restoredZoom - originalZoom) > 0.01) {
              restorationError = new Error("The original viewer scale was not restored.");
            } else {
              this.assertCaptureOperationCurrent(generation, webview, selection, openedRegion, noteUrl);
              const restored = await this.settleSharpCapture(
                webview,
                openedRegion?.page ?? selection.page,
                openedRegion?.rect ?? selection.rect,
                generation,
                selection,
                openedRegion,
                noteUrl,
                pageCaptureToken
              );
              if (wholePageIdentityBaseline) assertWholePageCaptureIdentity(wholePageIdentityBaseline, restored);
              selection.pageRect = restored.pageRect;
              selection.overlayRect = denormalizeRect(selection.rect, restored.pageRect);
              this.paintSelection(selection.overlayRect);
              this.showPageSnapshot(restored);
            }
          } catch (error) {
            restorationError = error;
          }
        }
        if (pageCaptureToken && pageCapturePage !== null && webview === this.webview) {
          try {
            await releaseNotabilityPageCapture(webview, pageCapturePage, pageCaptureToken);
          } catch {
            // A transient guest marker is non-persistent; capture validity is
            // already governed by the claimed object identity and restoration.
          }
        }
        if (captureChromeToken && webview === this.webview) {
          try {
            await restoreNotabilityCaptureChrome(webview, captureChromeToken);
          } catch (error) {
            restorationError ??= error;
          }
        }
      } finally {
        this.captureCancellationChecksSuspended = false;
      }
    }
    try {
      const completed = captureResultAfterRestoration(pendingSave, captureError, restorationError);
      this.captureCancellation.assertCurrent(cancellationTicket);
      await this.sealCaptureCancellation(cancellationTicket);
      this.setStatus("Saving the completed Notability preview...");
      await this.host.savePreview(completed.region, completed.bytes, completed.capture);
      return completed.region;
    } finally {
      // Keep the guest blocked until the new pixels and their descriptor have
      // committed. Re-enabling controls sooner lets a second capture reuse the
      // same materialized region while its first preview is still being saved.
      this.setCaptureInteractionBlocked(false);
      this.captureInProgress = false;
      this.updateControls();
    }
  }

  private setStatus(value: string, offerAreaFallback = false): void {
    this.statusEl?.setText(value);
    if (this.areaFallbackButton) {
      if (offerAreaFallback) this.areaFallbackButton.show();
      else this.areaFallbackButton.hide();
    }
  }
}
