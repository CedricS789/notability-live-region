import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import {
  CaptureCancellationGate,
  CaptureCancelledError,
  CaptureSelectionState
} from "../src/capture-state";

const obsidianRuntimeUrl = `data:text/javascript,${encodeURIComponent(`
  export class ItemView {}
  export class Notice { constructor(message) { this.message = message; } }
  export function setIcon() {}
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "obsidian") return { url: obsidianRuntimeUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});

const { NotabilityCaptureView } = await import("../src/capture-view");

function viewWithControls() {
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    loaded: true,
    interactionMode: "area",
    selection: {
      page: 2,
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
    },
    captureState: { openedRegion: () => null },
    captureInProgress: false,
    clipboardOperationInProgress: false,
    pageEmbedPreparing: false,
    copyLinkButton: { disabled: true },
    copyEmbedButton: { disabled: true, textContent: "", setAttribute: () => undefined },
    copyPageEmbedButton: { disabled: true },
    refreshButton: { disabled: true }
  });
  return view;
}

test("every capture-operation phase locks the capture controls", () => {
  const view = viewWithControls();
  view.updateControls();
  assert.equal(view.copyLinkButton.disabled, false);
  assert.equal(view.copyEmbedButton.disabled, false);
  assert.equal(view.copyPageEmbedButton.disabled, false);

  for (const phase of ["captureInProgress", "clipboardOperationInProgress", "pageEmbedPreparing"]) {
    view.captureInProgress = false;
    view.clipboardOperationInProgress = false;
    view.pageEmbedPreparing = false;
    view[phase] = true;
    view.updateControls();
    assert.equal(view.copyLinkButton.disabled, true, phase);
    assert.equal(view.copyEmbedButton.disabled, true, phase);
    assert.equal(view.copyPageEmbedButton.disabled, true, phase);
    assert.equal(view.refreshButton.disabled, true, phase);
  }
});

test("copy and whole-page entry points reject overlapping operations", async () => {
  const view = viewWithControls();
  view.clipboardOperationInProgress = true;
  await assert.rejects(view.copySelection("embed"), /copy operation is already in progress/);
  await assert.rejects(view.copyCurrentPageEmbed(), /preview capture is already in progress/);
});

test("Escape invalidates a pending copy capture without clipboard delivery or a mode switch", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const gate = new CaptureCancellationGate();
  const calls: string[] = [];
  let signalCaptureStarted!: () => void;
  let releaseCapture!: () => void;
  const captureStarted = new Promise<void>((resolve) => { signalCaptureStarted = resolve; });
  const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    interactionMode: "area",
    autoInsertEmbeds: false,
    captureCancellation: gate,
    activeCaptureCancellationTicket: null,
    clipboardOperationInProgress: false,
    pageEmbedPreparing: false,
    captureInProgress: false,
    selection: { fallbackLabel: null },
    returnMarkdownLeaf: null,
    captureSelectionPreview: async (_opened: boolean, ticket: number) => {
      calls.push("capture-started");
      signalCaptureStarted();
      await captureGate;
      gate.assertCurrent(ticket);
      throw new Error("unreachable");
    },
    updateControls: () => undefined,
    setStatus: (value: string) => calls.push(value),
    setInteractionMode: (mode: string) => calls.push(`mode-${mode}`),
    focusMarkdownAfterCopy: async () => calls.push("focus"),
    host: { resolveEmbedInsertionTarget: () => null }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => calls.push("clipboard") } }
  });

  try {
    assert.equal(view.requestCaptureCancellation(), false, "idle Escape is not consumed");
    const copying = view.copySelection("embed");
    await captureStarted;
    assert.equal(view.requestCaptureCancellation(), true);
    assert.equal(view.requestCaptureCancellation(), true, "repeat Escape is consumed while cancellation settles");
    releaseCapture();
    await assert.rejects(copying, CaptureCancelledError);
    assert.equal(view.clipboardOperationInProgress, false);
    assert.equal(view.interactionMode, "area");
    assert.equal(calls.includes("clipboard"), false);
    assert.equal(calls.some((value) => value.startsWith("mode-")), false);
    assert.equal(calls.includes("focus"), false);
    assert.match(calls.join(" "), /Cancelling capture/);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("Escape is ignored after the non-abortable preview commit boundary is sealed", async () => {
  const attributes = new Map<string, string>([["aria-keyshortcuts", "Escape"]]);
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    captureCancellation: new CaptureCancellationGate(),
    activeCaptureCancellationTicket: null,
    cancelAreaSelectionDrag: null,
    captureInteractionBlocker: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name)
    }
  });
  const ticket = view.beginCaptureCancellation();
  await view.sealCaptureCancellation(ticket);
  assert.equal(view.requestCaptureCancellation(), false);
  assert.equal(view.captureCancellation.isCurrent(ticket), true);
  assert.equal(attributes.has("aria-keyshortcuts"), false);
  assert.match(attributes.get("aria-label") ?? "", /cannot be cancelled/);
});

test("a guest Escape pressed before seal cancels even when its console marker is delayed", async () => {
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    captureCancellation: new CaptureCancellationGate(),
    activeCaptureCancellationTicket: null,
    cancelAreaSelectionDrag: null,
    attached: true,
    webview: {
      executeJavaScript: async () => ({
        available: true,
        generation: view.guestCaptureEscapeGeneration,
        id: null,
        matched: true,
        requested: true
      })
    }
  });
  const ticket = view.beginCaptureCancellation();
  view.guestCaptureEscapeArmed = true;

  await assert.rejects(view.sealCaptureCancellation(ticket), CaptureCancelledError);
  assert.equal(view.captureCancellation.isCurrent(ticket), false);
  assert.equal(view.requestCaptureCancellation(), true, "cancellation remains active until operation cleanup");
  view.finishCaptureCancellation(ticket, true);
  assert.equal(view.requestCaptureCancellation(), false);
});

