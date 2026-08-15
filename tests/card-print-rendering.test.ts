import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, beforeEach } from "node:test";
import { JSDOM } from "jsdom";
import type { MarkdownPostProcessorContext } from "obsidian";
import type { PreviewDescriptor } from "../src/cache";
import type { NotabilityRegionV1 } from "../src/model";
import type { RegionService } from "../src/service-types";
import { region } from "./fixtures";

type ElementOptions = {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
};

function installObsidianDomHelpers(dom: JSDOM): () => void {
  const prototype = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const methodNames = ["empty", "createDiv", "createSpan", "createEl", "addClass", "removeClass", "setText"];
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of methodNames) previous.set(name, Object.getOwnPropertyDescriptor(prototype, name));

  const applyOptions = (element: HTMLElement, options: ElementOptions = {}): void => {
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
  };
  const define = (name: string, value: (...args: never[]) => unknown): void => {
    Object.defineProperty(prototype, name, { configurable: true, writable: true, value });
  };

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

  define("empty", function empty(this: HTMLElement) {
    this.replaceChildren();
  });
  define("createDiv", function createDiv(this: HTMLElement, options?: ElementOptions) {
    const element = this.ownerDocument.createElement("div");
    applyOptions(element, options);
    this.append(element);
    return element;
  });
  define("createSpan", function createSpan(this: HTMLElement, options?: ElementOptions) {
    const element = this.ownerDocument.createElement("span");
    applyOptions(element, options);
    this.append(element);
    return element;
  });
  define("createEl", function createEl(this: HTMLElement, tag: string, options?: ElementOptions) {
    const element = this.ownerDocument.createElement(tag);
    applyOptions(element, options);
    this.append(element);
    return element;
  });
  define("addClass", function addClass(this: HTMLElement, className: string) {
    this.classList.add(className);
  });
  define("removeClass", function removeClass(this: HTMLElement, className: string) {
    this.classList.remove(className);
  });
  define("setText", function setText(this: HTMLElement, text: string) {
    this.textContent = text;
  });

  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else Reflect.deleteProperty(prototype, name);
    }
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

function descriptor(regionId: string): PreviewDescriptor {
  return {
    regionId,
    url: `app://notability-live-region/${regionId}.png`,
    canonicalRegionHash: `sha256:${"a".repeat(64)}`,
    bytes: 2048,
    captureVersion: 4,
    cssWidth: 320,
    cssHeight: 160,
    pixelWidth: 640,
    pixelHeight: 320,
    chosenScale: 2,
    availableScales: [1, 2],
    capturedAt: "2026-08-14T10:00:00.000Z",
    lastAccessedAt: "2026-08-14T10:00:00.000Z"
  };
}

function serviceWith(
  preview: (value: NotabilityRegionV1) => Promise<PreviewDescriptor | null>
): RegionService {
  return {
    preview,
    async openRegion() {},
    async refreshRegion() {},
    subscribeCacheUpdates() {
      return () => {};
    }
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
const restoreDomHelpers = installObsidianDomHelpers(dom);
const obsidianRuntimeUrl = new URL("./obsidian-card-runtime.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "obsidian") return { url: obsidianRuntimeUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});

const runtime = await import("./obsidian-card-runtime.mjs");
const { mountRegionCard, readingViewRegionProcessor } = await import("../src/card");

beforeEach(() => {
  runtime.resetCardRuntime();
  dom.window.document.body.replaceChildren();
  Reflect.deleteProperty(dom.window.HTMLImageElement.prototype, "decode");
});

after(() => {
  restoreDomHelpers();
  dom.window.close();
});

function processorContext(): MarkdownPostProcessorContext {
  return {
    addChild() {},
    docId: "test",
    frontmatter: null,
    sourcePath: "test.md",
    getSectionInfo: () => null
  } as unknown as MarkdownPostProcessorContext;
}

test("Reading View processor returns and awaits eager image readiness", async () => {
  const value = region();
  const decode = deferred<void>();
  Object.defineProperty(dom.window.HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => decode.promise
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);

  const completion = readingViewRegionProcessor(serviceWith(async () => descriptor(value.id)))(
    JSON.stringify(value),
    container,
    processorContext()
  );
  let completed = false;
  void completion.then(() => {
    completed = true;
  });
  await settle();

  const image = container.querySelector("img");
  assert.ok(image);
  assert.equal(image.loading, "eager");
  assert.equal(completed, false);

  decode.resolve();
  await completion;
  assert.equal(completed, true);
  assert.ok(container.querySelector("img"));
});

test("Reading View processor renders a printable message for a missing preview", async () => {
  const value = region();
  const container = dom.window.document.createElement("div");
  await readingViewRegionProcessor(serviceWith(async () => null))(
    JSON.stringify(value),
    container,
    processorContext()
  );

  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent ?? "", /No saved preview/);
});

test("Reading View processor replaces a corrupt cache image with a printable message", async () => {
  const value = region();
  Object.defineProperty(dom.window.HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => Promise.reject(new Error("corrupt PNG"))
  });
  const container = dom.window.document.createElement("div");
  const completion = readingViewRegionProcessor(serviceWith(async () => descriptor(value.id)))(
    JSON.stringify(value),
    container,
    processorContext()
  );
  await settle();
  container.querySelector("img")?.dispatchEvent(new dom.window.Event("error"));
  await completion;

  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent ?? "", /saved preview could not be read/);
});

test("Reading View waits for a newer cache render that supersedes its initial lookup", async () => {
  const value = region();
  const first = deferred<PreviewDescriptor | null>();
  const second = deferred<PreviewDescriptor | null>();
  let calls = 0;
  let cacheListener: ((regionId: string) => void) | null = null;
  Object.defineProperty(dom.window.HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => Promise.resolve()
  });
  const service: RegionService = {
    preview: async () => (++calls === 1 ? first.promise : second.promise),
    async openRegion() {},
    async refreshRegion() {},
    subscribeCacheUpdates(listener) {
      cacheListener = listener;
      return () => {};
    }
  };
  const container = dom.window.document.createElement("div");
  const completion = readingViewRegionProcessor(service)(JSON.stringify(value), container, processorContext());
  let completed = false;
  void completion.then(() => { completed = true; });

  assert.ok(cacheListener);
  (cacheListener as (regionId: string) => void)(value.id);
  first.resolve(descriptor(value.id));
  await settle();
  assert.equal(completed, false);

  second.resolve(descriptor(value.id));
  await completion;
  assert.equal(completed, true);
  assert.equal(container.querySelector("img")?.loading, "eager");
});

test("interactive card mounts remain lazy by default", async () => {
  const value = region();
  Object.defineProperty(dom.window.HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => Promise.resolve()
  });
  const container = dom.window.document.createElement("div");
  const mount = mountRegionCard(container, value, serviceWith(async () => descriptor(value.id)));
  await mount.ready;
  assert.equal(container.querySelector("img")?.loading, "lazy");
  mount.dispose();
});
