import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("every raster capture hides, verifies, and restores Notability chrome", async () => {
  const source = await readFile(new URL("../src/capture-view.ts", import.meta.url), "utf8");
  assert.match(source, /captureChromeToken = `nlr-ui-/);
  assert.match(source, /await hideNotabilityCaptureChrome\(webview, captureChromeToken\)/);
  assert.match(
    source,
    /hideNotabilityCaptureChrome\(webview, captureChromeToken\)[\s\S]*?webview\.setZoomFactor\(zoomPlan\.zoomFactor\)/,
    "chrome must be hidden before sharp-capture zoom and raster work"
  );
  assert.match(
    source,
    /assertNotabilityCaptureChromeHidden\(webview, captureChromeToken\);\s*const image = await webview\.capturePage\(crop\);\s*await assertNotabilityCaptureChromeHidden\(webview, captureChromeToken\)/,
    "area capture must verify suppression on both sides of capturePage"
  );
  assert.match(
    source,
    /captureWholePageAtZoom\([\s\S]*?captureChromeToken[\s\S]*?assertNotabilityCaptureChromeHidden\(webview, captureChromeToken\)[\s\S]*?webview\.capturePage\(crop\)[\s\S]*?assertNotabilityCaptureChromeHidden\(webview, captureChromeToken\)/,
    "every whole-page sample must verify suppression on both sides of capturePage"
  );
  assert.match(
    source,
    /await restoreNotabilityCaptureChrome\(webview, captureChromeToken\)[\s\S]*?captureResultAfterRestoration/,
    "Notability chrome must be restored before persistence is allowed"
  );
});
