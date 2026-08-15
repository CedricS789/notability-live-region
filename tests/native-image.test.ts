import assert from "node:assert/strict";
import test from "node:test";
import { encodeBestPreviewImage } from "../src/native-image";
import type { CapturedNativeImage } from "../src/webview-types";

function image(scales: number[], sizes: Record<string, { width: number; height: number }>) {
  const encoded: number[] = [];
  const value: CapturedNativeImage = {
    isEmpty: () => false,
    getScaleFactors: () => scales,
    getSize: (scale = 1) => sizes[String(scale)] ?? { width: 0, height: 0 },
    toPNG: ({ scaleFactor } = {}) => {
      encoded.push(scaleFactor ?? 1);
      return Uint8Array.from([1, 2, 3]);
    }
  };
  return { value, encoded };
}

test("preview encoding chooses the highest real representation up to 2x", () => {
  const fixture = image([1, 1.25, 2, 3], {
    "1": { width: 200, height: 100 },
    "1.25": { width: 250, height: 125 },
    "2": { width: 400, height: 200 },
    "3": { width: 600, height: 300 }
  });
  const result = encodeBestPreviewImage(fixture.value);
  assert.equal(result.chosenScale, 2);
  assert.deepEqual(result.availableScales, [1, 1.25, 2, 3]);
  assert.deepEqual([result.pixelWidth, result.pixelHeight], [400, 200]);
  assert.deepEqual(fixture.encoded, [2]);
});

test("preview encoding preserves a sole 1x representation without upsampling", () => {
  const fixture = image([1], { "1": { width: 120, height: 80 } });
  const result = encodeBestPreviewImage(fixture.value);
  assert.equal(result.chosenScale, 1);
  assert.deepEqual([result.pixelWidth, result.pixelHeight], [120, 80]);
  assert.deepEqual(fixture.encoded, [1]);
});

test("preview encoding rejects empty images and invalid representations", () => {
  const empty = image([1], { "1": { width: 1, height: 1 } }).value;
  empty.isEmpty = () => true;
  assert.throws(() => encodeBestPreviewImage(empty), /empty/);
  assert.throws(
    () => encodeBestPreviewImage(image([2], { "2": { width: 0, height: 10 } }).value),
    /pixel dimensions/
  );
});

test("preview encoding never exceeds the 2x capture ceiling", () => {
  const fixture = image([3], { "3": { width: 900, height: 600 } });
  assert.throws(() => encodeBestPreviewImage(fixture.value), /at or below 2x/);
});
