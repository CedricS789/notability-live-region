import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  claimNotabilityPageCapture,
  inspectNotabilityPage,
  inspectNotabilityPageAt,
  inspectNotabilityViewport,
  releaseNotabilityPageCapture,
  scrollRegionIntoView,
  scrollToPage
} from "../src/notability-adapter";
import type { ElectronWebviewElement } from "../src/webview-types";

function webview(result: unknown) {
  const scripts: string[] = [];
  return {
    scripts,
    view: { executeJavaScript: async (script: string) => { scripts.push(script); return result; } } as ElectronWebviewElement
  };
}

const snapshot = {
  ok: true,
  title: "CMOS",
  page: 2,
  pageCount: 31,
  pageRect: { x: 20, y: 30, width: 500, height: 700 },
  pageAspect: 5 / 7,
};

test("injected adapter reads logical Notability page frames independently of PDF backgrounds", async () => {
  const dom = new JSDOM(`<!doctype html><title>CMOS - Notability</title><main id="note-view-container" aria-labelledby="note-title"><h1 id="note-title">CMOS native note</h1><div style="position:absolute;top:0;width:100%;z-index:-2"><div class="native-page" style="width:500px;height:700px;overflow:hidden"><svg width="500" height="700"></svg></div><div class="native-page" style="width:500px;height:700px;overflow:hidden"><svg width="500" height="700"></svg></div></div><div data-text-layer-id="pdf-a-1"><span>threshold voltage</span></div></main>`, { runScripts: "outside-only" });
  const main = dom.window.document.querySelector("main")!;
  const pages = [...dom.window.document.querySelectorAll<HTMLElement>(".native-page")];
  Object.defineProperty(dom.window, "innerWidth", { value: 1000 });
  Object.defineProperty(dom.window, "innerHeight", { value: 800 });
  main.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, x: 0, y: 0, width: 1000, height: 800, toJSON() {} });
  pages[0]!.getBoundingClientRect = () => ({ left: 100, top: 50, right: 600, bottom: 750, x: 100, y: 50, width: 500, height: 700, toJSON() {} });
  pages[1]!.getBoundingClientRect = () => ({ left: 100, top: 900, right: 600, bottom: 1600, x: 100, y: 900, width: 500, height: 700, toJSON() {} });
  const view = {
    executeJavaScript: async (script: string) => dom.window.eval(script)
  } as ElectronWebviewElement;

  const page = await inspectNotabilityPage(view);
  assert.equal(page.title, "CMOS native note");
  assert.equal(page.page, 1);
  assert.equal(page.pageCount, 2);
  assert.deepEqual(page.pageRect, { x: 100, y: 50, width: 500, height: 700 });
});

test("logical page order wins over duplicated PDF asset page numbers", async () => {
  const dom = new JSDOM(`<!doctype html><title>Mixed - Notability</title><main id="note-view-container"><div style="position:absolute;top:0;width:100%;z-index:-2"><div class="native-page" style="width:500px;height:700px;overflow:hidden"><div class="page" data-page-number="1"><canvas></canvas></div></div><div class="native-page" style="width:500px;height:700px;overflow:hidden"><div class="page" data-page-number="1"><canvas></canvas></div></div></div></main>`, { runScripts: "outside-only" });
  const main = dom.window.document.querySelector<HTMLElement>("main")!;
  const pages = [...dom.window.document.querySelectorAll<HTMLElement>(".native-page")];
  main.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, x: 0, y: 0, width: 1000, height: 800, toJSON() {} });
  pages[0]!.getBoundingClientRect = () => ({ left: 100, top: -650, right: 600, bottom: 50, x: 100, y: -650, width: 500, height: 700, toJSON() {} });
  pages[1]!.getBoundingClientRect = () => ({ left: 100, top: 50, right: 600, bottom: 750, x: 100, y: 50, width: 500, height: 700, toJSON() {} });
  const view = { executeJavaScript: async (script: string) => dom.window.eval(script) } as ElectronWebviewElement;
  const result = await inspectNotabilityPage(view);
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 2);
});

