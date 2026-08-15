import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  inspectNotabilityTextSelection,
  NotabilityTextSelectionError,
  type NotabilityTextSelectionErrorCode
} from "../src/notability-adapter";
import type { ElectronWebviewElement } from "../src/webview-types";

type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  x: number;
  y: number;
  width: number;
  height: number;
  toJSON(): object;
};

function rect(left: number, top: number, width: number, height: number): Rect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    width,
    height,
    toJSON: () => ({ left, top, width, height })
  };
}

function viewFor(dom: JSDOM): ElectronWebviewElement {
  return {
    executeJavaScript: async (script: string) => dom.window.eval(script)
  } as ElectronWebviewElement;
}

function selectionDom(): {
  dom: JSDOM;
  pages: HTMLElement[];
  layers: HTMLElement[];
  texts: Text[];
  nativeText: Text;
} {
  const dom = new JSDOM(`<!doctype html>
    <title>Mixed note - Notability</title>
    <main id="note-view-container" aria-labelledby="note-title">
      <h1 id="note-title">Mixed PDF note</h1>
      <div id="page-layout" style="position:absolute;top:0;width:100%;z-index:-2">
        <div class="logical-page" style="width:500px;height:700px;overflow:hidden">
          <section class="page" data-page-number="1">
            <canvas></canvas>
            <div class="textLayer"><span>first page PDF text</span></div>
          </section>
          <p id="native-note-text">native Notability text</p>
        </div>
        <div class="logical-page" style="width:500px;height:700px;overflow:hidden">
          <section class="page" data-page-number="1">
            <canvas></canvas>
            <div class="textLayer"><span>second   page\nPDF text</span></div>
          </section>
        </div>
      </div>
    </main>`, { runScripts: "outside-only" });
  const main = dom.window.document.querySelector<HTMLElement>("main")!;
  const pages = [...dom.window.document.querySelectorAll<HTMLElement>(".logical-page")];
  const layers = [...dom.window.document.querySelectorAll<HTMLElement>(".textLayer")];
  const texts = layers.map((layer) => layer.querySelector("span")!.firstChild as Text);
  const nativeText = dom.window.document.querySelector("#native-note-text")!.firstChild as Text;
  main.getBoundingClientRect = () => rect(0, 0, 1000, 1700) as DOMRect;
  pages[0]!.getBoundingClientRect = () => rect(100, 50, 500, 700) as DOMRect;
  pages[1]!.getBoundingClientRect = () => rect(100, 850, 500, 700) as DOMRect;
  layers[0]!.getBoundingClientRect = () => rect(110, 60, 480, 680) as DOMRect;
  layers[1]!.getBoundingClientRect = () => rect(110, 860, 480, 680) as DOMRect;
  return { dom, pages, layers, texts, nativeText };
}

function select(
  dom: JSDOM,
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
  clientRects: Rect[] | (() => Rect[])
): void {
  const range = dom.window.document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  Object.defineProperty(range, "getClientRects", {
    value: typeof clientRects === "function" ? clientRects : () => clientRects
  });
  const selection = dom.window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

async function assertSelectionCode(
  promise: Promise<unknown>,
  code: NotabilityTextSelectionErrorCode
): Promise<NotabilityTextSelectionError> {
  let captured: unknown;
  try {
    await promise;
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof NotabilityTextSelectionError);
  assert.equal(captured.code, code);
  return captured;
}

test("explicit text inspection maps a multiline PDF.js range to one logical page", async () => {
  const { dom, texts } = selectionDom();
  const text = texts[1]!;
  select(dom, text, 0, text, text.data.length, [rect(150, 900, 200, 20), rect(150, 930, 300, 20)]);

  const result = await inspectNotabilityTextSelection(viewFor(dom));

  assert.equal(result.title, "Mixed PDF note");
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.pageRect, { x: 100, y: 850, width: 500, height: 700 });
  assert.equal(result.pageAspect, 5 / 7);
  assert.deepEqual(result.rect, {
    x: 0.1,
    y: 50 / 700,
    width: 0.6,
    height: 50 / 700
  });
  assert.equal(result.text, "second page PDF text");
});

