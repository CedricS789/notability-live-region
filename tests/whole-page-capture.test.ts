import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWholePageCaptureIdentity,
  assertWholePageCapturePhaseLayout,
  captureStableWholePageTile,
  capturedTileSourceRect,
  planWholePageCapture,
  stitchWholePageCapture,
  type WholePageCapturePlan
} from "../src/whole-page-capture";

function notabilityPagePlan() {
  return planWholePageCapture({
    page: { width: 900, height: 1272 },
    captureViewport: { x: 12, y: 18, width: 420, height: 300 },
    captureScale: 1,
    targetDensity: 2
  });
}

function assertExactDestinationPartition(plan: WholePageCapturePlan): void {
  let totalArea = 0;
  for (let row = 0; row < plan.grid.rows; row += 1) {
    const tiles = plan.tiles.filter((tile) => tile.row === row);
    assert.equal(tiles[0]?.destination.x, 0);
    const last = tiles.at(-1);
    assert.ok(last);
    assert.equal(last.destination.x + last.destination.width, plan.raster.width);
    for (let column = 1; column < tiles.length; column += 1) {
      const previous = tiles[column - 1];
      const current = tiles[column];
      assert.ok(previous && current);
      assert.equal(previous.destination.x + previous.destination.width, current.destination.x);
    }
  }
  for (let column = 0; column < plan.grid.columns; column += 1) {
    const tiles = plan.tiles.filter((tile) => tile.column === column);
    assert.equal(tiles[0]?.destination.y, 0);
    const last = tiles.at(-1);
    assert.ok(last);
    assert.equal(last.destination.y + last.destination.height, plan.raster.height);
    for (let row = 1; row < tiles.length; row += 1) {
      const previous = tiles[row - 1];
      const current = tiles[row];
      assert.ok(previous && current);
      assert.equal(previous.destination.y + previous.destination.height, current.destination.y);
    }
  }
  for (const tile of plan.tiles) totalArea += tile.destination.width * tile.destination.height;
  assert.equal(totalArea, plan.raster.width * plan.raster.height);
}

test("whole-page planner makes viewport-bounded, gap-free page tiles", () => {
  const plan = notabilityPagePlan();
  assert.deepEqual(plan.raster, { width: 1800, height: 2544 });
  assert.deepEqual(plan.grid, { columns: 3, rows: 5 });
  assert.equal(plan.tiles.length, 15);
  assert.deepEqual(plan.tiles[0], {
    id: "r0-c0",
    index: 0,
    row: 0,
    column: 0,
    normalized: { x: 0, y: 0, width: 420 / 900, height: 300 / 1272 },
    logical: { x: 0, y: 0, width: 420, height: 300 },
    scroll: { x: 0, y: 0 },
    crop: { x: 12, y: 18, width: 420, height: 300 },
    source: { x: 0, y: 0, width: 840, height: 600 },
    destination: { x: 0, y: 0, width: 840, height: 600 }
  });
  const last = plan.tiles.at(-1);
  assert.ok(last);
  assert.deepEqual(last.logical, { x: 840, y: 1200, width: 60, height: 72 });
  assert.deepEqual(last.crop, { x: 12, y: 18, width: 60, height: 72 });
  assert.deepEqual(last.destination, { x: 1680, y: 2400, width: 120, height: 144 });
  assert.equal(last.normalized.x + last.normalized.width, 1);
  assert.equal(last.normalized.y + last.normalized.height, 1);
  assert.ok(plan.tiles.every((tile) => tile.crop.width <= 420 && tile.crop.height <= 300));
  assertExactDestinationPartition(plan);
});

test("whole-page identity accepts the observed responsive restoration reflow", () => {
  const baseline = {
    page: 1,
    pageCount: 2,
    pageRect: { x: 10, y: 20, width: 320, height: 400 },
    pageAspect: 320 / 400
  };
  assert.doesNotThrow(() => assertWholePageCaptureIdentity(baseline, {
    ...baseline,
    pageRect: { ...baseline.pageRect, height: 408 },
    pageAspect: 320 / 408
  }));
});