test("injected adapter falls back to ordered PDF.js canvases when page-number attributes are absent", async () => {
  const dom = new JSDOM(`<!doctype html><title>Fallback - Notability</title><main id="note-view-container"><section class="page"><div class="canvasWrapper"><canvas></canvas></div><div class="textLayer"><span>fallback text</span></div></section></main>`, { runScripts: "outside-only" });
  const main = dom.window.document.querySelector<HTMLElement>("main")!;
  const page = dom.window.document.querySelector<HTMLElement>(".page")!;
  const canvas = dom.window.document.querySelector<HTMLCanvasElement>("canvas")!;
  const mainRect = { left: 0, top: 0, right: 900, bottom: 700, x: 0, y: 0, width: 900, height: 700, toJSON() {} };
  const pageRect = { left: 100, top: 50, right: 600, bottom: 650, x: 100, y: 50, width: 500, height: 600, toJSON() {} };
  main.getBoundingClientRect = () => mainRect;
  page.getBoundingClientRect = () => pageRect;
  canvas.getBoundingClientRect = () => pageRect;
  const view = { executeJavaScript: async (script: string) => dom.window.eval(script) } as ElectronWebviewElement;
  const result = await inspectNotabilityPage(view);
  assert.equal(result.page, 1);
  assert.equal(result.pageCount, 1);
});

test("adapter validates page metadata without exposing selection or text-layer contents", async () => {
  const first = webview(snapshot);
  const inspected = await inspectNotabilityPage(first.view);
  assert.equal(inspected.title, "CMOS");
  assert.equal(inspected.page, 2);
  assert.equal(inspected.pageCount, 31);
  assert.deepEqual(inspected.pageRect, { x: 20, y: 30, width: 500, height: 700 });
  assert.equal(inspected.pageAspect, 5 / 7);
  assert.deepEqual(Object.keys(inspected).sort(), ["page", "pageAspect", "pageCount", "pageRect", "title"]);
  assert.doesNotMatch(first.scripts[0]!, /getSelection|data-text-layer-id|textLayer span|textSpans|selectedText/);
});

test("adapter rejects malformed and unavailable page state", async () => {
  await assert.rejects(inspectNotabilityPage(webview({ ok: false, reason: "missing" }).view), /missing/);
  await assert.rejects(inspectNotabilityPage(webview({ ...snapshot, page: 32, pageCount: 31 }).view), /ordinals/);
  await assert.rejects(inspectNotabilityPage(webview({ ...snapshot, pageRect: { x: 0 } }).view), /geometry/);
});