test("zero-area line-break fragments are ignored while benign subpixel geometry churn remains valid", async () => {
  const { dom, pages, layers, texts } = selectionDom();
  let pageReads = 0;
  pages[1]!.getBoundingClientRect = () => {
    pageReads += 1;
    return (pageReads === 1
      ? rect(100, 850, 500, 700)
      : rect(100.4, 850.3, 500, 700)) as DOMRect;
  };
  let layerReads = 0;
  layers[1]!.getBoundingClientRect = () => {
    layerReads += 1;
    return (layerReads === 1
      ? rect(110, 860, 480, 680)
      : rect(110.4, 860.3, 480, 680)) as DOMRect;
  };
  let rangeReads = 0;
  const text = texts[1]!;
  select(dom, text, 0, text, 6, () => {
    rangeReads += 1;
    const dx = rangeReads === 1 ? 0 : 0.4;
    const dy = rangeReads === 1 ? 0 : 0.3;
    return [
      rect(150 + dx, 900 + dy, 0, 18),
      rect(150 + dx, 900 + dy, 100, 18)
    ];
  });

  const result = await inspectNotabilityTextSelection(viewFor(dom));

  assert.equal(result.page, 2);
  assert.equal(result.text, "second");
  assert.equal(rangeReads, 2);
  assert.deepEqual(result.pageRect, { x: 100.4, y: 850.3, width: 500, height: 700 });
  assert.ok(Math.abs(result.rect.x - 0.1) < 1e-9);
  assert.ok(Math.abs(result.rect.y - 50 / 700) < 1e-9);
});

test("a selection made only of zero-area fragments is rejected", async () => {
  const { dom, texts } = selectionDom();
  select(dom, texts[0]!, 0, texts[0]!, 5, [
    rect(150, 100, 0, 18),
    rect(150, 120, 20, 0)
  ]);

  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(dom)), "stale-selection");
});

test("selected rect ownership does not require the whole transformed text layer to fit the page", async () => {
  const { dom, layers, texts } = selectionDom();
  layers[0]!.getBoundingClientRect = () => rect(80, 40, 540, 720) as DOMRect;
  select(dom, texts[0]!, 0, texts[0]!, 5, [rect(150, 100, 100, 18)]);

  const result = await inspectNotabilityTextSelection(viewFor(dom));

  assert.equal(result.page, 1);
  assert.equal(result.text, "first");
});

test("real selection and page changes during inspection still fail closed", async () => {
  const changedSelection = selectionDom();
  select(
    changedSelection.dom,
    changedSelection.texts[0]!,
    0,
    changedSelection.texts[0]!,
    5,
    [rect(150, 100, 100, 18)]
  );
  const originalGetSelection = changedSelection.dom.window.document.getSelection.bind(changedSelection.dom.window.document);
  const replacementRange = changedSelection.dom.window.document.createRange();
  replacementRange.setStart(changedSelection.texts[1]!, 0);
  replacementRange.setEnd(changedSelection.texts[1]!, 6);
  Object.defineProperty(replacementRange, "getClientRects", { value: () => [rect(150, 900, 100, 18)] });
  let selectionReads = 0;
  Object.defineProperty(changedSelection.dom.window.document, "getSelection", {
    configurable: true,
    value: () => {
      const selection = originalGetSelection();
      selectionReads += 1;
      if (selectionReads === 2) {
        selection?.removeAllRanges();
        selection?.addRange(replacementRange);
      }
      return selection;
    }
  });
  await assertSelectionCode(
    inspectNotabilityTextSelection(viewFor(changedSelection.dom)),
    "stale-selection"
  );

  const changedPage = selectionDom();
  let rangeReads = 0;
  select(changedPage.dom, changedPage.texts[0]!, 0, changedPage.texts[0]!, 5, () => {
    rangeReads += 1;
    if (rangeReads === 1) {
      changedPage.pages[0]!.replaceWith(changedPage.pages[0]!.cloneNode(true));
    }
    return [rect(150, 100, 100, 18)];
  });
  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(changedPage.dom)), "stale-selection");
});

test("duplicate PDF asset page numbers never override logical page order", async () => {
  const { dom, texts } = selectionDom();
  const text = texts[1]!;
  select(dom, text, 0, text, 6, [rect(200, 1000, 100, 18)]);

  const result = await inspectNotabilityTextSelection(viewFor(dom));

  assert.equal(result.page, 2);
  assert.equal(dom.window.document.querySelectorAll('[data-page-number="1"]').length, 2);
});

test("selection inspection is an explicit API and validates its response", async () => {
  const scripts: string[] = [];
  const response = {
    ok: true,
    title: "PDF",
    page: 1,
    pageCount: 3,
    pageRect: { x: 10, y: 20, width: 500, height: 700 },
    pageAspect: 5 / 7,
    rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
    text: "  Cafe\u0301\n voltage  "
  };
  const webview = {
    executeJavaScript: async (script: string) => {
      scripts.push(script);
      return response;
    }
  } as ElectronWebviewElement;

  const result = await inspectNotabilityTextSelection(webview);

  assert.equal(result.text, "Café voltage");
  assert.match(scripts[0]!, /document\.getSelection\(\)/);
  assert.doesNotMatch(scripts[0]!, /querySelector[^;\n]*data-page-number|getAttribute\(['"]data-page-number/);
  await assertSelectionCode(inspectNotabilityTextSelection({
    executeJavaScript: async () => ({ ...response, rect: { x: 0.9, y: 0, width: 0.2, height: 0.1 } })
  } as unknown as ElectronWebviewElement), "invalid-response");
});

test("collapsed and whitespace-only selections fail closed", async () => {
  const collapsed = selectionDom();
  select(collapsed.dom, collapsed.texts[0]!, 2, collapsed.texts[0]!, 2, []);
  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(collapsed.dom)), "no-selection");

  const whitespace = selectionDom();
  whitespace.texts[0]!.data = " \n\t ";
  select(whitespace.dom, whitespace.texts[0]!, 0, whitespace.texts[0]!, whitespace.texts[0]!.data.length, [rect(150, 100, 30, 18)]);
  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(whitespace.dom)), "whitespace-selection");
});