test("whole-page identity accepts proportional rescale, bounded aspect reflow, and page-count drift", () => {
  const baseline = {
    page: 2,
    pageCount: 5,
    pageRect: { x: 10, y: 20, width: 900, height: 1272 },
    pageAspect: 900 / 1272
  };
  assert.doesNotThrow(() => assertWholePageCaptureIdentity(baseline, {
    ...baseline,
    pageCount: 8,
    pageRect: { x: -400, y: -600, width: 450, height: 636 },
    pageAspect: 450 / 636
  }));
  assert.doesNotThrow(() => assertWholePageCaptureIdentity(baseline, {
    ...baseline,
    pageCount: 1,
    pageRect: { ...baseline.pageRect, height: 1310 },
    pageAspect: 900 / 1310
  }));
});

test("whole-page identity rejects ordinal and orientation changes", () => {
  const baseline = {
    page: 2,
    pageCount: 5,
    pageRect: { x: 10, y: 20, width: 900, height: 1272 },
    pageAspect: 900 / 1272
  };
  assert.throws(
    () => assertWholePageCaptureIdentity(baseline, { ...baseline, page: 3 }),
    /page ordinal changed/
  );
  assert.throws(() => assertWholePageCaptureIdentity(baseline, {
    ...baseline,
    pageRect: { ...baseline.pageRect, width: 1272, height: 900 },
    pageAspect: 1272 / 900
  }), /page identity changed/);
  assert.throws(() => assertWholePageCaptureIdentity(baseline, {
    ...baseline,
    pageRect: { ...baseline.pageRect, height: 1370 },
    pageAspect: 900 / 1370
  }), /page identity changed/);
  assert.throws(() => assertWholePageCaptureIdentity(baseline, {
    ...baseline,
    pageRect: { ...baseline.pageRect, x: Number.NaN }
  }), /identity geometry is invalid/);
});

test("whole-page phase layout ignores count materialization but rejects tile geometry drift", () => {
  const baseline = {
    page: 2,
    pageCount: 2,
    pageRect: { x: 10, y: 20, width: 320, height: 408 },
    pageAspect: 320 / 408
  };
  assert.doesNotThrow(() => assertWholePageCapturePhaseLayout(baseline, {
    ...baseline,
    pageCount: 9,
    pageRect: { ...baseline.pageRect, x: -400, y: -600 }
  }));
  assert.throws(() => assertWholePageCapturePhaseLayout(baseline, {
    ...baseline,
    pageRect: { ...baseline.pageRect, width: 322 },
    pageAspect: 322 / 408
  }), /phase layout changed/);
  assert.throws(() => assertWholePageCapturePhaseLayout(baseline, {
    ...baseline,
    pageRect: { ...baseline.pageRect, height: 410 },
    pageAspect: 320 / 410
  }), /phase layout changed/);
  assert.throws(
    () => assertWholePageCapturePhaseLayout(baseline, { ...baseline, page: 3 }),
    /page ordinal changed/
  );
});

test("capture scale changes scroll capacity while preserving stable raster density", () => {
  const plan = planWholePageCapture({
    page: { width: 900, height: 1272 },
    captureViewport: { x: 0, y: 0, width: 420, height: 300 },
    captureScale: 2,
    targetDensity: 3
  });
  assert.deepEqual(plan.raster, { width: 2700, height: 3816 });
  assert.deepEqual(plan.effectiveDensity, { width: 3, height: 3 });
  assert.deepEqual(plan.grid, { columns: 5, rows: 9 });
  assert.deepEqual(plan.tiles[0]?.logical, { x: 0, y: 0, width: 210, height: 150 });
  assert.deepEqual(plan.tiles[0]?.crop, { x: 0, y: 0, width: 420, height: 300 });
  assert.deepEqual(plan.tiles[0]?.destination, { x: 0, y: 0, width: 630, height: 450 });
  assertExactDestinationPartition(plan);
});