test("exact inspection selects the requested logical DOM ordinal when several mixed pages are visible", async () => {
  const dom = new JSDOM(`<!doctype html><title>Mixed media - Notability</title><main id="note-view-container"><div style="position:absolute;top:0;width:100%;z-index:-2"><div class="native-page" style="width:500px;height:700px;overflow:hidden"><svg></svg></div><div class="scan-page" style="width:720px;height:480px;overflow:hidden"><img></div><div class="pdf-page" style="width:500px;height:900px;overflow:hidden"><div class="page" data-page-number="1"><canvas></canvas></div></div><div class="pdf-page" style="width:500px;height:700px;overflow:hidden"><div class="page" data-page-number="1"><canvas></canvas></div></div></div></main>`, { runScripts: "outside-only" });
  const main = dom.window.document.querySelector<HTMLElement>("main")!;
  const pages = [...dom.window.document.querySelectorAll<HTMLElement>(".native-page, .scan-page, .pdf-page")];
  main.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, x: 0, y: 0, width: 1000, height: 800, toJSON() {} });
  const rects = [
    { left: 10, top: 0, right: 510, bottom: 700, x: 10, y: 0, width: 500, height: 700, toJSON() {} },
    { left: 10, top: 100, right: 730, bottom: 580, x: 10, y: 100, width: 720, height: 480, toJSON() {} },
    { left: 10, top: 200, right: 510, bottom: 1100, x: 10, y: 200, width: 500, height: 900, toJSON() {} },
    { left: 10, top: 300, right: 510, bottom: 1000, x: 10, y: 300, width: 500, height: 700, toJSON() {} }
  ];
  pages.forEach((page, index) => { page.getBoundingClientRect = () => rects[index]!; });
  const scripts: string[] = [];
  const view = {
    executeJavaScript: async (script: string) => {
      scripts.push(script);
      return dom.window.eval(script);
    }
  } as ElectronWebviewElement;

  const scan = await inspectNotabilityPageAt(view, 2);
  assert.equal(scan.page, 2);
  assert.equal(scan.pageCount, 4);
  assert.deepEqual(scan.pageRect, { x: 10, y: 100, width: 720, height: 480 });
  assert.equal(scan.pageAspect, 1.5);

  const tallPdf = await inspectNotabilityPageAt(view, 3);
  assert.equal(tallPdf.page, 3);
  assert.deepEqual(tallPdf.pageRect, { x: 10, y: 200, width: 500, height: 900 });
  assert.doesNotMatch(scripts.join("\n"), /querySelector[^;\n]*data-page-number|getAttribute\(['"]data-page-number|getSelection|textLayer/);
});

test("exact inspection rejects invalid, missing, and stale logical pages", async () => {
  const invalid = webview(snapshot);
  await assert.rejects(inspectNotabilityPageAt(invalid.view, 0), /ordinal/);
  await assert.rejects(inspectNotabilityPageAt(invalid.view, 1.5), /ordinal/);
  assert.equal(invalid.scripts.length, 0);

  const dom = new JSDOM(`<!doctype html><main id="note-view-container"><div style="position:absolute;top:0;width:100%;z-index:-2"><div class="page-frame" style="width:500px;height:700px;overflow:hidden"></div><div class="page-frame" style="width:500px;height:700px;overflow:hidden"></div></div></main>`, { runScripts: "outside-only" });
  const main = dom.window.document.querySelector<HTMLElement>("main")!;
  const layer = main.firstElementChild!;
  const pages = [...dom.window.document.querySelectorAll<HTMLElement>(".page-frame")];
  const pageRect = { left: 100, top: 50, right: 600, bottom: 750, x: 100, y: 50, width: 500, height: 700, toJSON() {} };
  main.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, x: 0, y: 0, width: 1000, height: 800, toJSON() {} });
  pages[0]!.getBoundingClientRect = () => pageRect;
  pages[1]!.getBoundingClientRect = () => ({ ...pageRect, top: 800, bottom: 1500, y: 800 });
  const view = { executeJavaScript: async (script: string) => dom.window.eval(script) } as ElectronWebviewElement;

  await assert.rejects(inspectNotabilityPageAt(view, 3), /unavailable/);

  let firstPageReads = 0;
  pages[0]!.getBoundingClientRect = () => {
    firstPageReads += 1;
    if (firstPageReads === 2) layer.removeChild(pages[1]!);
    return pageRect;
  };
  await assert.rejects(inspectNotabilityPageAt(view, 2), /stale/);

  const malformed = webview({ ...snapshot, pageRect: { x: 0 } });
  await assert.rejects(inspectNotabilityPageAt(malformed.view, 2), /geometry/);
});