test("Text selection is finalized before the focus-moving capture blocker is installed", async () => {
  const noteUrl = "https://notability.com/app/note/11111111-2222-4333-8444-555555555555";
  const calls: string[] = [];
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    interactionMode: "text",
    selection: null,
    captureState: { openedRegion: () => null },
    captureCancellation: new CaptureCancellationGate(),
    activeCaptureCancellationTicket: null,
    captureInProgress: false,
    clipboardOperationInProgress: false,
    pageEmbedPreparing: false,
    attached: true,
    navigationGeneration: 0,
    targetNoteUrl: noteUrl,
    webview: {
      getURL: () => noteUrl,
      getZoomFactor: () => 1,
      executeJavaScript: async () => {
        const id = view.guestCaptureEscapeId;
        calls.push(id ? "arm-guest" : "disarm-guest");
        return {
          available: true,
          generation: view.guestCaptureEscapeGeneration,
          id
        };
      }
    },
    finalizeTextSelection: async () => {
      calls.push("finalize-text");
      view.selection = {
        kind: "text",
        pageRect: { x: 0, y: 0, width: 600, height: 800 },
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        overlayRect: { x: 60, y: 160, width: 180, height: 80 },
        page: 2,
        fingerprint: { kind: "none" },
        fallbackLabel: "Selected PDF text"
      };
    },
    setCaptureInteractionBlocked: (blocked: boolean) => {
      calls.push(`block-${blocked}`);
      if (blocked) throw new Error("stop after blocker installation");
    },
    updateControls: () => undefined,
    setStatus: () => undefined
  });

  await assert.rejects(
    view.copySelection("embed", {
      requested: false,
      insertion: null,
      targetLeaf: null,
      targetLabel: null
    }),
    /stop after blocker installation/
  );

  assert.deepEqual(calls.slice(0, 3), ["arm-guest", "finalize-text", "block-true"]);
  assert.equal(view.activeCaptureCancellationTicket, null);
  assert.equal(view.clipboardOperationInProgress, false);
});

test("the guest Escape marker cancels only its exact active viewer operation", () => {
  const calls: string[] = [];
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    guestCaptureEscapeId: "capture:nr-current",
    requestCaptureCancellation: () => {
      calls.push("cancel");
      return true;
    }
  });

  view.handleGuestConsoleMessage({ message: "ordinary Notability log" });
  view.handleGuestConsoleMessage({ message: "notability-live-region.capture-escape:capture:nr-stale" });
  view.handleGuestConsoleMessage({ message: "notability-live-region.capture-escape:capture:nr-current" });
  assert.deepEqual(calls, ["cancel"]);
});

test("Escape after Area pointerup cancels deferred finalization before it can paint", async () => {
  const listeners = new Map<string, (event: any) => void>();
  const calls: string[] = [];
  let capturedPointer: number | null = null;
  let signalInspectionStarted!: () => void;
  let releaseInspection!: (snapshot: unknown) => void;
  const inspectionStarted = new Promise<void>((resolve) => { signalInspectionStarted = resolve; });
  const inspection = new Promise<unknown>((resolve) => { releaseInspection = resolve; });
  const webview = {
    executeJavaScript: async () => {
      signalInspectionStarted();
      return inspection;
    }
  };
  const shield = {
    tabIndex: 0,
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: (pointerId: number) => { capturedPointer = pointerId; },
    hasPointerCapture: (pointerId: number) => capturedPointer === pointerId,
    releasePointerCapture: () => { capturedPointer = null; },
    focus: () => undefined
  };
  let task: Promise<void> | null = null;
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    webview,
    interactionMode: "area",
    captureInProgress: false,
    captureCancellation: new CaptureCancellationGate(),
    activeCaptureCancellationTicket: null,
    navigationGeneration: 0,
    selectionRequestGeneration: 0,
    selectionEl: {},
    detachOpenedRegionForManualNavigation: () => undefined,
    paintSelection: () => calls.push("paint"),
    showPageSnapshot: () => calls.push("snapshot"),
    updateControls: () => undefined,
    clearSelectionGeometry: () => calls.push("clear"),
    setStatus: (value: string) => calls.push(value),
    runToolbarTask: (_label: string, operation: () => Promise<void>) => {
      task = operation();
    }
  });

  view.installSelectionHandlers(shield);
  listeners.get("pointerdown")!({
    isPrimary: true,
    button: 0,
    pointerId: 9,
    clientX: 40,
    clientY: 80
  });
  listeners.get("pointerup")!({ pointerId: 9, clientX: 220, clientY: 320 });
  await inspectionStarted;

  assert.equal(view.requestCaptureCancellation(), true);
  releaseInspection({
    ok: true,
    title: "Fixture note",
    page: 2,
    pageCount: 4,
    pageRect: { x: 0, y: 0, width: 600, height: 800 },
    pageAspect: 0.75
  });
  await assert.rejects(task!, CaptureCancelledError);

  assert.equal(calls.includes("paint"), false);
  assert.equal(calls.includes("snapshot"), false);
  assert.equal(view.selection, undefined);
  assert.equal(view.activeCaptureCancellationTicket, null);
  assert.equal(view.requestCaptureCancellation(), false);
});

