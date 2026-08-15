import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, beforeEach } from "node:test";
import { JSDOM } from "jsdom";
import type { PreviewDescriptor } from "../src/cache";
import type { NotabilityRegionV1 } from "../src/model";
import type { RegionService } from "../src/service-types";
import { markdownRegionLink, regionMarkdownUrl } from "../src/url-policy";
import { region } from "./fixtures";

type GlobalKey = keyof typeof globalThis;

function installObsidianWindowHelpers(dom: JSDOM): void {
  Object.defineProperty(dom.window.document, "win", {
    configurable: true,
    value: dom.window
  });
  Object.defineProperty(dom.window, "createDiv", {
    configurable: true,
    value: () => dom.window.document.createElement("div")
  });
  Object.defineProperty(dom.window, "createEl", {
    configurable: true,
    value: (tag: string) => dom.window.document.createElement(tag)
  });
  Object.defineProperty(dom.window.Node.prototype, "instanceOf", {
    configurable: true,
    value(this: Node, type: new () => unknown) {
      return this instanceof type;
    }
  });
}

function installDom(dom: JSDOM): () => void {
  const keys: GlobalKey[] = [
    "window",
    "document",
    "navigator",
    "MutationObserver",
    "HTMLElement",
    "Element",
    "Node",
    "DOMRect",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame"
  ];
  const previous = new Map<GlobalKey, PropertyDescriptor | undefined>();
  for (const key of keys) previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const define = (key: GlobalKey, value: unknown): void => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  define("window", dom.window);
  define("document", dom.window.document);
  define("navigator", dom.window.navigator);
  define("MutationObserver", dom.window.MutationObserver);
  define("HTMLElement", dom.window.HTMLElement);
  define("Element", dom.window.Element);
  define("Node", dom.window.Node);
  define("DOMRect", dom.window.DOMRect);
  define("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  define("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  define("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
  installObsidianWindowHelpers(dom);

  const emptyRects = Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Object.defineProperty(dom.window.Range.prototype, "getClientRects", {
    configurable: true,
    value: () => emptyRects
  });
  Object.defineProperty(dom.window.Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new dom.window.DOMRect(0, 0, 0, 0)
  });

  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  };
}

function descriptor(regionId: string): PreviewDescriptor {
  return {
    regionId,
    url: `app://notability-live-region/${regionId}.png`,
    canonicalRegionHash: `sha256:${"a".repeat(64)}`,
    bytes: 2048,
    captureVersion: 3,
    cssWidth: 320,
    cssHeight: 160,
    pixelWidth: 640,
    pixelHeight: 320,
    chosenScale: 2,
    availableScales: [1, 2],
    capturedAt: "2026-08-12T10:00:00.000Z",
    lastAccessedAt: "2026-08-12T10:00:00.000Z"
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function serviceWith(
  lookup: (value: NotabilityRegionV1) => Promise<PreviewDescriptor | null>
): RegionService & { previewCalls: string[]; openCalls: string[]; refreshCalls: string[] } {
  const previewCalls: string[] = [];
  const openCalls: string[] = [];
  const refreshCalls: string[] = [];
  return {
    previewCalls,
    openCalls,
    refreshCalls,
    preview(value) {
      previewCalls.push(value.id);
      return lookup(value);
    },
    async openRegion(value) {
      openCalls.push(value.id);
    },
    async refreshRegion(value) {
      refreshCalls.push(value.id);
    },
    subscribeCacheUpdates() {
      return () => {};
    }
  };
}

function addRegionAnchor(document: Document, parent: Element, value: NotabilityRegionV1): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.setAttribute("href", regionMarkdownUrl(value));
  const child = document.createElement("span");
  child.textContent = value.title;
  anchor.append(child);
  parent.append(anchor);
  return anchor;
}

function mouse(
  dom: JSDOM,
  type: string,
  relatedTarget: EventTarget | null = null,
  ctrlKey = false
): MouseEvent {
  return new dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 10,
    ctrlKey,
    relatedTarget
  });
}

