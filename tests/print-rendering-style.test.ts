import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const printStyles = styles.match(/@media print\s*\{([\s\S]*)\}\s*$/)?.[1] ?? "";

test("print cards hide controls and cache metadata", () => {
  assert.match(
    printStyles,
    /\.notability-live-region-card-controls,\s*\.notability-live-region-preview-meta\s*\{\s*display:\s*none\s*!important;/
  );
});

test("print cards retain image proportions without the screen height cap or clipping", () => {
  const card = printStyles.match(/\.notability-live-region-card\s*\{([^}]*)\}/)?.[1] ?? "";
  const imageBlocks = [...printStyles.matchAll(/\.notability-live-region-card img\s*\{([^}]*)\}/g)];
  const image = imageBlocks.at(-1)?.[1] ?? "";
  assert.match(card, /overflow:\s*visible/);
  assert.match(card, /break-inside:\s*avoid-page/);
  assert.match(image, /width:\s*auto/);
  assert.match(image, /height:\s*auto/);
  assert.match(image, /max-width:\s*100%/);
  assert.match(image, /max-height:\s*none/);
  assert.match(image, /object-fit:\s*contain/);
});