test("native Notability text and scan-like pages signal Area fallback", async () => {
  const native = selectionDom();
  select(native.dom, native.nativeText, 0, native.nativeText, 6, [rect(150, 200, 80, 18)]);
  const error = await assertSelectionCode(
    inspectNotabilityTextSelection(viewFor(native.dom)),
    "text-layer-unavailable"
  );
  assert.match(error.message, /Area selection/);

  const scan = selectionDom();
  scan.layers[0]!.replaceChildren();
  const orphanText = scan.dom.window.document.createTextNode("scan overlay");
  scan.layers[0]!.append(orphanText);
  select(scan.dom, orphanText, 0, orphanText, orphanText.data.length, [rect(150, 200, 80, 18)]);
  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(scan.dom)), "text-layer-unavailable");
});

test("non-PDF overlay text inside a populated text layer is rejected", async () => {
  const { dom, layers } = selectionDom();
  const overlay = dom.window.document.createElement("div");
  overlay.textContent = "native overlay text";
  layers[0]!.append(overlay);
  const overlayText = overlay.firstChild as Text;
  select(dom, overlayText, 0, overlayText, overlayText.data.length, [rect(150, 100, 160, 18)]);
  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(dom)), "text-layer-unavailable");
});

test("ranges spanning two PDF text layers are rejected as cross-page", async () => {
  const { dom, texts } = selectionDom();
  select(dom, texts[0]!, 0, texts[1]!, 6, [rect(150, 100, 100, 18), rect(150, 900, 100, 18)]);

  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(dom)), "cross-page-selection");
});

test("spatial ownership rejects overlapping and out-of-page mappings", async () => {
  const ambiguous = selectionDom();
  ambiguous.pages[1]!.getBoundingClientRect = () => rect(100, 50, 500, 700) as DOMRect;
  ambiguous.layers[0]!.getBoundingClientRect = () => rect(110, 60, 480, 680) as DOMRect;
  select(ambiguous.dom, ambiguous.texts[0]!, 0, ambiguous.texts[0]!, 5, [rect(150, 100, 100, 18)]);
  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(ambiguous.dom)), "ambiguous-page");

  const outside = selectionDom();
  outside.layers[0]!.getBoundingClientRect = () => rect(700, 50, 250, 300) as DOMRect;
  select(outside.dom, outside.texts[0]!, 0, outside.texts[0]!, 5, [rect(720, 100, 100, 18)]);
  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(outside.dom)), "unmappable-selection");
});

test("non-live or non-rendered PDF text layers are rejected", async () => {
  const hidden = selectionDom();
  hidden.layers[0]!.style.display = "none";
  select(hidden.dom, hidden.texts[0]!, 0, hidden.texts[0]!, 5, [rect(150, 100, 100, 18)]);
  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(hidden.dom)), "text-layer-unavailable");

  const stale = selectionDom();
  stale.layers[0]!.getBoundingClientRect = () => rect(0, 0, 0, 0) as DOMRect;
  select(stale.dom, stale.texts[0]!, 0, stale.texts[0]!, 5, [rect(150, 100, 100, 18)]);
  await assertSelectionCode(inspectNotabilityTextSelection(viewFor(stale.dom)), "stale-selection");
});

test("adapter failure payloads preserve stable codes without retaining text", async () => {
  const error = await assertSelectionCode(inspectNotabilityTextSelection({
    executeJavaScript: async () => ({
      ok: false,
      code: "text-layer-unavailable",
      reason: "selected raw secret must not appear in the thrown error",
      text: "must not appear in the thrown error"
    })
  } as unknown as ElectronWebviewElement), "text-layer-unavailable");
  assert.doesNotMatch(error.message, /must not appear/);
  assert.doesNotMatch(error.message, /selected raw secret/);

  await assertSelectionCode(inspectNotabilityTextSelection({
    executeJavaScript: async () => ({ ok: false, code: "invented-code", reason: "untrusted failure" })
  } as unknown as ElectronWebviewElement), "invalid-response");

  const executionError = await assertSelectionCode(inspectNotabilityTextSelection({
    executeJavaScript: async () => { throw new Error("raw renderer failure"); }
  } as unknown as ElectronWebviewElement), "invalid-response");
  assert.doesNotMatch(executionError.message, /raw renderer failure/);
});