function control(dom: JSDOM, type: "keydown" | "keyup"): KeyboardEvent {
  return new dom.window.KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    code: "ControlLeft",
    ctrlKey: type === "keydown",
    key: "Control"
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const primaryDom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
const restoreDom = installDom(primaryDom);
const obsidianRuntimeUrl = new URL("./obsidian-hover-runtime.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "obsidian") return { url: obsidianRuntimeUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});

const runtime = await import("./obsidian-hover-runtime.mjs");
const {
  RegionLinkRenderChild,
  livePreviewRegionLinksExtension
} = await import("../src/link-handler");

beforeEach(() => {
  runtime.resetHoverRuntime();
  primaryDom.window.document.body.replaceChildren();
});

after(() => {
  runtime.resetHoverRuntime();
  restoreDom();
});

test("Reading View requires Ctrl, opens after a stationary press, dismisses on release, and leaves clicks unchanged", async () => {
  const container = primaryDom.window.document.createElement("main");
  primaryDom.window.document.body.append(container);
  const value = region({ id: "nr-reading-control" });
  const service = serviceWith(async ({ id }) => descriptor(id));
  const anchor = addRegionAnchor(primaryDom.window.document, container, value);
  const child = new RegionLinkRenderChild(container, service);
  child.load();

  try {
    anchor.dispatchEvent(mouse(primaryDom, "mouseover", container));
    await settle();
    assert.deepEqual(service.previewCalls, []);
    assert.equal(runtime.hoverPopovers.length, 0);

    primaryDom.window.dispatchEvent(control(primaryDom, "keydown"));
    await settle();
    assert.deepEqual(service.previewCalls, [value.id]);
    const popover = runtime.hoverPopovers[0];
    assert.ok(popover);
    runtime.showPendingHoverPopovers();
    assert.equal(popover.state, "shown");

    primaryDom.window.dispatchEvent(control(primaryDom, "keyup"));
    assert.equal(popover.state, "hidden");
    assert.equal(popover.parent.hoverPopover, null);

    const click = mouse(primaryDom, "click");
    anchor.dispatchEvent(click);
    await settle();
    assert.equal(click.defaultPrevented, true);
    assert.deepEqual(service.openCalls, [value.id]);
  } finally {
    child.unload();
  }
});

test("delayed native ownership shows a cache-only Reading View hover without self-cancelling", async () => {
  const container = primaryDom.window.document.createElement("main");
  primaryDom.window.document.body.append(container);
  const value = region();
  const anchor = addRegionAnchor(primaryDom.window.document, container, value);
  const service = serviceWith(async ({ id }) => descriptor(id));
  const child = new RegionLinkRenderChild(container, service);
  child.load();

  try {
    anchor.querySelector("span")?.dispatchEvent(mouse(primaryDom, "mouseover", container, true));
    await settle();

    assert.deepEqual(service.previewCalls, [value.id]);
    assert.deepEqual(service.openCalls, []);
    assert.deepEqual(service.refreshCalls, []);
    assert.equal(runtime.hoverPopovers.length, 1);
    const popover = runtime.hoverPopovers[0];
    assert.ok(popover);
    assert.equal(popover.parent.hoverPopover, null, "the native slot stays unclaimed until delayed onShow");
    assert.equal(popover.hoverEl.classList.contains("has-preview"), true);

    runtime.showPendingHoverPopovers();
    assert.equal(popover.hideCalls, 0, "onShow must not find and hide itself");
    assert.equal(popover.parent.hoverPopover, popover);
    assert.equal(popover.hoverEl.isConnected, true);
    assert.equal(popover.hoverEl.querySelector("img")?.getAttribute("src"), descriptor(value.id).url);
    assert.match(popover.hoverEl.textContent ?? "", /The live note may have changed/);

    const click = mouse(primaryDom, "click");
    anchor.dispatchEvent(click);
    await settle();
    assert.equal(click.defaultPrevented, true);
    assert.deepEqual(service.openCalls, [value.id]);
    assert.equal(popover.state, "hidden");
  } finally {
    child.unload();
  }
});

test("native target-to-popover transition keeps the preview open and later dismisses it", async () => {
  const container = primaryDom.window.document.createElement("main");
  primaryDom.window.document.body.append(container);
  const value = region();
  const anchor = addRegionAnchor(primaryDom.window.document, container, value);
  const child = new RegionLinkRenderChild(
    container,
    serviceWith(async ({ id }) => descriptor(id))
  );
  child.load();

  try {
    anchor.dispatchEvent(mouse(primaryDom, "mouseover", container, true));
    await settle();
    runtime.showPendingHoverPopovers();
    const popover = runtime.hoverPopovers[0];
    assert.ok(popover);

    anchor.dispatchEvent(mouse(primaryDom, "mouseout", popover.hoverEl, true));
    popover.hoverEl.dispatchEvent(mouse(primaryDom, "mouseover", anchor, true));
    await new Promise((resolve) => primaryDom.window.setTimeout(resolve, 10));
    assert.equal(popover.state, "shown");
    assert.equal(popover.hoverEl.isConnected, true);

    popover.hoverEl.dispatchEvent(mouse(primaryDom, "mouseout", primaryDom.window.document.body, true));
    await new Promise((resolve) => primaryDom.window.setTimeout(resolve, 10));
    assert.equal(popover.state, "hidden");
    assert.equal(popover.parent.hoverPopover, null);
  } finally {
    child.unload();
  }
});

test("switching targets cancels stale cache work and only renders the current region", async () => {
  const container = primaryDom.window.document.createElement("main");
  primaryDom.window.document.body.append(container);
  const first = region({ id: "nr-hover-first" });
  const second = region({ id: "nr-hover-second", page: 4 });
  const firstResult = deferred<PreviewDescriptor | null>();
  const secondResult = deferred<PreviewDescriptor | null>();
  const service = serviceWith(({ id }) => id === first.id ? firstResult.promise : secondResult.promise);
  const firstAnchor = addRegionAnchor(primaryDom.window.document, container, first);
  const secondAnchor = addRegionAnchor(primaryDom.window.document, container, second);
  const child = new RegionLinkRenderChild(container, service);
  child.load();

  try {
    firstAnchor.dispatchEvent(mouse(primaryDom, "mouseover", container, true));
    secondAnchor.dispatchEvent(mouse(primaryDom, "mouseover", firstAnchor, true));
    assert.deepEqual(service.previewCalls, [first.id, second.id]);
    assert.equal(runtime.hoverPopovers[0]?.state, "hidden");

    firstResult.resolve(descriptor(first.id));
    secondResult.resolve(descriptor(second.id));
    await settle();
    runtime.showPendingHoverPopovers();

    const firstPopover = runtime.hoverPopovers[0];
    const secondPopover = runtime.hoverPopovers[1];
    assert.ok(firstPopover && secondPopover);
    assert.equal(firstPopover.state, "hidden");
    assert.equal(firstPopover.hoverEl.classList.contains("has-preview"), false);
    assert.equal(secondPopover.state, "shown");
    assert.equal(secondPopover.hoverEl.querySelector("img")?.getAttribute("src"), descriptor(second.id).url);
  } finally {
    child.unload();
  }
});

test("missing, failed, and unloaded pending hovers are safe and explicit", async () => {
  const container = primaryDom.window.document.createElement("main");
  primaryDom.window.document.body.append(container);
  const missing = region({ id: "nr-hover-missing" });
  const failed = region({ id: "nr-hover-failed" });
  const pending = region({ id: "nr-hover-pending" });
  const never = deferred<PreviewDescriptor | null>();
  const service = serviceWith(({ id }) => {
    if (id === missing.id) return Promise.resolve(null);
    if (id === failed.id) return Promise.reject(new Error("cache read failed"));
    return never.promise;
  });
  const missingAnchor = addRegionAnchor(primaryDom.window.document, container, missing);
  const failedAnchor = addRegionAnchor(primaryDom.window.document, container, failed);
  const pendingAnchor = addRegionAnchor(primaryDom.window.document, container, pending);
  const child = new RegionLinkRenderChild(container, service);
  child.load();

  missingAnchor.dispatchEvent(mouse(primaryDom, "mouseover", container, true));
  await settle();
  assert.match(runtime.hoverPopovers[0]?.hoverEl.textContent ?? "", /No saved preview yet/);

  failedAnchor.dispatchEvent(mouse(primaryDom, "mouseover", missingAnchor, true));
  await settle();
  assert.match(runtime.hoverPopovers[1]?.hoverEl.textContent ?? "", /could not be read/);

  pendingAnchor.dispatchEvent(mouse(primaryDom, "mouseover", failedAnchor, true));
  const pendingPopover = runtime.hoverPopovers[2];
  assert.ok(pendingPopover);
  child.unload();
  assert.equal(pendingPopover.state, "hidden");
  never.resolve(descriptor(pending.id));
  await settle();
  assert.equal(pendingPopover.hoverEl.classList.contains("has-preview"), false);
});

test("Reading View hover uses the pop-out document realm", async () => {
  const popout = new JSDOM("<!doctype html><main></main>", { pretendToBeVisual: true });
  installObsidianWindowHelpers(popout);
  const container = popout.window.document.querySelector("main");
  assert.ok(container);
  const value = region({ id: "nr-popout-hover" });
  const anchor = addRegionAnchor(popout.window.document, container, value);
  const child = new RegionLinkRenderChild(
    container,
    serviceWith(async ({ id }) => descriptor(id))
  );
  child.load();

  try {
    anchor.dispatchEvent(mouse(popout, "mouseover", container));
    await settle();
    assert.equal(runtime.hoverPopovers.length, 0);

    popout.window.dispatchEvent(control(popout, "keydown"));
    await settle();
    runtime.showPendingHoverPopovers();
    const popover = runtime.hoverPopovers[0];
    assert.ok(popover);
    assert.equal(popover.targetEl.ownerDocument, popout.window.document);
    assert.equal(popover.hoverEl.ownerDocument, popout.window.document);
    assert.equal(popover.hoverEl.querySelector("img")?.ownerDocument, popout.window.document);
    assert.equal(primaryDom.window.document.contains(popover.hoverEl), false);

    popout.window.dispatchEvent(control(popout, "keyup"));
    assert.equal(popover.state, "hidden");
  } finally {
    child.unload();
    popout.window.close();
  }
});

test("Live Preview rendered anchors require Ctrl, support stationary activation, and retain strict click opening", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const host = primaryDom.window.document.createElement("main");
  primaryDom.window.document.body.append(host);
  const value = region({ id: "nr-live-anchor" });
  const service = serviceWith(async ({ id }) => descriptor(id));
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: "Rendered link fixture",
      extensions: [livePreviewRegionLinksExtension(service)]
    })
  });
  const line = view.contentDOM.querySelector(".cm-line");
  assert.ok(line);
  const anchor = addRegionAnchor(primaryDom.window.document, line, value);
  // CodeMirror repairs foreign children asynchronously. Keep this synthetic
  // rendered-anchor target eligible while its delegated events are exercised.
  Object.defineProperty(anchor, "isConnected", {
    configurable: true,
    get: () => true
  });

  try {
    anchor.querySelector("span")?.dispatchEvent(mouse(primaryDom, "mousemove"));
    await settle();
    assert.deepEqual(service.previewCalls, []);
    assert.equal(runtime.hoverPopovers.length, 0);

    primaryDom.window.dispatchEvent(control(primaryDom, "keydown"));
    await settle();
    assert.deepEqual(service.previewCalls, [value.id]);
    const popover = runtime.hoverPopovers[0];
    assert.ok(popover);
    assert.equal(popover.hoverEl.querySelector("img")?.alt, `${value.title}, page ${value.page}`);
    runtime.showPendingHoverPopovers();
    assert.equal(popover.state, "shown");

    primaryDom.window.dispatchEvent(control(primaryDom, "keyup"));
    assert.equal(popover.state, "hidden");

    const clickAnchor = addRegionAnchor(primaryDom.window.document, line, value);
    const click = mouse(primaryDom, "click");
    clickAnchor.dispatchEvent(click);
    await settle();
    assert.equal(click.defaultPrevented, true);
    assert.deepEqual(service.openCalls, [value.id]);
    assert.equal(popover.state, "hidden");
  } finally {
    view.destroy();
  }
});