test("cancelled whole-page capture restores the prior selection, opened metadata, and opened mode", async () => {
  const noteUrl = "https://notability.com/app/note/11111111-2222-4333-8444-555555555555";
  const opened = {
    v: 1,
    id: "nr-11111111-2222-4333-8444-555555555555",
    url: noteUrl,
    title: "Fixture note",
    page: 2,
    rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
    expectedPageCount: 4,
    pageAspect: 0.75,
    fingerprint: { kind: "none" },
    adapter: "notability-web-v1",
    capturedAt: "2026-08-14T12:00:00.000Z"
  };
  const previousSelection = {
    kind: "area",
    pageRect: { x: 5, y: 10, width: 590, height: 790 },
    rect: { ...opened.rect },
    overlayRect: { x: 64, y: 168, width: 177, height: 197.5 },
    page: 2,
    fingerprint: { kind: "none" },
    fallbackLabel: null
  };
  const captureState = new CaptureSelectionState();
  captureState.open(opened as any);
  let openedMode = "text";
  const calls: string[] = [];
  let signalWholePageStarted!: () => void;
  let releaseWholePage!: () => void;
  const wholePageStarted = new Promise<void>((resolve) => { signalWholePageStarted = resolve; });
  const wholePageGate = new Promise<void>((resolve) => { releaseWholePage = resolve; });
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    loaded: true,
    targetNoteUrl: noteUrl,
    webview: {
      getURL: () => noteUrl,
      executeJavaScript: async () => ({
        ok: true,
        title: "Fixture note",
        page: 2,
        pageCount: 4,
        pageRect: { x: 0, y: 0, width: 600, height: 800 },
        pageAspect: 0.75
      })
    },
    captureState,
    openedRegionMode: {
      current: () => openedMode,
      open: (mode: string) => { openedMode = mode; },
      clear: () => { openedMode = "area"; }
    },
    selection: previousSelection,
    captureCancellation: new CaptureCancellationGate(),
    activeCaptureCancellationTicket: null,
    captureInProgress: false,
    clipboardOperationInProgress: false,
    pageEmbedPreparing: false,
    navigationGeneration: 3,
    selectionRequestGeneration: 4,
    prepareEmbedDelivery: () => ({
      requested: false,
      insertion: null,
      targetLeaf: null,
      targetLabel: null
    }),
    copySelection: async (_mode: string, _delivery: unknown, ticket: number) => {
      calls.push("whole-page-started");
      signalWholePageStarted();
      await wholePageGate;
      view.captureCancellation.assertCurrent(ticket);
    },
    paintSelection: (rect: unknown) => calls.push(`paint-${JSON.stringify(rect)}`),
    showPageSnapshot: () => undefined,
    updateControls: () => undefined,
    setCaptureInteractionBlocked: (blocked: boolean) => calls.push(`block-${blocked}`),
    setStatus: (value: string) => calls.push(value),
    host: {
      requestLayoutSave: () => calls.push("layout-save")
    }
  });

  const copying = view.copyCurrentPageEmbed();
  await wholePageStarted;
  assert.equal(view.selection.kind, "page");
  assert.equal(captureState.openedRegion(), null);
  assert.equal(view.requestCaptureCancellation(), true);
  releaseWholePage();
  await assert.rejects(copying, CaptureCancelledError);

  assert.equal(captureState.openedRegion(), opened);
  assert.equal(captureState.reusableRegion(), opened);
  assert.equal(openedMode, "text");
  assert.equal(view.selection.kind, "area");
  assert.deepEqual(view.selection.rect, previousSelection.rect);
  assert.deepEqual(view.selection.pageRect, { x: 0, y: 0, width: 600, height: 800 });
  assert.deepEqual(view.selection.overlayRect, { x: 60, y: 160, width: 180, height: 200 });
  assert.equal(view.pageEmbedPreparing, false);
  assert.equal(view.activeCaptureCancellationTicket, null);
  assert.equal(calls.includes("layout-save"), true);
});

