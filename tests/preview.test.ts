import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { PreviewDescriptor } from "../src/cache";
import { awaitPreviewImageReady, renderPreview } from "../src/preview";

function installObsidianDocumentHelpers(dom: JSDOM): void {
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
}

test("preview rendering uses intrinsic CSS dimensions and includes the staleness notice", () => {
  const dom = new JSDOM("<main></main>");
  installObsidianDocumentHelpers(dom);
  const container = dom.window.document.querySelector("main");
  assert.ok(container);
  const preview: PreviewDescriptor = {
    regionId: "nr-preview001",
    url: "app://vault/preview.png?v=1",
    canonicalRegionHash: `sha256:${"a".repeat(64)}`,
    bytes: 1024,
    captureVersion: 1,
    cssWidth: 320.5,
    cssHeight: 160.25,
    pixelWidth: 641,
    pixelHeight: 321,
    chosenScale: 2,
    availableScales: [1, 2],
    capturedAt: "2026-08-12T10:00:00.000Z",
    lastAccessedAt: "2026-08-12T10:00:00.000Z"
  };

  const rendered = renderPreview(container, preview, "Signals, page 2");
  assert.equal(rendered.image.style.getPropertyValue("--notability-live-region-preview-width"), "320.5px");
  assert.equal(rendered.image.style.getPropertyValue("--notability-live-region-preview-aspect"), "320.5 / 160.25");
  assert.equal(rendered.image.className, "notability-live-region-preview-image");
  assert.equal(rendered.image.getAttribute("width"), "641");
  assert.equal(rendered.image.getAttribute("height"), "321");
  assert.equal(rendered.image.alt, "Signals, page 2");
  assert.equal(rendered.image.loading, "lazy");
  assert.equal(rendered.metadata.querySelector("time")?.getAttribute("datetime"), preview.capturedAt);
  assert.match(rendered.metadata.textContent ?? "", /Captured .+\. The live note may have changed\./);
});

test("preview rendering does not enlarge a low-density cache image on a high-DPI display", () => {
  const dom = new JSDOM("<main></main>");
  installObsidianDocumentHelpers(dom);
  Object.defineProperty(dom.window, "devicePixelRatio", {
    configurable: true,
    value: 1.5
  });
  const container = dom.window.document.querySelector("main");
  assert.ok(container);
  const preview: PreviewDescriptor = {
    regionId: "nr-low-density",
    url: "app://vault/low-density.png",
    canonicalRegionHash: `sha256:${"b".repeat(64)}`,
    bytes: 1024,
    captureVersion: 3,
    cssWidth: 600,
    cssHeight: 300,
    pixelWidth: 720,
    pixelHeight: 360,
    chosenScale: 1,
    availableScales: [1],
    capturedAt: "2026-08-13T10:00:00.000Z",
    lastAccessedAt: "2026-08-13T10:00:00.000Z"
  };

  const rendered = renderPreview(container, preview, "Low-density preview");
  assert.equal(rendered.image.style.getPropertyValue("--notability-live-region-preview-width"), "480px");
  assert.equal(rendered.image.getAttribute("width"), "720");
  assert.equal(rendered.image.className, "notability-live-region-preview-image");
});

test("preview rendering supports an eager Reading View image without changing the lazy default", () => {
  const dom = new JSDOM("<main></main>");
  installObsidianDocumentHelpers(dom);
  const container = dom.window.document.querySelector("main");
  assert.ok(container);
  const preview: PreviewDescriptor = {
    regionId: "nr-eager-preview",
    url: "app://vault/eager.png",
    canonicalRegionHash: `sha256:${"c".repeat(64)}`,
    bytes: 1024,
    captureVersion: 4,
    cssWidth: 300,
    cssHeight: 150,
    pixelWidth: 600,
    pixelHeight: 300,
    chosenScale: 2,
    availableScales: [2],
    capturedAt: "2026-08-14T10:00:00.000Z",
    lastAccessedAt: "2026-08-14T10:00:00.000Z"
  };

  const rendered = renderPreview(container, preview, "Eager preview", { loading: "eager" });
  assert.equal(rendered.image.loading, "eager");
});

test("image readiness has a bounded timeout when no decode or load signal arrives", async () => {
  const dom = new JSDOM("<main></main>", { pretendToBeVisual: true });
  installObsidianDocumentHelpers(dom);
  const image = dom.window.document.createElement("img");
  image.src = "app://vault/pending.png";
  dom.window.document.querySelector("main")?.append(image);

  assert.equal(await awaitPreviewImageReady(image, 5), "timeout");
  dom.window.close();
});
