import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("viewer exposes a direct whole-page embed action and routes it through tiled capture", async () => {
  const source = await readFile(new URL("../src/capture-view.ts", import.meta.url), "utf8");
  assert.match(source, /text:\s*"Embed page"/);
  assert.match(source, /copyCurrentPageEmbed\(\)/);
  assert.match(source, /kind:\s*"page"/);
  assert.match(source, /rect:\s*\{\s*\.\.\.FULL_PAGE_RECT\s*\}/);
  assert.match(source, /const delivery = this\.prepareEmbedDelivery\("embed"\)[\s\S]*await this\.copySelection\("embed", delivery, cancellationTicket\)/);
  assert.match(source, /const wholePage = isFullPageRect\(regionRect\)/);
  assert.match(source, /captureWholePageAtZoom/);
  assert.match(source, /planWholePageCapture/);
  assert.match(source, /stitchWholePageCapture/);
  assert.match(source, /claimNotabilityPageCapture/);
  assert.match(source, /releaseNotabilityPageCapture/);
  assert.match(source, /captureStableWholePageTile/);
  assert.match(source, /assertWholePageCaptureIdentity/);
  assert.match(source, /assertWholePageCapturePhaseLayout/);
  assert.match(source, /inspectNotabilityPageAt\(webview, expectedPage\)/);
  assert.match(source, /this\.host\.savePreview\(completed\.region, completed\.bytes, completed\.capture\)/);

  const save = source.indexOf("await this.host.savePreview(completed.region, completed.bytes, completed.capture)");
  const unlock = source.indexOf("this.captureInProgress = false", save);
  assert.ok(save >= 0 && unlock > save, "capture controls must remain locked until preview persistence completes");
  assert.match(source, /clipboardOperationInProgress/);
});

test("Escape cancellation stays active through capture restoration but seals before persistence", async () => {
  const source = await readFile(new URL("../src/capture-view.ts", import.meta.url), "utf8");
  assert.match(source, /event\.key !== "Escape"[\s\S]*requestCaptureCancellation\(\)/);
  assert.match(source, /Capturing the entire page[^`]*Press Esc to cancel/);
  assert.match(source, /this\.captureCancellationChecksSuspended = true;[\s\S]*setZoomFactor\(originalZoom\)[\s\S]*releaseNotabilityPageCapture[\s\S]*this\.captureCancellationChecksSuspended = false/);
  assert.match(source, /captureResultAfterRestoration[\s\S]*sealCaptureCancellation\(cancellationTicket\)[\s\S]*await this\.host\.savePreview/);
  assert.doesNotMatch(source, /navigationGeneration\s*\+=\s*1;\s*\/\/.*cancel/i);
});

test("whole-page zoom phases use separate identity and strict tile-layout baselines", async () => {
  const source = await readFile(new URL("../src/capture-view.ts", import.meta.url), "utf8");
  assert.match(source, /wholePageIdentityBaseline = snapshot/);
  assert.match(source, /snapshot = await claimNotabilityPageCapture\(webview, expectedPage, pageCaptureToken\)/);
  assert.match(source, /assertWholePageCaptureIdentity\(wholePageIdentityBaseline, snapshot\);\s*wholePagePhaseBaseline = snapshot/);
  assert.match(source, /captureWholePageAtZoom\([\s\S]*?wholePagePhaseBaseline!,\s*pageCaptureToken!/);
  assert.match(source, /assertWholePageCapturePhaseLayout\(phaseBaseline, current\)/);
  assert.match(source, /assertWholePageCapturePhaseLayout\(phaseBaseline, postCapture\)/);
  assert.match(source, /assertWholePageCaptureIdentity\(wholePageIdentityBaseline, restored\)/);
  assert.match(source, /const current = await inspectNotabilityPageAt\(webview, expectedPage, pageCaptureToken\)/);
  assert.match(source, /const postCapture = await inspectNotabilityPageAt\(webview, expectedPage, pageCaptureToken\)/);
});

test("whole-page embeds remain V1 regions and render without the area-card height cap", async () => {
  const [model, card, styles] = await Promise.all([
    readFile(new URL("../src/model.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/card.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8")
  ]);
  assert.match(model, /FULL_PAGE_RECT/);
  assert.match(model, /x:\s*0,[\s\S]*y:\s*0,[\s\S]*width:\s*1,[\s\S]*height:\s*1/);
  assert.match(card, /isFullPageRect\(region\.rect\).*is-full-page/);
  assert.match(styles, /\.notability-live-region-card\.is-full-page img\s*\{\s*max-height:\s*none;/);
});