test("Escape during deferred post-seal persistence is ignored and delivery still completes", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: string[] = [];
  let signalSaveStarted!: () => void;
  let releaseSave!: () => void;
  const saveStarted = new Promise<void>((resolve) => { signalSaveStarted = resolve; });
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const targetLeaf = { id: "origin" };
  const captured = {
    v: 1,
    id: "nr-11111111-2222-4333-8444-555555555555",
    url: "https://notability.com/app/note/11111111-2222-4333-8444-555555555555",
    title: "Fixture note",
    page: 2,
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    expectedPageCount: 3,
    pageAspect: 0.75,
    fingerprint: { kind: "none" },
    adapter: "notability-web-v1",
    capturedAt: "2026-08-14T12:00:00.000Z"
  };
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    interactionMode: "area",
    selection: { fallbackLabel: null },
    captureCancellation: new CaptureCancellationGate(),
    activeCaptureCancellationTicket: null,
    captureInProgress: false,
    clipboardOperationInProgress: false,
    pageEmbedPreparing: false,
    captureSelectionPreview: async (_opened: boolean, ticket: number) => {
      await view.sealCaptureCancellation(ticket);
      await view.host.savePreview();
      return captured;
    },
    updateControls: () => undefined,
    setCaptureInteractionBlocked: () => undefined,
    setInteractionMode: (mode: string) => {
      view.interactionMode = mode;
      calls.push(`mode-${mode}`);
    },
    setStatus: () => undefined,
    focusMarkdownAfterCopy: async (leaf: { id: string } | null) => calls.push(`focus-${leaf?.id ?? "none"}`),
    host: {
      savePreview: async () => {
        calls.push("save-started");
        signalSaveStarted();
        await saveGate;
        calls.push("save-settled");
      }
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => calls.push("clipboard")
      }
    }
  });

  try {
    const copying = view.copySelection("embed", {
      requested: true,
      insertion: {
        commit: () => {
          calls.push("commit");
          return true;
        }
      },
      targetLeaf,
      targetLabel: "Fixture.md"
    });
    await saveStarted;
    assert.equal(view.requestCaptureCancellation(), false);
    assert.equal(view.requestCaptureCancellation(), false);
    releaseSave();
    await copying;

    assert.deepEqual(calls, [
      "save-started",
      "save-settled",
      "clipboard",
      "commit",
      "mode-browse",
      "focus-origin"
    ]);
    assert.equal(view.clipboardOperationInProgress, false);
    assert.equal(view.activeCaptureCancellationTicket, null);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("Escape cancels an active Area drag, releases pointer capture, and suppresses late pointerup", () => {
  const listeners = new Map<string, (event: any) => void>();
  const calls: string[] = [];
  let capturedPointer: number | null = null;
  const shield = {
    tabIndex: 0,
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    setPointerCapture: (pointerId: number) => {
      capturedPointer = pointerId;
      calls.push(`capture-${pointerId}`);
    },
    hasPointerCapture: (pointerId: number) => capturedPointer === pointerId,
    releasePointerCapture: (pointerId: number) => {
      capturedPointer = null;
      calls.push(`release-${pointerId}`);
    },
    focus: () => calls.push("focus")
  };
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    interactionMode: "area",
    captureInProgress: false,
    selectionEl: {},
    detachOpenedRegionForManualNavigation: () => calls.push("detach"),
    clearSelectionGeometry: () => calls.push("clear"),
    paintSelection: () => calls.push("paint"),
    setStatus: (value: string) => calls.push(value),
    runToolbarTask: () => calls.push("finalize")
  });

  view.installSelectionHandlers(shield);
  listeners.get("pointerdown")!({
    isPrimary: true,
    button: 0,
    pointerId: 7,
    clientX: 30,
    clientY: 50
  });
  listeners.get("pointermove")!({ pointerId: 7, clientX: 60, clientY: 90 });
  assert.equal(view.requestCaptureCancellation(), true);
  listeners.get("pointerup")!({ pointerId: 7, clientX: 70, clientY: 100 });

  assert.equal(shield.tabIndex, -1);
  assert.equal(capturedPointer, null);
  assert.deepEqual(calls.slice(0, 4), ["capture-7", "focus", "detach", "Selecting a new region..."]);
  assert.equal(calls.includes("paint"), true);
  assert.equal(calls.includes("release-7"), true);
  assert.equal(calls.includes("clear"), true);
  assert.match(calls.join(" "), /Selection cancelled/);
  assert.equal(calls.includes("finalize"), false);
  assert.equal(view.requestCaptureCancellation(), false);
});

test("insert-on-copy cannot arm without an editable Markdown target and names a valid target", () => {
  const statuses: string[] = [];
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    autoInsertEmbeds: false,
    captureInProgress: false,
    clipboardOperationInProgress: false,
    pageEmbedPreparing: false,
    returnMarkdownLeaf: null,
    updateControls: () => undefined,
    setStatus: (status: string) => statuses.push(status),
    host: { resolveEmbedInsertionTarget: () => null }
  });

  assert.equal(view.toggleAutoInsertEmbeds(), false);
  assert.equal(view.autoInsertEmbeds, false);
  assert.match(statuses.at(-1) ?? "", /editable Markdown note/);

  const targetLeaf = { id: "markdown-target" };
  view.host.resolveEmbedInsertionTarget = () => ({ leaf: targetLeaf, label: "Course/Chapter.md", identity: targetLeaf });
  assert.equal(view.toggleAutoInsertEmbeds(), true);
  assert.equal(view.returnMarkdownLeaf, targetLeaf);
  assert.match(statuses.at(-1) ?? "", /Course\/Chapter\.md/);
  assert.match(statuses.at(-1) ?? "", /selecting alone does not start a capture/);

  const secondLeaf = { id: "second-target" };
  view.host.resolveEmbedInsertionTarget = () => ({ leaf: secondLeaf, label: "Course/Second.md", identity: secondLeaf });
  view.setReturnMarkdownLeaf(secondLeaf);
  assert.equal(view.autoInsertEmbeds, false, "a valid new destination must require explicit re-arming");
  assert.match(statuses.at(-1) ?? "", /target changed to Course\/Second\.md/);

  assert.equal(view.toggleAutoInsertEmbeds(), true);
  view.host.resolveEmbedInsertionTarget = () => null;
  view.setReturnMarkdownLeaf(null);
  assert.equal(view.autoInsertEmbeds, false);
  assert.match(statuses.at(-1) ?? "", /target is no longer available/);
});

