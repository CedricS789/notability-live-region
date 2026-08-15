import assert from "node:assert/strict";
import test from "node:test";
import { ViewerLatencyTracker, isAuthenticationRedirect } from "../src/latency";

test("latency tracker reports identity-free viewer phases", () => {
  const tracker = new ViewerLatencyTracker();
  tracker.leafReady(12.4);
  tracker.webviewAttached(34.6);
  tracker.navigationStarted(100);
  tracker.authenticationRedirect(125);
  tracker.authenticationRedirect(150);
  tracker.navigationFinished(250);
  tracker.firstPage(400);
  tracker.regionAligned(550);
  assert.deepEqual(tracker.snapshot(), {
    leafReadyMs: 12,
    webviewAttachMs: 35,
    navigationMs: 150,
    authenticationRedirectMs: 25,
    firstPageMs: 300,
    regionAlignmentMs: 450,
    redirectCount: 2
  });
});

test("latency milestones remain first-observation timings", () => {
  const tracker = new ViewerLatencyTracker();
  tracker.navigationStarted(100);
  tracker.firstPage(220);
  tracker.firstPage(500);
  tracker.regionAligned(300);
  tracker.regionAligned(700);
  assert.equal(tracker.snapshot().firstPageMs, 120);
  assert.equal(tracker.snapshot().regionAlignmentMs, 200);
});

test("warm alignment is measured as its own phase without a navigation", () => {
  const tracker = new ViewerLatencyTracker();
  tracker.regionAlignmentStarted(500);
  tracker.regionAligned(650);
  assert.equal(tracker.snapshot().regionAlignmentMs, 150);
  assert.equal(tracker.snapshot().navigationMs, undefined);
});

test("authentication redirect classification never needs a note identity", () => {
  assert.equal(isAuthenticationRedirect("about:blank"), false);
  assert.equal(isAuthenticationRedirect("https://notability.com/app/note/11111111-2222-4333-8444-555555555555"), false);
  assert.equal(isAuthenticationRedirect("https://www.notability.com/app/note/11111111-2222-4333-8444-555555555555"), false);
  assert.equal(isAuthenticationRedirect("https://notability.com/login"), true);
  assert.equal(isAuthenticationRedirect("https://accounts.google.com/o/oauth2/auth"), true);
  assert.equal(isAuthenticationRedirect("not a url"), false);
});