test("fractional geometry uses contained integer crops and discards only right/bottom overscan", () => {
  const plan = planWholePageCapture({
    page: { width: 901.25, height: 1273.5 },
    captureViewport: { x: 3.2, y: 4.1, width: 421.8, height: 301.4 },
    captureScale: 1.375,
    targetDensity: 1.8
  });
  assert.ok(plan.tiles.length > 1);
  assert.ok(plan.tiles.every((tile) => Number.isInteger(tile.crop.x)
    && Number.isInteger(tile.crop.y)
    && Number.isInteger(tile.crop.width)
    && Number.isInteger(tile.crop.height)));
  assert.ok(plan.tiles.every((tile) => tile.crop.x >= plan.captureViewport.x
    && tile.crop.y >= plan.captureViewport.y
    && tile.crop.x + tile.crop.width <= plan.captureViewport.x + plan.captureViewport.width
    && tile.crop.y + tile.crop.height <= plan.captureViewport.y + plan.captureViewport.height));
  assert.ok(plan.tiles.every((tile) => tile.source.width === tile.destination.width
    && tile.source.height === tile.destination.height));
  assertExactDestinationPartition(plan);
});

test("captured tile source maps fractional host content into real decoded pixels", () => {
  assert.deepEqual(capturedTileSourceRect(
    { x: 10.25, y: 20.5, width: 99.5, height: 49.25 },
    { x: 10, y: 20, width: 100, height: 50 },
    { width: 150, height: 75 }
  ), {
    x: 0.375,
    y: 0.75,
    width: 149.25,
    height: 73.875
  });
  assert.throws(() => capturedTileSourceRect(
    { x: 9, y: 20, width: 100, height: 50 },
    { x: 10, y: 20, width: 100, height: 50 },
    { width: 150, height: 75 }
  ), /complete logical content/);
});

test("planner fails closed on unsafe raster and tile bounds", () => {
  assert.throws(() => planWholePageCapture({
    page: { width: 5000, height: 100 },
    captureViewport: { x: 0, y: 0, width: 500, height: 500 },
    captureScale: 1,
    targetDensity: 2,
    limits: { maxRasterDimension: 8192 }
  }), /dimension limit/);
  assert.throws(() => planWholePageCapture({
    page: { width: 1000, height: 1000 },
    captureViewport: { x: 0, y: 0, width: 500, height: 500 },
    captureScale: 1,
    targetDensity: 2,
    limits: { maxRasterArea: 3_000_000 }
  }), /area limit/);
  assert.throws(() => planWholePageCapture({
    page: { width: 1000, height: 1000 },
    captureViewport: { x: 0, y: 0, width: 100, height: 100 },
    captureScale: 1,
    targetDensity: 1,
    limits: { maxTileCount: 25 }
  }), /tile limit/);
  assert.throws(() => planWholePageCapture({
    page: { width: 100, height: 100 },
    captureViewport: { x: 0, y: 0, width: 0.5, height: 100 },
    captureScale: 1,
    targetDensity: 1
  }), /integral capturePage area/);
});