test("a long capture inserts and refocuses the exact Markdown target pinned at action start", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const targetA = { id: "A" };
  const targetB = { id: "B" };
  const calls: string[] = [];
  const region = {
    v: 1,
    id: "nr-11111111-2222-4333-8444-555555555555",
    url: "https://notability.com/app/note/11111111-2222-4333-8444-555555555555",
    title: "Fixture note",
    page: 2,
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    expectedPageCount: 3,
    pageAspect: 0.75,
    fingerprint: { kind: "none" },
    adapter: "notability-web-v1",
    capturedAt: "2026-08-14T12:00:00.000Z"
  };
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    interactionMode: "area",
    autoInsertEmbeds: true,
    clipboardOperationInProgress: false,
    returnMarkdownLeaf: targetA,
    selection: { fallbackLabel: null },
    captureSelectionPreview: async () => {
      view.returnMarkdownLeaf = targetB;
      calls.push("viewer-rebound-B");
      return region;
    },
    updateControls: () => undefined,
    setInteractionMode: () => undefined,
    setStatus: () => undefined,
    focusMarkdownAfterCopy: async (leaf: { id: string } | null) => calls.push(`focus-${leaf?.id ?? "none"}`),
    host: {
      resolveEmbedInsertionTarget: (leaf: { id: string } | null) => leaf ? { leaf, label: `${leaf.id}.md`, identity: leaf } : null,
      prepareEmbedInsertion: (leaf: { id: string }) => {
        calls.push(`prepare-${leaf.id}`);
        return { commit: () => {
          calls.push(`commit-${leaf.id}`);
          return true;
        } };
      }
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => calls.push("clipboard") } }
  });

  try {
    await view.copySelection("embed");
    assert.deepEqual(calls, ["prepare-A", "viewer-rebound-B", "clipboard", "commit-A", "focus-A"]);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("failed focus of a pinned insertion target never redirects to another Markdown note", async () => {
  const targetA = { id: "A" };
  const calls: string[] = [];
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    returnMarkdownLeaf: targetA,
    returnMarkdownTargetIdentity: targetA,
    app: {
      workspace: {
        revealLeaf: async () => { throw new Error("target closed"); },
        setActiveLeaf: () => calls.push("set-active")
      }
    },
    host: {
      resolveEmbedInsertionTarget: (leaf: object | null) => leaf ? { leaf, label: "A.md", identity: leaf } : null,
      focusMarkdownAfterCopy: async () => calls.push("global-fallback")
    }
  });

  await view.focusMarkdownAfterCopy(targetA);
  assert.deepEqual(calls, []);
  assert.equal(view.returnMarkdownLeaf, null);
  assert.equal(view.returnMarkdownTargetIdentity, null);
});

