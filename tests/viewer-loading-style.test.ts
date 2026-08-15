import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("saved loading preview is a click-through overlay inside the viewer stage", () => {
  const block = styles.match(/\.notability-live-region-loading-preview\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(block, /position:\s*absolute/);
  assert.match(block, /z-index:\s*2/);
  assert.match(block, /pointer-events:\s*none/);
});
