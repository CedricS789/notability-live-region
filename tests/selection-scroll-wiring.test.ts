import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Area and Text lock manual scrolling while Browse and plugin alignment remain available", async () => {
  const source = await readFile(new URL("../src/capture-view.ts", import.meta.url), "utf8");

  assert.match(source, /addEventListener\("wheel"/);
  assert.match(source, /if \(this\.interactionMode === "browse"\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\)/);
  assert.match(source, /buildSelectionScrollLockScript/);
  assert.match(source, /buildGuestCaptureEscapeScript/);
  assert.match(source, /addEventListener\("console-message"/);
  assert.match(source, /GUEST_CAPTURE_ESCAPE_MESSAGE/);
  assert.match(source, /selectionModeLocksScrolling\(this\.interactionMode\)/);
  assert.match(
    source,
    /this\.interactionMode === "text"\s*&& \(!this\.loaded \|\| !this\.selectionScrollLockReady\)/,
  );
  assert.doesNotMatch(source, /sendInputEvent|dispatchSelectionWheel|areaScrollQueue|areaWheelState/);
  assert.match(source, /if \(mode !== "browse" \|\| mode !== this\.interactionMode\)/);
  assert.match(source, /this\.pendingNavigation\.targetRegion = null/);
  assert.match(source, /navigation\.isMainFrame === false \|\| navigation\.isInPlace === true/);
  assert.match(source, /didNavigateInPageHandler\s*=\s*\(event\)\s*=>\s*this\.commitNavigation\([^;]+, false\)/);
  assert.match(source, /regionAlignment\.claim\(targetRegion\.id\)/);
  assert.match(source, /scrollRegionIntoView/);
  assert.match(source, /scrollToPage/);
});
