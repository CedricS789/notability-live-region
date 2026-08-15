import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  assertNotabilityCaptureChromeHidden,
  hideNotabilityCaptureChrome,
  restoreNotabilityCaptureChrome
} from "../src/notability-capture-chrome";
import type { ElectronWebviewElement } from "../src/webview-types";

function fixture() {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <main id="note-view-container"><div id="page-content">Notebook pixels</div></main>
    <div id="navigator" data-testid="page-navigator">1 / 15</div>
    <div id="toolbox" role="toolbar" aria-orientation="horizontal"><button aria-label="Move">Move</button></div>
    <div id="zoom" role="status" class="ZoomToast_container__fixture">125%</div>
    <div id="popover" data-radix-popper-content-wrapper><div role="tooltip">Pen</div></div>
  </body></html>`, { runScripts: "outside-only" });
  const scripts: string[] = [];
  const view = {
    executeJavaScript: async (script: string) => {
      scripts.push(script);
      return dom.window.eval(script);
    }
  } as ElectronWebviewElement;
  return { dom, view, scripts };
}

test("capture chrome suppression hides supplied Notability controls without hiding page content", async () => {
  const { dom, view } = fixture();
  const token = "nlr-ui-12345678";
  await hideNotabilityCaptureChrome(view, token);

  for (const id of ["navigator", "toolbox", "zoom", "popover"]) {
    const element = dom.window.document.getElementById(id)!;
    assert.equal(dom.window.getComputedStyle(element).visibility, "hidden", `${id} remains visible`);
    assert.equal(dom.window.getComputedStyle(element).pointerEvents, "none", `${id} still accepts input`);
  }
  assert.notEqual(
    dom.window.getComputedStyle(dom.window.document.getElementById("page-content")!).visibility,
    "hidden",
    "the note page itself must remain visible"
  );

  const lateToolbar = dom.window.document.createElement("div");
  lateToolbar.id = "late-toolbar";
  lateToolbar.setAttribute("role", "toolbar");
  dom.window.document.body.appendChild(lateToolbar);
  assert.equal(dom.window.getComputedStyle(lateToolbar).visibility, "hidden", "late React chrome must also be suppressed");
  await assertNotabilityCaptureChromeHidden(view, token);

  await restoreNotabilityCaptureChrome(view, token);
  assert.equal(dom.window.document.querySelectorAll("style[data-obsidian-notability-capture-chrome]").length, 0);
  assert.notEqual(dom.window.getComputedStyle(dom.window.document.getElementById("navigator")!).visibility, "hidden");
  assert.notEqual(dom.window.getComputedStyle(lateToolbar).visibility, "hidden");
});

test("capture chrome ownership is exact and fails closed when suppression disappears", async () => {
  const { dom, view, scripts } = fixture();
  const token = "nlr-ui-abcdefgh";
  await hideNotabilityCaptureChrome(view, token);

  await assert.rejects(
    restoreNotabilityCaptureChrome(view, "nlr-ui-other123"),
    /could not be restored safely/
  );
  await assertNotabilityCaptureChromeHidden(view, token);

  dom.window.document.querySelector("style[data-obsidian-notability-capture-chrome]")?.remove();
  await assert.rejects(
    assertNotabilityCaptureChromeHidden(view, token),
    /became visible during capture/
  );

  const invalid = fixture();
  await assert.rejects(hideNotabilityCaptureChrome(invalid.view, "bad"), /token is invalid/);
  assert.equal(invalid.scripts.length, 0, "invalid tokens must not reach the guest document");
  assert.ok(scripts.length >= 4);
});