test("injectable stitcher draws shuffled chunks in deterministic tile order", async () => {
  const plan = planWholePageCapture({
    page: { width: 4, height: 3 },
    captureViewport: { x: 0, y: 0, width: 2, height: 2 },
    captureScale: 1,
    targetDensity: 1,
    limits: { maxRasterDimension: 10, maxRasterArea: 100, maxTileCount: 10 }
  });
  type Encoded = { name: string; width: number; height: number };
  type Image = Encoded & { decoded: true };
  type Surface = { width: number; height: number };
  const draws: Array<{ name: string; source: object; destination: object }> = [];
  const releasedImages: string[] = [];
  let surfaceReleased = false;
  const chunks = plan.tiles.map((tile) => ({
    tileIndex: tile.index,
    encoded: { name: tile.id, width: tile.source.width + 1, height: tile.source.height + 1 }
  })).reverse();
  const result = await stitchWholePageCapture<Encoded, Image, Surface, string>(plan, chunks, {
    createSurface: ({ width, height }) => ({ width, height }),
    decode: async (encoded) => ({ ...encoded, decoded: true }),
    imageSize: ({ width, height }) => ({ width, height }),
    draw: (_surface, image, source, destination) => {
      draws.push({ name: image.name, source, destination });
    },
    encode: async (surface) => `${surface.width}x${surface.height}:${draws.length}`,
    releaseImage: (image) => { releasedImages.push(image.name); },
    releaseSurface: () => { surfaceReleased = true; }
  });
  assert.equal(result, "4x3:4");
  assert.deepEqual(draws.map((draw) => draw.name), plan.tiles.map((tile) => tile.id));
  assert.deepEqual(draws.map((draw) => draw.source), plan.tiles.map((tile) => tile.source));
  assert.deepEqual(draws.map((draw) => draw.destination), plan.tiles.map((tile) => tile.destination));
  assert.deepEqual(releasedImages, plan.tiles.map((tile) => tile.id));
  assert.equal(surfaceReleased, true);
});

test("stitcher accepts live fractional source rectangles and discards surrounding overscan", async () => {
  const plan = planWholePageCapture({
    page: { width: 3, height: 2 },
    captureViewport: { x: 0, y: 0, width: 2, height: 2 },
    captureScale: 1,
    targetDensity: 1
  });
  const sources = [
    { x: 0.25, y: 0.5, width: 2, height: 2 },
    { x: 1.125, y: 0.375, width: 1, height: 2 }
  ];
  const chunks = plan.tiles.map((tile) => ({
    tileIndex: tile.index,
    encoded: { width: 4, height: 4 },
    source: sources[tile.index]!
  })).reverse();
  const drawn: Array<{ source: object; destination: object }> = [];
  await stitchWholePageCapture(plan, chunks, {
    createSurface: () => ({}),
    decode: async (encoded) => encoded,
    imageSize: (image) => image,
    draw: (_surface, _image, source, destination) => { drawn.push({ source, destination }); },
    encode: async () => "stitched"
  });
  assert.deepEqual(drawn.map((entry) => entry.source), sources);
  assert.deepEqual(drawn.map((entry) => entry.destination), plan.tiles.map((tile) => tile.destination));
});

test("stitcher rejects missing, duplicate, unexpected, and undersized chunks", async () => {
  const plan = planWholePageCapture({
    page: { width: 3, height: 2 },
    captureViewport: { x: 0, y: 0, width: 2, height: 2 },
    captureScale: 1,
    targetDensity: 1
  });
  const chunks = plan.tiles.map((tile) => ({
    tileIndex: tile.index,
    encoded: { width: tile.source.width, height: tile.source.height }
  }));
  const primitives = {
    createSurface: () => ({}),
    decode: async (encoded: { width: number; height: number }) => encoded,
    imageSize: (image: { width: number; height: number }) => image,
    draw: () => undefined,
    encode: async () => Uint8Array.of(1)
  };
  await assert.rejects(stitchWholePageCapture(plan, chunks.slice(1), primitives), /Missing whole-page tile/);
  await assert.rejects(stitchWholePageCapture(plan, [...chunks, chunks[0]!], primitives), /Duplicate/);
  await assert.rejects(stitchWholePageCapture(plan, [...chunks, { tileIndex: 99, encoded: { width: 1, height: 1 } }], primitives), /Unexpected/);

  let releasedImages = 0;
  let releasedSurface = 0;
  const undersized = chunks.map((chunk) => chunk.tileIndex === 0
    ? { ...chunk, encoded: { width: 0, height: 0 } }
    : chunk);
  await assert.rejects(stitchWholePageCapture(plan, undersized, {
    ...primitives,
    releaseImage: () => { releasedImages += 1; },
    releaseSurface: () => { releasedSurface += 1; }
  }), /invalid decoded image dimensions/);
  assert.equal(releasedImages, 1);
  assert.equal(releasedSurface, 1);
});