test("a successful selection copy returns to Browse, while clipboard failure preserves the capture mode", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const region = {
    v: 1,
    id: "nr-11111111-2222-4333-8444-555555555555",
    url: "https://notability.com/app/note/11111111-2222-4333-8444-555555555555",
    title: "Fixture note",
    page: 2,
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    expectedPageCount: 3,
    pageAspect: 0.75,
    fingerprint: { kind: "none" },
    adapter: "notability-web-v1",
    capturedAt: "2026-08-14T12:00:00.000Z"
  };
  const createCopyView = (
    writeText: (markdown: string) => Promise<void>,
    options: {
      autoInsert?: boolean;
      commit?: (markdown: string) => boolean;
      prepareThrows?: boolean;
    } = {}
  ) => {
    const calls: string[] = [];
    const view = Object.create(NotabilityCaptureView.prototype) as any;
    Object.assign(view, {
      interactionMode: "area",
      autoInsertEmbeds: options.autoInsert === true,
      clipboardOperationInProgress: false,
      selection: { fallbackLabel: null },
      captureSelectionPreview: async () => region,
      updateControls: () => undefined,
      setInteractionMode: (mode: string) => {
        view.interactionMode = mode;
        calls.push(`mode-${mode}`);
      },
      setStatus: () => undefined,
      focusMarkdownAfterCopy: async () => calls.push("focus-markdown"),
      returnMarkdownLeaf: { id: "origin" },
      host: {
        resolveEmbedInsertionTarget: (leaf: object) => ({ leaf, label: "Fixture.md", identity: leaf }),
        prepareEmbedInsertion: () => {
          calls.push("prepare-insertion");
          if (options.prepareThrows) throw new Error("origin editor disappeared");
          return { commit: (markdown: string) => {
            calls.push("commit-insertion");
            return options.commit?.(markdown) ?? false;
          } };
        }
      }
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText } }
    });
    return { view, calls };
  };

  try {
    const written: string[] = [];
    const success = createCopyView(async (markdown) => {
      written.push(markdown);
      success.calls.push("clipboard-written");
    });
    await success.view.copySelection("embed");
    assert.equal(written.length, 1);
    assert.deepEqual(success.calls, ["clipboard-written", "mode-browse", "focus-markdown"]);
    assert.equal(success.view.interactionMode, "browse");

    const failure = createCopyView(async () => {
      throw new Error("clipboard denied");
    });
    await assert.rejects(failure.view.copySelection("link"), /clipboard denied/);
    assert.deepEqual(failure.calls, []);
    assert.equal(failure.view.interactionMode, "area");

    const inserted = createCopyView(async () => {
      inserted.calls.push("clipboard-written");
    }, {
      autoInsert: true,
      commit: () => true
    });
    await inserted.view.copySelection("embed");
    assert.deepEqual(inserted.calls, [
      "prepare-insertion",
      "clipboard-written",
      "commit-insertion",
      "mode-browse",
      "focus-markdown"
    ]);

    const link = createCopyView(async () => undefined, { autoInsert: true, commit: () => true });
    await link.view.copySelection("link");
    assert.doesNotMatch(link.calls.join(" "), /insertion/, "Copy link never auto-inserts");

    const vanishedEditor = createCopyView(async () => {
      vanishedEditor.calls.push("clipboard-written");
    }, { autoInsert: true, prepareThrows: true });
    await vanishedEditor.view.copySelection("embed");
    assert.deepEqual(vanishedEditor.calls, [
      "prepare-insertion",
      "clipboard-written",
      "mode-browse",
      "focus-markdown"
    ], "editor teardown must fall back to a normal clipboard copy");
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("a successful whole-page copy clears its outline when the viewer was already in Browse", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: string[] = [];
  const region = {
    v: 1,
    id: "nr-11111111-2222-4333-8444-555555555555",
    url: "https://notability.com/app/note/11111111-2222-4333-8444-555555555555",
    title: "Fixture note",
    page: 2,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    expectedPageCount: 3,
    pageAspect: 0.75,
    fingerprint: { kind: "none" },
    adapter: "notability-web-v1",
    capturedAt: "2026-08-15T08:00:00.000Z"
  };
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    interactionMode: "browse",
    autoInsertEmbeds: false,
    clipboardOperationInProgress: false,
    selection: { kind: "page", fallbackLabel: null },
    captureSelectionPreview: async () => region,
    clearSelectionGeometry: () => {
      view.selection = null;
      calls.push("outline-cleared");
    },
    setInteractionMode: (mode: string) => {
      view.interactionMode = mode;
      calls.push(`mode-${mode}`);
    },
    updateControls: () => undefined,
    setStatus: () => undefined,
    focusMarkdownAfterCopy: async () => calls.push("focus-markdown"),
    returnMarkdownLeaf: null,
    host: { resolveEmbedInsertionTarget: () => null }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => calls.push("clipboard-written")
      }
    }
  });

  try {
    await view.copySelection("embed");
    assert.equal(view.selection, null);
    assert.deepEqual(calls, [
      "clipboard-written",
      "outline-cleared",
      "mode-browse",
      "focus-markdown"
    ]);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("auto-insert waits for clipboard settlement before committing or returning to Browse", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: string[] = [];
  let signalClipboardStarted!: () => void;
  let releaseClipboard!: () => void;
  const clipboardStarted = new Promise<void>((resolve) => { signalClipboardStarted = resolve; });
  const clipboardGate = new Promise<void>((resolve) => { releaseClipboard = resolve; });
  const region = {
    v: 1,
    id: "nr-11111111-2222-4333-8444-555555555555",
    url: "https://notability.com/app/note/11111111-2222-4333-8444-555555555555",
    title: "Fixture note",
    page: 2,
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    expectedPageCount: 3,
    pageAspect: 0.75,
    fingerprint: { kind: "none" },
    adapter: "notability-web-v1",
    capturedAt: "2026-08-14T12:00:00.000Z"
  };
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    interactionMode: "area",
    autoInsertEmbeds: true,
    clipboardOperationInProgress: false,
    selection: { fallbackLabel: null },
    armGuestCaptureEscape: async () => calls.push("arm-escape"),
    captureSelectionPreview: async () => {
      calls.push("capture-preview");
      return region;
    },
    updateControls: () => undefined,
    setInteractionMode: (mode: string) => {
      view.interactionMode = mode;
      calls.push(`mode-${mode}`);
    },
    setStatus: () => undefined,
    focusMarkdownAfterCopy: async () => calls.push("focus-markdown"),
    returnMarkdownLeaf: { id: "origin" },
    host: {
      resolveEmbedInsertionTarget: (leaf: object) => ({ leaf, label: "Fixture.md", identity: leaf }),
      prepareEmbedInsertion: () => {
        calls.push("prepare-insertion");
        return {
          commit: () => {
            calls.push("commit-insertion");
            return true;
          }
        };
      }
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => {
          calls.push("clipboard-started");
          signalClipboardStarted();
          await clipboardGate;
          calls.push("clipboard-settled");
        }
      }
    }
  });

  try {
    const copying = view.copySelection("embed");
    await clipboardStarted;
    assert.deepEqual(calls, ["prepare-insertion", "capture-preview", "clipboard-started"]);
    assert.equal(view.interactionMode, "area", "selection mode remains active while clipboard permission is pending");

    releaseClipboard();
    await copying;
    assert.deepEqual(calls, [
      "prepare-insertion",
      "capture-preview",
      "clipboard-started",
      "clipboard-settled",
      "commit-insertion",
      "mode-browse",
      "focus-markdown"
    ]);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("capture failure preserves selection mode and never reaches clipboard or insertion", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: string[] = [];
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    interactionMode: "text",
    autoInsertEmbeds: true,
    clipboardOperationInProgress: false,
    selection: { fallbackLabel: null },
    armGuestCaptureEscape: async () => calls.push("arm-escape"),
    captureSelectionPreview: async () => {
      calls.push("capture-preview");
      throw new Error("capture geometry changed");
    },
    updateControls: () => undefined,
    setInteractionMode: (mode: string) => {
      view.interactionMode = mode;
      calls.push(`mode-${mode}`);
    },
    setStatus: () => undefined,
    focusMarkdownAfterCopy: async () => calls.push("focus-markdown"),
    returnMarkdownLeaf: { id: "origin" },
    host: {
      resolveEmbedInsertionTarget: (leaf: object) => ({ leaf, label: "Fixture.md", identity: leaf }),
      prepareEmbedInsertion: () => {
        calls.push("prepare-insertion");
        return { commit: () => calls.push("commit-insertion") };
      }
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => calls.push("clipboard-written") } }
  });

  try {
    await assert.rejects(view.copySelection("embed"), /capture geometry changed/);
    assert.deepEqual(calls, ["arm-escape", "prepare-insertion", "capture-preview"]);
    assert.equal(view.interactionMode, "text");
    assert.equal(view.clipboardOperationInProgress, false);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("Refresh preview neither prepares auto-insertion nor switches to Browse", async () => {
  const calls: string[] = [];
  const region = {
    title: "Fixture note",
    page: 2
  };
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    interactionMode: "area",
    autoInsertEmbeds: true,
    captureSelectionPreview: async (requireOpenedRegion: boolean) => {
      calls.push(`capture-preview-${requireOpenedRegion}`);
      return region;
    },
    prepareEmbedDelivery: () => calls.push("prepare-delivery"),
    setInteractionMode: (mode: string) => {
      view.interactionMode = mode;
      calls.push(`mode-${mode}`);
    },
    setStatus: (status: string) => calls.push(status),
    host: { prepareEmbedInsertion: () => calls.push("prepare-insertion") }
  });

  await view.refreshExistingPreview();

  assert.equal(view.interactionMode, "area");
  assert.deepEqual(calls.slice(0, 1), ["capture-preview-true"]);
  assert.match(calls[1] ?? "", /^Refreshed the preview/);
  assert.doesNotMatch(calls.join(" "), /prepare-(?:delivery|insertion)|mode-browse/);
});

