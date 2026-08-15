import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { markdownRegionLink } from "../src/url-policy";
import { region } from "./fixtures";

type GlobalKey = keyof typeof globalThis;

function installDom(dom: JSDOM): () => void {
  const keys: GlobalKey[] = [
    "window",
    "document",
    "navigator",
    "MutationObserver",
    "HTMLElement",
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
  define("Node", dom.window.Node);
  define("DOMRect", dom.window.DOMRect);
  define("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  define("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  define("cancelAnimationFrame", (handle: number) => clearTimeout(handle));

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

function pasteEvent(dom: JSDOM, text: string): ClipboardEvent {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: { getData: (format: string) => format === "text/plain" ? text : "" }
  });
  return event as unknown as ClipboardEvent;
}

test("highest-priority Notability paste runs before an earlier default consumer", async () => {
  const dom = new JSDOM("<!doctype html><main id='editor'></main>", { pretendToBeVisual: true });
  const restore = installDom(dom);
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { notabilityRegionPasteExtension } = await import("../src/editor-paste");
  let earlierCalls = 0;
  const earlierConsumer = EditorView.domEventHandlers({
    paste(_event, view): boolean {
      earlierCalls += 1;
      view.dispatch(view.state.replaceSelection("LINTER"));
      return true;
    }
  });
  const document = "prefix target words suffix";
  const from = document.indexOf("target words");
  const view = new EditorView({
    parent: dom.window.document.querySelector("#editor") as HTMLElement,
    state: EditorState.create({
      doc: document,
      selection: { anchor: from, head: from + "target words".length },
      // The competing handler is intentionally registered first.
      extensions: [earlierConsumer, notabilityRegionPasteExtension()]
    })
  });

  try {
    const event = pasteEvent(dom, markdownRegionLink("Fixture label", region()));
    view.contentDOM.dispatchEvent(event);
    assert.equal(earlierCalls, 0);
    assert.equal(event.defaultPrevented, true);
    assert.equal(
      view.state.doc.toString(),
      `prefix ${markdownRegionLink("target words", region())} suffix`
    );
    assert.equal(view.state.selection.main.empty, true);
    assert.equal(view.state.selection.main.head, view.state.doc.length - " suffix".length);
  } finally {
    view.destroy();
    restore();
  }
});

test("unrelated clipboard text falls through to normal CodeMirror paste", async () => {
  const dom = new JSDOM("<!doctype html><main id='editor'></main>", { pretendToBeVisual: true });
  const restore = installDom(dom);
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { buildCodeMirrorRegionPaste, notabilityRegionPasteExtension } = await import("../src/editor-paste");
  let downstreamCalls = 0;
  const downstreamObserver = EditorView.domEventHandlers({
    paste(): boolean {
      downstreamCalls += 1;
      return false;
    }
  });
  const view = new EditorView({
    parent: dom.window.document.querySelector("#editor") as HTMLElement,
    state: EditorState.create({
      doc: "unchanged",
      extensions: [downstreamObserver, notabilityRegionPasteExtension()]
    })
  });

  try {
    const event = pasteEvent(dom, "ordinary clipboard text");
    assert.equal(buildCodeMirrorRegionPaste("unchanged", view.state.selection.ranges, "ordinary clipboard text"), null);
    view.contentDOM.dispatchEvent(event);
    assert.equal(downstreamCalls, 1);
    assert.equal(view.state.doc.toString(), "ordinary clipboard textunchanged");
  } finally {
    view.destroy();
    restore();
  }
});

test("multiple selections paste in one transaction with collapsed cursors and preserved main selection", async () => {
  const dom = new JSDOM("<!doctype html><main id='editor'></main>", { pretendToBeVisual: true });
  const restore = installDom(dom);
  const { EditorSelection, EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { notabilityRegionPasteExtension } = await import("../src/editor-paste");
  const firstLink = markdownRegionLink("one", region());
  const secondLink = markdownRegionLink("three", region());
  const expected = `${firstLink} two ${secondLink}`;
  let documentTransactions = 0;
  const view = new EditorView({
    parent: dom.window.document.querySelector("#editor") as HTMLElement,
    state: EditorState.create({
      doc: "one two three",
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(8, 13)
      ], 1),
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        EditorView.updateListener.of((update) => {
          documentTransactions += update.transactions.filter((transaction) => transaction.docChanged).length;
        }),
        notabilityRegionPasteExtension()
      ]
    })
  });

  try {
    view.contentDOM.dispatchEvent(pasteEvent(dom, markdownRegionLink("Fixture label", region())));
    assert.equal(view.state.doc.toString(), expected);
    assert.equal(documentTransactions, 1);
    assert.equal(view.state.selection.mainIndex, 1);
    assert.deepEqual(
      view.state.selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
      [
        { anchor: firstLink.length, head: firstLink.length },
        { anchor: expected.length, head: expected.length }
      ]
    );
  } finally {
    view.destroy();
    restore();
  }
});

test("a CodeMirror-consumed event cannot run through the workspace fallback again", async () => {
  const dom = new JSDOM("<!doctype html><main id='editor'></main>", { pretendToBeVisual: true });
  const restore = installDom(dom);
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { notabilityRegionPasteExtension, shouldHandleWorkspaceRegionPaste } = await import("../src/editor-paste");
  const handled = new WeakSet<ClipboardEvent>();
  const view = new EditorView({
    parent: dom.window.document.querySelector("#editor") as HTMLElement,
    state: EditorState.create({
      doc: "selected",
      selection: { anchor: 0, head: "selected".length },
      extensions: [notabilityRegionPasteExtension((event) => handled.add(event))]
    })
  });

  try {
    const event = pasteEvent(dom, markdownRegionLink("Fixture label", region()));
    view.contentDOM.dispatchEvent(event);
    assert.equal(handled.has(event), true);
    assert.equal(shouldHandleWorkspaceRegionPaste(event, handled), false);
  } finally {
    view.destroy();
    restore();
  }
});