test("stitcher rejects invalid and out-of-bounds live source rectangles", async () => {
  const plan = planWholePageCapture({
    page: { width: 2, height: 2 },
    captureViewport: { x: 0, y: 0, width: 2, height: 2 },
    captureScale: 1,
    targetDensity: 1
  });
  const primitives = {
    createSurface: () => ({}),
    decode: async (encoded: { width: number; height: number }) => encoded,
    imageSize: (image: { width: number; height: number }) => image,
    draw: () => undefined,
    encode: async () => "stitched"
  };
  for (const source of [
    { x: -0.25, y: 0, width: 2, height: 2 },
    { x: 0, y: 0, width: 0, height: 2 },
    { x: 0, y: 0, width: Number.NaN, height: 2 }
  ]) {
    await assert.rejects(stitchWholePageCapture(plan, [{
      tileIndex: 0,
      encoded: { width: 4, height: 4 },
      source
    }], primitives), /invalid source rectangle/);
  }
  await assert.rejects(stitchWholePageCapture(plan, [{
    tileIndex: 0,
    encoded: { width: 4, height: 4 },
    source: { x: 2.25, y: 0.5, width: 2, height: 2 }
  }], primitives), /source falls outside/);
});

test("tile stability accepts only consecutive identical PNG bytes and is bounded", async () => {
  const frames = [
    Uint8Array.of(1),
    Uint8Array.of(2),
    Uint8Array.of(2),
    Uint8Array.of(2)
  ];
  let captures = 0;
  let pauses = 0;
  const stable = await captureStableWholePageTile(
    async () => ({ bytes: frames[Math.min(captures++, frames.length - 1)]! }),
    (value) => value.bytes,
    async () => { pauses += 1; },
    6
  );
  assert.deepEqual(stable.bytes, Uint8Array.of(2));
  assert.equal(captures, 6);
  assert.equal(pauses, 5);

  const latePaint = [
    Uint8Array.of(7),
    Uint8Array.of(7),
    Uint8Array.of(8),
    Uint8Array.of(8),
    Uint8Array.of(8)
  ];
  let latePaintCaptures = 0;
  const repainted = await captureStableWholePageTile(
    async () => ({ bytes: latePaint[Math.min(latePaintCaptures++, latePaint.length - 1)]! }),
    (value) => value.bytes,
    async () => undefined,
    8,
    3
  );
  assert.deepEqual(repainted.bytes, Uint8Array.of(8));
  assert.equal(latePaintCaptures, 8, "the complete bounded window must be observed");

  const earlyFalseStability = [1, 1, 1, 2, 3, 4, 5, 6].map((value) => Uint8Array.of(value));
  let earlyCaptures = 0;
  await assert.rejects(captureStableWholePageTile(
    async () => ({ bytes: earlyFalseStability[earlyCaptures++]! }),
    (value) => value.bytes,
    async () => undefined,
    8,
    3
  ), /did not finish rendering/);
  assert.equal(earlyCaptures, 8, "an early stale streak must not end the paint window");

  let unstableCaptures = 0;
  await assert.rejects(captureStableWholePageTile(
    async () => ({ bytes: Uint8Array.of(unstableCaptures++) }),
    (value) => value.bytes,
    async () => undefined,
    4,
    3
  ), /did not finish rendering/);
  assert.equal(unstableCaptures, 4);
  await assert.rejects(captureStableWholePageTile(
    async () => ({ bytes: Uint8Array.of(1) }),
    (value) => value.bytes,
    async () => undefined,
    2,
    3
  ), /attempts/);
});