test("failed and throwing auto-insert commits preserve the copied embed fallback", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const region = {
    v: 1,
    id: "nr-11111111-2222-4333-8444-555555555555",
    url: "https://notability.com/app/note/11111111-2222-4333-8444-555555555555",
    title: "Fixture note",
    page: 2,
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    expectedPageCount: 3,
    pageAspect: 0.75,
    fingerprint: { kind: "none" },
    adapter: "notability-web-v1",
    capturedAt: "2026-08-14T12:00:00.000Z"
  };

  try {
    for (const commit of [
      () => false,
      () => { throw new Error("editor transaction failed"); }
    ]) {
      const calls: string[] = [];
      const written: string[] = [];
      const statuses: string[] = [];
      const view = Object.create(NotabilityCaptureView.prototype) as any;
      Object.assign(view, {
        interactionMode: "area",
        autoInsertEmbeds: true,
        clipboardOperationInProgress: false,
        selection: { fallbackLabel: null },
        captureSelectionPreview: async () => region,
        updateControls: () => undefined,
        setInteractionMode: (mode: string) => {
          view.interactionMode = mode;
          calls.push(`mode-${mode}`);
        },
        setStatus: (status: string) => statuses.push(status),
        focusMarkdownAfterCopy: async () => calls.push("focus-markdown"),
        returnMarkdownLeaf: { id: "origin" },
        host: {
          resolveEmbedInsertionTarget: (leaf: object) => ({ leaf, label: "Fixture.md", identity: leaf }),
          prepareEmbedInsertion: () => ({
            commit: () => {
              calls.push("commit-insertion");
              return commit();
            }
          })
        }
      });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
          clipboard: {
            writeText: async (markdown: string) => {
              written.push(markdown);
              calls.push("clipboard-written");
            }
          }
        }
      });

      await view.copySelection("embed");

      assert.equal(written.length, 1);
      assert.match(written[0] ?? "", /^```notability-region\n/);
      assert.deepEqual(calls, ["clipboard-written", "commit-insertion", "mode-browse", "focus-markdown"]);
      assert.match(statuses.at(-1) ?? "", /insertion into Fixture\.md was skipped/);
      assert.equal(view.interactionMode, "browse");
    }
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("guest paint opportunity fails closed on the host-side timeout when animation frames suspend", async () => {
  const view = viewWithControls();
  const started = performance.now();
  await assert.rejects(
    view.waitForBoundedGuestPaint({
      executeJavaScript: () => new Promise(() => undefined),
      ownerDocument: {
        defaultView: {
          setTimeout,
          clearTimeout
        }
      }
    }, 5),
    /did not present a painted whole-page tile in time/
  );
  assert.ok(performance.now() - started < 100, "a suspended guest must not hold the capture lock indefinitely");
});

test("same-mode capture intent detaches an in-flight saved target without replacing its navigation record", () => {
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  const pending = {
    requestId: 9,
    url: "https://notability.com/app/note/11111111-2222-4333-8444-555555555555",
    targetRegion: { id: "old-region" },
    targetMode: "area"
  };
  const calls: string[] = [];
  Object.assign(view, {
    captureInProgress: false,
    interactionMode: "area",
    navigationGeneration: 4,
    pendingNavigation: pending,
    loadingPreviewRequestId: 9,
    loadingPreviewEl: null,
    selection: null,
    captureState: {
      openedRegion: () => null,
      reusableRegion: () => null,
      clear: () => calls.push("capture-clear")
    },
    regionAlignment: { cancel: () => calls.push("alignment-cancel") },
    openedRegionMode: { clear: () => calls.push("mode-clear") },
    clearSelectionGeometry: () => calls.push("geometry-clear"),
    hideLoadingPreview: () => calls.push("preview-hide"),
    host: { requestLayoutSave: () => calls.push("layout-save") },
    setInteractionMode: (mode: string) => calls.push(`set-${mode}`)
  });

  view.chooseInteractionMode("area");
  assert.equal(view.pendingNavigation, pending, "load rejection cleanup retains object identity");
  assert.equal(pending.targetRegion, null, "the old rectangle cannot reattach on navigation commit");
  assert.equal(view.navigationGeneration, 5);
  assert.deepEqual(calls, [
    "alignment-cancel",
    "capture-clear",
    "mode-clear",
    "geometry-clear",
    "preview-hide",
    "layout-save",
    "set-area"
  ]);
});

test("Text pointer input stays shielded until the current guest lock acknowledges", async () => {
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  const deferred: Array<{
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }> = [];
  const webview = {
    executeJavaScript: () => new Promise((resolve, reject) => deferred.push({ resolve, reject }))
  };
  let status = "";
  Object.assign(view, {
    webview,
    attached: true,
    loaded: true,
    interactionMode: "text",
    selectionScrollLockGeneration: 0,
    selectionScrollLockReady: false,
    shield: { style: {} },
    updateControls: () => undefined,
    setStatus: (value: string) => { status = value; }
  });

  view.syncGuestSelectionScrollLock();
  assert.equal(view.shield.style.pointerEvents, "auto");
  deferred[0]!.resolve({ generation: 1, locked: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(view.selectionScrollLockReady, true);
  assert.equal(view.shield.style.pointerEvents, "none");

  view.syncGuestSelectionScrollLock();
  view.syncGuestSelectionScrollLock();
  assert.equal(view.shield.style.pointerEvents, "auto");
  deferred[1]!.resolve({ generation: 2, locked: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(view.selectionScrollLockReady, false, "an obsolete acknowledgement cannot release Text input");
  assert.equal(view.shield.style.pointerEvents, "auto");
  deferred[2]!.resolve({ generation: 3, locked: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(view.selectionScrollLockReady, true);
  assert.equal(view.shield.style.pointerEvents, "none");

  view.syncGuestSelectionScrollLock();
  deferred[3]!.reject(new Error("guest unavailable"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(view.selectionScrollLockReady, false);
  assert.equal(view.shield.style.pointerEvents, "auto");
  assert.match(status, /Text mode is blocked/);
});

test("cross-note in-page navigation invalidates stale capture state while same-note route noise does not", () => {
  const noteA = "https://notability.com/app/note/11111111-2222-4333-8444-555555555555";
  const noteB = "https://notability.com/app/note/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const createView = () => {
    const calls: string[] = [];
    let opened: any = { url: noteA, id: "old-region" };
    const view = Object.create(NotabilityCaptureView.prototype) as any;
    Object.assign(view, {
      pendingNavigation: null,
      targetNoteUrl: noteA,
      browseStateUrl: noteA,
      browseStateTitle: "Old note",
      browseStatePage: 7,
      navigationGeneration: 12,
      loaded: true,
      selection: { page: 7, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
      captureState: {
        openedRegion: () => opened,
        clear: () => {
          opened = null;
          calls.push("capture-clear");
        }
      },
      openedRegionMode: { clear: () => calls.push("mode-clear") },
      regionAlignment: { cancel: () => calls.push("alignment-cancel") },
      clearSelectionGeometry: () => {
        view.selection = null;
        calls.push("geometry-clear");
      },
      hideLoadingPreview: () => calls.push("preview-hide"),
      updateControls: () => calls.push("controls-update"),
      host: { requestLayoutSave: () => calls.push("layout-save") },
      urlInput: { value: noteA }
    });
    return { view, calls, opened: () => opened };
  };

  const changed = createView();
  changed.view.commitNavigation({ url: noteB, isMainFrame: true }, false);
  assert.equal(changed.view.navigationGeneration, 13);
  assert.equal(changed.view.selection, null);
  assert.equal(changed.opened(), null);
  assert.equal(changed.view.browseStateTitle, null);
  assert.equal(changed.view.browseStatePage, null);
  assert.equal(changed.view.targetNoteUrl, noteB);
  assert.deepEqual(changed.calls.slice(0, 5), [
    "alignment-cancel",
    "capture-clear",
    "mode-clear",
    "geometry-clear",
    "preview-hide"
  ]);

  const same = createView();
  same.view.commitNavigation({ url: `${noteA}#same-note-route`, isMainFrame: true }, false);
  assert.equal(same.view.navigationGeneration, 12);
  assert.notEqual(same.view.selection, null);
  assert.notEqual(same.opened(), null);
  assert.deepEqual(same.calls, ["controls-update", "layout-save"]);
});

test("page snapshots still persist internal reading metadata without toolbar state", () => {
  let layoutSaves = 0;
  const view = Object.create(NotabilityCaptureView.prototype) as any;
  Object.assign(view, {
    browseStateTitle: null,
    browseStatePage: null,
    host: { requestLayoutSave: () => { layoutSaves += 1; } }
  });
  const snapshot = {
    title: "Fixture note",
    page: 3,
    pageCount: 9,
    pageRect: { x: 0, y: 0, width: 600, height: 800 },
    pageAspect: 0.75
  };

  view.showPageSnapshot(snapshot);
  assert.equal(view.browseStateTitle, "Fixture note");
  assert.equal(view.browseStatePage, 3);
  assert.equal(layoutSaves, 1);

  view.showPageSnapshot(snapshot);
  assert.equal(layoutSaves, 1, "an unchanged snapshot does not create redundant layout saves");
});
