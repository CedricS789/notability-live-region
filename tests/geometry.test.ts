import assert from "node:assert/strict";
import test from "node:test";
import { aspectDrift, capturePixelRect, denormalizeRect, normalizeSelection, rectFromPoints, sameCssRect } from "../src/geometry";

test("selection geometry clips to page and round-trips", () => {
  const page = { x: 100, y: 200, width: 400, height: 800 };
  const normalized = normalizeSelection({ x: 50, y: 300, width: 300, height: 300 }, page);
  assert.deepEqual(normalized, { x: 0, y: 0.125, width: 0.625, height: 0.375 });
  assert.deepEqual(denormalizeRect(normalized, page), { x: 100, y: 300, width: 250, height: 300 });
});

test("tiny or external selections are refused", () => {
  const page = { x: 0, y: 0, width: 100, height: 100 };
  assert.throws(() => normalizeSelection({ x: 200, y: 200, width: 10, height: 10 }, page), /inside/);
  assert.throws(() => normalizeSelection({ x: 1, y: 1, width: 2, height: 2 }, page), /inside/);
});

test("point and aspect helpers are order-independent and fail closed", () => {
  assert.deepEqual(rectFromPoints({ x: 8, y: 10 }, { x: 2, y: 4 }), { x: 2, y: 4, width: 6, height: 6 });
  assert.ok(Math.abs(aspectDrift(2, 2.2) - 0.1) < Number.EPSILON);
  assert.equal(aspectDrift(0, 2), Number.POSITIVE_INFINITY);
});

test("capture pixels preserve the full visible crop without accepting clipped geometry", () => {
  const page = { x: 10.2, y: 20.2, width: 400, height: 800 };
  assert.deepEqual(
    capturePixelRect({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, page, { width: 500, height: 900 }),
    { x: 110, y: 220, width: 201, height: 401 }
  );
  assert.throws(
    () => capturePixelRect({ x: 0, y: 0, width: 1, height: 1 }, { ...page, x: -20 }, { width: 500, height: 900 }),
    /outside the visible/
  );
});

test("page geometry comparison detects within-note scrolling", () => {
  const original = { x: 10, y: 20, width: 400, height: 800 };
  assert.equal(sameCssRect(original, { x: 10.5, y: 19.5, width: 400, height: 800 }), true);
  assert.equal(sameCssRect(original, { x: 10, y: 35, width: 400, height: 800 }), false);
});