test("capture token keeps one exact logical page frame stable across tile inspections", async () => {
  const dom = new JSDOM(`<!doctype html><main id="note-view-container"><div class="layer" style="position:absolute;top:0;width:100%;z-index:-2"><div class="page-frame" style="width:500px;height:700px;overflow:hidden"></div><div class="page-frame" style="width:500px;height:700px;overflow:hidden"></div></div></main>`, { runScripts: "outside-only" });
  const pages = [...dom.window.document.querySelectorAll<HTMLElement>(".page-frame")];
  const rects = [
    { left: 100, top: 0, right: 600, bottom: 700, x: 100, y: 0, width: 500, height: 700, toJSON() {} },
    { left: 100, top: 720, right: 600, bottom: 1420, x: 100, y: 720, width: 500, height: 700, toJSON() {} }
  ];
  pages.forEach((page, index) => { page.getBoundingClientRect = () => rects[index]!; });
  const view = { executeJavaScript: async (script: string) => dom.window.eval(script) } as ElectronWebviewElement;
  const token = "nlr-capture123";
  assert.equal((await claimNotabilityPageCapture(view, 2, token)).page, 2);
  assert.equal((await inspectNotabilityPageAt(view, 2, token)).page, 2);

  const replacement = pages[1]!.cloneNode(true) as HTMLElement;
  replacement.getBoundingClientRect = () => rects[1]!;
  pages[1]!.replaceWith(replacement);
  await assert.rejects(inspectNotabilityPageAt(view, 2, token), /identity changed/);

  assert.doesNotReject(releaseNotabilityPageCapture(view, 2, token));
  const invalid = webview(snapshot);
  await assert.rejects(claimNotabilityPageCapture(invalid.view, 2, "bad"), /token/);
  assert.equal(invalid.scripts.length, 0);
});

test("navigation helpers validate numeric input before script construction", async () => {
  const invalidPage = webview(true);
  assert.equal(await scrollToPage(invalidPage.view, 0), false);
  assert.equal(invalidPage.scripts.length, 0);
  const validPage = webview(true);
  assert.equal(await scrollToPage(validPage.view, 31), true);
  assert.match(validPage.scripts[0]!, /pages\[30\]/);

  const invalidRegion = webview(true);
  assert.equal(await scrollRegionIntoView(invalidRegion.view, 2, { x: Number.NaN, y: 0, width: 0.1, height: 0.1 }), false);
  assert.equal(invalidRegion.scripts.length, 0);
  const validRegion = webview(true);
  assert.equal(await scrollRegionIntoView(validRegion.view, 2, { x: 0.2, y: 0.3, width: 0.1, height: 0.2 }), true);
  assert.match(validRegion.scripts[0]!, /0\.25000000/);
});

test("capture viewport is the live note root clipped to the guest window", async () => {
  const dom = new JSDOM(`<!doctype html><main id="note-view-container"><div style="position:absolute;top:0;width:100%;z-index:-2"><div class="page-frame" style="width:500px;height:700px;overflow:hidden"></div></div></main>`, { runScripts: "outside-only" });
  const main = dom.window.document.querySelector<HTMLElement>("main")!;
  const page = dom.window.document.querySelector<HTMLElement>(".page-frame")!;
  Object.defineProperty(dom.window, "innerWidth", { value: 800 });
  Object.defineProperty(dom.window, "innerHeight", { value: 600 });
  Object.defineProperties(main, {
    clientLeft: { value: 5 },
    clientTop: { value: 4 },
    clientWidth: { value: 760 },
    clientHeight: { value: 500 }
  });
  main.getBoundingClientRect = () => ({ left: -20, top: 80, right: 900, bottom: 700, x: -20, y: 80, width: 920, height: 620, toJSON() {} });
  page.getBoundingClientRect = () => ({ left: 100, top: 100, right: 600, bottom: 800, x: 100, y: 100, width: 500, height: 700, toJSON() {} });
  const view = { executeJavaScript: async (script: string) => dom.window.eval(script) } as ElectronWebviewElement;
  assert.deepEqual(await inspectNotabilityViewport(view), { x: 0, y: 84, width: 745, height: 500 });

  await assert.rejects(inspectNotabilityViewport(webview({ ok: false, reason: "missing viewport" }).view), /missing viewport/);
  await assert.rejects(inspectNotabilityViewport(webview({ ok: true, rect: { x: 0, y: 0, width: 0, height: 1 } }).view), /empty/);
});