test("Live Preview and Source syntax hover uses half-open offsets without consuming syntax clicks", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const host = primaryDom.window.document.createElement("main");
  primaryDom.window.document.body.append(host);
  const value = region({ id: "nr-source-hover" });
  const sourceLink = markdownRegionLink("Source hover", value);
  const ordinaryLink = "[ordinary](https://example.com)";
  const documentText = `before ${sourceLink} middle ${ordinaryLink} after`;
  const from = documentText.indexOf(sourceLink);
  const to = from + sourceLink.length;
  const ordinaryFrom = documentText.indexOf(ordinaryLink);
  const service = serviceWith(async ({ id }) => descriptor(id));
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: documentText,
      extensions: [livePreviewRegionLinksExtension(service)]
    })
  });
  let pointerOffset = from - 1;
  Object.defineProperty(view, "posAtCoords", {
    configurable: true,
    value: () => pointerOffset
  });
  const line = view.contentDOM.querySelector(".cm-line");
  assert.ok(line);

  try {
    line.dispatchEvent(mouse(primaryDom, "mousemove"));
    assert.equal(runtime.hoverPopovers.length, 0, "the byte before the link is outside");

    pointerOffset = from;
    line.dispatchEvent(mouse(primaryDom, "mousemove"));
    await settle();
    assert.equal(runtime.hoverPopovers.length, 0, "source syntax does not hover without Ctrl");

    primaryDom.window.dispatchEvent(control(primaryDom, "keydown"));
    await settle();
    assert.equal(runtime.hoverPopovers.length, 1);
    runtime.showPendingHoverPopovers();
    assert.equal(runtime.hoverPopovers[0]?.state, "shown");

    const syntaxClick = mouse(primaryDom, "click");
    line.dispatchEvent(syntaxClick);
    await settle();
    assert.equal(syntaxClick.defaultPrevented, false);
    assert.deepEqual(service.openCalls, []);

    pointerOffset = to;
    line.dispatchEvent(mouse(primaryDom, "mousemove", null, true));
    runtime.hoverPopovers[0]?.hoverEl.dispatchEvent(mouse(primaryDom, "mouseover", line, true));
    await new Promise((resolve) => primaryDom.window.setTimeout(resolve, 320));
    assert.equal(
      runtime.hoverPopovers[0]?.state,
      "shown",
      "crossing non-link editor space into the popover cancels fallback dismissal"
    );

    runtime.hoverPopovers[0]?.hoverEl.dispatchEvent(mouse(primaryDom, "mouseout", line, true));
    line.dispatchEvent(mouse(primaryDom, "mousemove", null, true));
    await new Promise((resolve) => primaryDom.window.setTimeout(resolve, 320));
    assert.equal(runtime.hoverPopovers[0]?.state, "hidden", "the half-open end is outside");

    pointerOffset = to - 1;
    line.dispatchEvent(mouse(primaryDom, "mousemove", null, true));
    await settle();
    assert.equal(runtime.hoverPopovers.length, 2, "the final link byte remains inside");

    pointerOffset = ordinaryFrom + 2;
    line.dispatchEvent(mouse(primaryDom, "mousemove", null, true));
    await new Promise((resolve) => primaryDom.window.setTimeout(resolve, 320));
    assert.equal(runtime.hoverPopovers[1]?.state, "hidden");
    assert.deepEqual(service.previewCalls, [value.id, value.id]);
    assert.deepEqual(service.openCalls, []);
    assert.deepEqual(service.refreshCalls, []);
  } finally {
    view.destroy();
  }
});
