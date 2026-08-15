import assert from "node:assert/strict";
import test from "node:test";
import {
  captureRectAtZoom,
  captureResultAfterRestoration,
  planCaptureZoom,
  planWholePageZoom,
  previewDisplaySize,
  validateGuestCaptureMetrics
} from "../src/sharp-capture";

const region = { x: 0.1, y: 0.2, width: 0.4, height: 0.25 };
const page = { x: 100, y: 80, width: 600, height: 900 };

test("capture zoom targets stable density and respects viewport fit", () => {
  assert.equal(planCaptureZoom(page, region, { width: 1400, height: 1200 }, 1.5).zoomFactor, 2);
  assert.equal(planCaptureZoom(page, region, { width: 1400, height: 1200 }, 2).zoomFactor, 1.5);
  assert.equal(planCaptureZoom(page, region, { width: 1400, height: 1200 }, 1.25).zoomFactor, 2);
  const fitted = planCaptureZoom(page, { x: 0, y: 0, width: 1, height: 1 }, { width: 700, height: 980 }, 1);
  assert.ok(fitted.zoomFactor >= 1 && fitted.zoomFactor < 1.1);
});

test("whole-page zoom targets real density without requiring viewport fit", () => {
  assert.deepEqual(planWholePageZoom(page, 1.5), { zoomFactor: 2, desiredZoom: 2 });
  assert.deepEqual(planWholePageZoom({ ...page, width: 1200 }, 1.5), {
    zoomFactor: 1,
    desiredZoom: 1
  });
  assert.throws(() => planWholePageZoom({ ...page, width: 0 }, 1.5), /positive/);
});

test("zoomed guest crop maps to capturePage coordinates with nonzero origins", () => {
  assert.deepEqual(
    captureRectAtZoom(region, page, { width: 900, height: 700 }, { width: 1350, height: 1050 }, 1.5),
    { x: 240, y: 390, width: 360, height: 338 }
  );
  assert.throws(
    () => captureRectAtZoom(region, page, { width: 400, height: 400 }, { width: 600, height: 600 }, 1.5),
    /clipped/
  );
  assert.throws(
    () => captureRectAtZoom(region, page, { width: 900, height: 700 }, { width: 500, height: 500 }, 1.5),
    /outside/
  );
});

test("canonical preview display is independent of capture scale and never upscales", () => {
  assert.deepEqual(previewDisplaySize(region, 2 / 3, { width: 1000, height: 1000 }), { width: 360, height: 337.5 });
  assert.deepEqual(previewDisplaySize(region, 2 / 3, { width: 180, height: 200 }), { width: 180, height: 168.75 });
});

test("restoration is mandatory before capture result can be committed", () => {
  assert.equal(captureResultAfterRestoration("ok", null, null), "ok");
  assert.throws(() => captureResultAfterRestoration("pixels", null, new Error("restore")), /discarded.*restore/);
  assert.throws(() => captureResultAfterRestoration(null, new Error("capture"), null), /capture/);
});

test("guest capture metrics validate finite positive values", () => {
  assert.deepEqual(validateGuestCaptureMetrics({ devicePixelRatio: 1.5, viewport: { width: 900, height: 700 } }), {
    devicePixelRatio: 1.5,
    viewport: { width: 900, height: 700 }
  });
  assert.throws(() => validateGuestCaptureMetrics({ devicePixelRatio: 0, viewport: { width: 1, height: 1 } }), /positive/);
});
