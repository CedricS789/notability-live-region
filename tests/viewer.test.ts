import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTABILITY_VIEWER_PARTITION,
  isNotabilityViewerPartition,
  prepareNotabilityWebview,
  resolveNotabilityViewerPartition
} from "../src/viewer";
import type { ElectronWebviewElement } from "../src/webview-types";

test("Notability viewer reuses a valid Obsidian partition with a dedicated fallback", () => {
  assert.equal(isNotabilityViewerPartition(NOTABILITY_VIEWER_PARTITION), true);
  assert.equal(isNotabilityViewerPartition("persist:vault-school"), true);
  assert.equal(isNotabilityViewerPartition("persist:unrelated"), false);
  assert.equal(resolveNotabilityViewerPartition({ getWebviewPartition: () => "persist:vault-school" }), "persist:vault-school");
  assert.equal(resolveNotabilityViewerPartition({ getWebviewPartition: () => "unsafe/value" }), NOTABILITY_VIEWER_PARTITION);
});

test("viewer preparation removes privileged preload flags and keeps normal Notability navigation", () => {
  const attributes = new Map<string, string>([["preload", "file:///danger.js"], ["disablewebsecurity", ""]]);
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  let removed = false;
  const webview = {
    src: "about:blank",
    partition: "persist:shared",
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    removeAttribute(name: string) { attributes.delete(name); },
    addEventListener(name: string, listener: EventListenerOrEventListenerObject) { listeners.set(name, listener); },
    removeEventListener(name: string) { listeners.delete(name); },
    remove: () => { removed = true; }
  } as unknown as ElectronWebviewElement;

  const handle = prepareNotabilityWebview(webview, "persist:vault-test");
  assert.equal(webview.src, "about:blank");
  assert.equal(webview.partition, "persist:vault-test");
  assert.equal(attributes.has("allowpopups"), true);
  assert.equal(attributes.has("preload"), false);
  assert.equal(attributes.has("disablewebsecurity"), false);
  assert.match(attributes.get("webpreferences") ?? "", /nodeIntegration=no/);
  assert.equal(listeners.size, 0, "v1 does not pretend renderer webview events can cancel navigation");
  handle.dispose();
  assert.equal(removed, true);
});
