/** Pure geometry and composition helpers for bounded whole-page capture. */

export type WholePageSize = Readonly<{ width: number; height: number }>;

export type WholePagePoint = Readonly<{ x: number; y: number }>;

export type WholePageRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type WholePagePixelRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type WholePageCaptureLimits = Readonly<{
  maxRasterDimension: number;
  maxRasterArea: number;
  maxTileCount: number;
}>;

export const DEFAULT_WHOLE_PAGE_CAPTURE_LIMITS: WholePageCaptureLimits = {
  maxRasterDimension: 8192,
  maxRasterArea: 48_000_000,
  maxTileCount: 256
};

export type WholePageCapturePlanInput = Readonly<{
  /** Full logical page size in guest CSS pixels. */
  page: WholePageSize;
  /** Safe capturePage rectangle available inside the host webview. */
  captureViewport: WholePageRect;
  /** capturePage CSS pixels per logical guest CSS pixel (normally webview zoom). */
  captureScale: number;
  /** Desired encoded raster pixels per logical guest CSS pixel. */
  targetDensity: number;
  limits?: Partial<WholePageCaptureLimits>;
}>;

export type WholePageCaptureTile = Readonly<{
  id: string;
  index: number;
  row: number;
  column: number;
  /** Exact, gap-free ownership of the normalized logical page. */
  normalized: WholePageRect;
  /** Exact page-relative source rectangle in logical guest CSS pixels. */
  logical: WholePageRect;
  /** Page-relative offset that integration must align with captureViewport.x/y. */
  scroll: WholePagePoint;
  /** Integer host CSS rectangle to pass to webview.capturePage after alignment. */
  crop: WholePagePixelRect;
  /** Pixel rectangle copied from the captured tile; right/bottom overscan is discarded. */
  source: WholePagePixelRect;
  /** Exact, gap-free destination in the final raster. */
  destination: WholePagePixelRect;
}>;

export type WholePageCapturePlan = Readonly<{
  version: 1;
  logicalPage: WholePageSize;
  captureViewport: WholePageRect;
  captureScale: number;
  targetDensity: number;
  effectiveDensity: WholePageSize;
  raster: WholePageSize;
  grid: Readonly<{ columns: number; rows: number }>;
  limits: WholePageCaptureLimits;
  tiles: readonly WholePageCaptureTile[];
}>;

export type WholePageCaptureBaseline = Readonly<{
  page: number;
  pageCount: number;
  pageRect: WholePageRect;
  pageAspect: number;
}>;

function validateWholePageCaptureBaseline(
  snapshot: WholePageCaptureBaseline,
  scope: "identity" | "phase layout"
): void {
  const geometry = [
    snapshot.pageRect.x,
    snapshot.pageRect.y,
    snapshot.pageRect.width,
    snapshot.pageRect.height,
    snapshot.pageAspect
  ];
  if (
    !Number.isSafeInteger(snapshot.page)
    || snapshot.page < 1
    || geometry.some((value) => !Number.isFinite(value))
    || snapshot.pageRect.width <= 0
    || snapshot.pageRect.height <= 0
    || snapshot.pageAspect <= 0
  ) {
    throw new Error(`Whole-page capture ${scope} geometry is invalid.`);
  }
  const measuredAspect = snapshot.pageRect.width / snapshot.pageRect.height;
  if (Math.abs(snapshot.pageAspect - measuredAspect) / measuredAspect > 0.002) {
    throw new Error(`Whole-page capture ${scope} geometry is internally inconsistent.`);
  }
}

function pageOrientation(snapshot: WholePageCaptureBaseline): "portrait" | "square" | "landscape" {
  if (snapshot.pageRect.width < snapshot.pageRect.height) return "portrait";
  if (snapshot.pageRect.width > snapshot.pageRect.height) return "landscape";
  return "square";
}

/**
 * Validate the semantic page identity across viewer-zoom phases. The caller
 * must separately prove exact DOM identity by inspecting with the same guest
 * capture token. Page-frame count is deliberately excluded because Notability
 * materializes it asynchronously. A five-percent aspect window admits the
 * observed responsive reflow while the explicit orientation lock fails closed.
 */
export function assertWholePageCaptureIdentity(
  baseline: WholePageCaptureBaseline,
  current: WholePageCaptureBaseline,
  aspectTolerance = 0.05
): void {
  validateWholePageCaptureBaseline(baseline, "identity");
  validateWholePageCaptureBaseline(current, "identity");
  if (current.page !== baseline.page) {
    throw new Error(`Whole-page capture page ordinal changed from ${baseline.page} to ${current.page}.`);
  }
  if (
    pageOrientation(current) !== pageOrientation(baseline)
    || Math.abs(current.pageAspect - baseline.pageAspect) / baseline.pageAspect > aspectTolerance
  ) {
    throw new Error("Whole-page capture page identity changed across viewer scale phases.");
  }
}

/** Keep one zoomed tile phase geometrically fixed while its page is captured. */
export function assertWholePageCapturePhaseLayout(
  baseline: WholePageCaptureBaseline,
  current: WholePageCaptureBaseline,
  geometryTolerance = 0.75,
  aspectTolerance = 0.002
): void {
  validateWholePageCaptureBaseline(baseline, "phase layout");
  validateWholePageCaptureBaseline(current, "phase layout");
  if (current.page !== baseline.page) {
    throw new Error(`Whole-page capture page ordinal changed from ${baseline.page} to ${current.page}.`);
  }
  if (
    Math.abs(current.pageRect.width - baseline.pageRect.width) > geometryTolerance
    || Math.abs(current.pageRect.height - baseline.pageRect.height) > geometryTolerance
    || Math.abs(current.pageAspect - baseline.pageAspect) / baseline.pageAspect > aspectTolerance
  ) {
    throw new Error("Whole-page capture phase layout changed during tiled capture.");
  }
}

/**
 * Map the exact floating-point page content enclosed by an integral
 * capturePage crop into decoded raster coordinates.
 */
export function capturedTileSourceRect(
  contentInHost: WholePageRect,
  crop: WholePagePixelRect,
  image: WholePageSize
): WholePageRect {
  nonNegativeFinite(contentInHost.x, "Captured content x");
  nonNegativeFinite(contentInHost.y, "Captured content y");
  positiveFinite(contentInHost.width, "Captured content width");
  positiveFinite(contentInHost.height, "Captured content height");
  nonNegativeFinite(crop.x, "Capture crop x");
  nonNegativeFinite(crop.y, "Capture crop y");
  positiveInteger(crop.width, "Capture crop width");
  positiveInteger(crop.height, "Capture crop height");
  positiveInteger(image.width, "Captured image width");
  positiveInteger(image.height, "Captured image height");

  const scaleX = image.width / crop.width;
  const scaleY = image.height / crop.height;
  const left = (contentInHost.x - crop.x) * scaleX;
  const top = (contentInHost.y - crop.y) * scaleY;
  const right = (contentInHost.x + contentInHost.width - crop.x) * scaleX;
  const bottom = (contentInHost.y + contentInHost.height - crop.y) * scaleY;
  const tolerance = 1.01;
  if (left < -tolerance || top < -tolerance || right > image.width + tolerance || bottom > image.height + tolerance) {
    throw new Error("The captured whole-page tile does not contain its complete logical content.");
  }
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  const clippedRight = Math.min(image.width, right);
  const clippedBottom = Math.min(image.height, bottom);
  if (clippedRight <= x || clippedBottom <= y) throw new Error("The captured whole-page tile is empty.");
  return { x, y, width: clippedRight - x, height: clippedBottom - y };
}

const EPSILON = 1e-9;

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive.`);
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function captureInteger(value: number): number {
  if (value <= EPSILON) return 0;
  return Math.ceil(value - EPSILON);
}

function rasterEdge(logicalEdge: number, logicalLength: number, rasterLength: number): number {
  if (logicalEdge <= EPSILON) return 0;
  if (logicalLength - logicalEdge <= EPSILON) return rasterLength;
  return Math.round(logicalEdge / logicalLength * rasterLength);
}

function normalizedEdge(logicalEdge: number, logicalLength: number): number {
  if (logicalEdge <= EPSILON) return 0;
  if (logicalLength - logicalEdge <= EPSILON) return 1;
  return logicalEdge / logicalLength;
}

function resolvedLimits(overrides: Partial<WholePageCaptureLimits> | undefined): WholePageCaptureLimits {
  const limits = { ...DEFAULT_WHOLE_PAGE_CAPTURE_LIMITS, ...overrides };
  positiveInteger(limits.maxRasterDimension, "Maximum raster dimension");
  positiveInteger(limits.maxRasterArea, "Maximum raster area");
  positiveInteger(limits.maxTileCount, "Maximum tile count");
  return limits;
}

/**
 * Plan row-major captures for one complete logical page.
 *
 * Integration aligns `tile.scroll` with the top-left of `captureViewport`,
 * verifies the live page geometry, calls capturePage(tile.crop), and retains
 * only tile.source. Integer destination edges form an exact partition, while
 * ceil-rounded crop edges may contain at most harmless right/bottom overscan.
 */
export function planWholePageCapture(input: WholePageCapturePlanInput): WholePageCapturePlan {
  const pageWidth = positiveFinite(input.page.width, "Logical page width");
  const pageHeight = positiveFinite(input.page.height, "Logical page height");
  const viewportX = nonNegativeFinite(input.captureViewport.x, "Capture viewport x");
  const viewportY = nonNegativeFinite(input.captureViewport.y, "Capture viewport y");
  const viewportWidth = positiveFinite(input.captureViewport.width, "Capture viewport width");
  const viewportHeight = positiveFinite(input.captureViewport.height, "Capture viewport height");
  const captureScale = positiveFinite(input.captureScale, "Capture scale");
  const targetDensity = positiveFinite(input.targetDensity, "Target density");
  const limits = resolvedLimits(input.limits);

  const rasterWidth = Math.max(1, Math.round(pageWidth * targetDensity));
  const rasterHeight = Math.max(1, Math.round(pageHeight * targetDensity));
  if (!Number.isSafeInteger(rasterWidth) || !Number.isSafeInteger(rasterHeight)) {
    throw new Error("The requested whole-page raster is not representable safely.");
  }
  if (rasterWidth > limits.maxRasterDimension || rasterHeight > limits.maxRasterDimension) {
    throw new Error(
      `The requested whole-page raster ${rasterWidth}x${rasterHeight} exceeds the ${limits.maxRasterDimension}px dimension limit.`
    );
  }
  if (rasterWidth > Math.floor(limits.maxRasterArea / rasterHeight)) {
    throw new Error(
      `The requested whole-page raster ${rasterWidth}x${rasterHeight} exceeds the ${limits.maxRasterArea}-pixel area limit.`
    );
  }

  // capturePage rectangles are integral host CSS pixels. Reserving only the
  // integral part guarantees every planned crop remains inside the viewport.
  const cropX = captureInteger(viewportX);
  const cropY = captureInteger(viewportY);
  const captureWidth = Math.floor(viewportX + viewportWidth + EPSILON) - cropX;
  const captureHeight = Math.floor(viewportY + viewportHeight + EPSILON) - cropY;
  if (captureWidth < 1 || captureHeight < 1) {
    throw new Error("The capture viewport has no integral capturePage area.");
  }
  const logicalTileWidth = captureWidth / captureScale;
  const logicalTileHeight = captureHeight / captureScale;
  const columns = Math.max(1, Math.ceil(pageWidth / logicalTileWidth - EPSILON));
  const rows = Math.max(1, Math.ceil(pageHeight / logicalTileHeight - EPSILON));
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows)) {
    throw new Error("The whole-page tile grid is not representable safely.");
  }
  if (columns > Math.floor(limits.maxTileCount / rows)) {
    throw new Error(`The whole-page capture needs ${columns * rows} tiles, exceeding the ${limits.maxTileCount}-tile limit.`);
  }

  const tiles: WholePageCaptureTile[] = [];
  for (let row = 0; row < rows; row += 1) {
    const logicalTop = Math.min(pageHeight, row * logicalTileHeight);
    const logicalBottom = row === rows - 1
      ? pageHeight
      : Math.min(pageHeight, (row + 1) * logicalTileHeight);
    const destinationTop = rasterEdge(logicalTop, pageHeight, rasterHeight);
    const destinationBottom = rasterEdge(logicalBottom, pageHeight, rasterHeight);
    const normalizedTop = normalizedEdge(logicalTop, pageHeight);
    const normalizedBottom = normalizedEdge(logicalBottom, pageHeight);

    for (let column = 0; column < columns; column += 1) {
      const logicalLeft = Math.min(pageWidth, column * logicalTileWidth);
      const logicalRight = column === columns - 1
        ? pageWidth
        : Math.min(pageWidth, (column + 1) * logicalTileWidth);
      const logicalWidth = logicalRight - logicalLeft;
      const logicalHeight = logicalBottom - logicalTop;
      const destinationLeft = rasterEdge(logicalLeft, pageWidth, rasterWidth);
      const destinationRight = rasterEdge(logicalRight, pageWidth, rasterWidth);
      const normalizedLeft = normalizedEdge(logicalLeft, pageWidth);
      const normalizedRight = normalizedEdge(logicalRight, pageWidth);
      const destinationWidth = destinationRight - destinationLeft;
      const destinationHeight = destinationBottom - destinationTop;
      const cropWidth = captureInteger(logicalWidth * captureScale);
      const cropHeight = captureInteger(logicalHeight * captureScale);
      if (
        destinationWidth <= 0
        || destinationHeight <= 0
        || cropWidth <= 0
        || cropHeight <= 0
        || cropWidth > captureWidth
        || cropHeight > captureHeight
      ) {
        throw new Error("The requested density or viewport produces an invalid whole-page tile.");
      }

      const index = row * columns + column;
      tiles.push({
        id: `r${row}-c${column}`,
        index,
        row,
        column,
        normalized: {
          x: normalizedLeft,
          y: normalizedTop,
          width: normalizedRight - normalizedLeft,
          height: normalizedBottom - normalizedTop
        },
        logical: {
          x: logicalLeft,
          y: logicalTop,
          width: logicalWidth,
          height: logicalHeight
        },
        scroll: { x: logicalLeft, y: logicalTop },
        crop: {
          x: cropX,
          y: cropY,
          width: cropWidth,
          height: cropHeight
        },
        source: { x: 0, y: 0, width: destinationWidth, height: destinationHeight },
        destination: {
          x: destinationLeft,
          y: destinationTop,
          width: destinationWidth,
          height: destinationHeight
        }
      });
    }
  }

  return {
    version: 1,
    logicalPage: { width: pageWidth, height: pageHeight },
    captureViewport: {
      x: viewportX,
      y: viewportY,
      width: viewportWidth,
      height: viewportHeight
    },
    captureScale,
    targetDensity,
    effectiveDensity: {
      width: rasterWidth / pageWidth,
      height: rasterHeight / pageHeight
    },
    raster: { width: rasterWidth, height: rasterHeight },
    grid: { columns, rows },
    limits,
    tiles
  };
}

export type WholePageEncodedTile<TEncoded> = Readonly<{
  tileIndex: number;
  encoded: TEncoded;
  /** Live decoded-image crop; overrides the static top-left planner source. */
  source?: WholePageRect;
}>;

export type WholePageStitchPrimitives<TEncoded, TImage, TSurface, TOutput> = Readonly<{
  createSurface(size: WholePageSize): TSurface | Promise<TSurface>;
  decode(encoded: TEncoded): Promise<TImage>;
  imageSize(image: TImage): WholePageSize;
  draw(
    surface: TSurface,
    image: TImage,
    source: WholePageRect,
    destination: WholePagePixelRect
  ): void | Promise<void>;
  encode(surface: TSurface): Promise<TOutput>;
  releaseImage?(image: TImage): void | Promise<void>;
  releaseSurface?(surface: TSurface): void | Promise<void>;
}>;

/**
 * Stitch captured chunks without depending on Electron or browser globals.
 * A browser integration can inject canvas/createImageBitmap primitives; tests
 * can inject small fakes. Each decoded image is released before the next tile,
 * bounding decoded-image memory to the output surface plus one tile.
 */
export async function stitchWholePageCapture<TEncoded, TImage, TSurface, TOutput>(
  plan: WholePageCapturePlan,
  chunks: readonly WholePageEncodedTile<TEncoded>[],
  primitives: WholePageStitchPrimitives<TEncoded, TImage, TSurface, TOutput>
): Promise<TOutput> {
  const byIndex = new Map<number, WholePageEncodedTile<TEncoded>>();
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(chunk.tileIndex) || chunk.tileIndex < 0 || chunk.tileIndex >= plan.tiles.length) {
      throw new Error(`Unexpected whole-page tile index ${chunk.tileIndex}.`);
    }
    if (byIndex.has(chunk.tileIndex)) throw new Error(`Duplicate whole-page tile index ${chunk.tileIndex}.`);
    byIndex.set(chunk.tileIndex, chunk);
  }
  if (byIndex.size !== plan.tiles.length) {
    const missing = plan.tiles.find((tile) => !byIndex.has(tile.index));
    throw new Error(`Missing whole-page tile ${missing?.index ?? "unknown"}.`);
  }

  const surface = await primitives.createSurface(plan.raster);
  try {
    for (const tile of plan.tiles) {
      if (!byIndex.has(tile.index)) throw new Error(`Missing whole-page tile ${tile.index}.`);
      const chunk = byIndex.get(tile.index) as WholePageEncodedTile<TEncoded>;
      const source = chunk.source ?? tile.source;
      if (
        !Number.isFinite(source.x)
        || !Number.isFinite(source.y)
        || !Number.isFinite(source.width)
        || !Number.isFinite(source.height)
        || source.x < 0
        || source.y < 0
        || source.width <= 0
        || source.height <= 0
      ) {
        throw new Error(`Whole-page tile ${tile.index} has an invalid source rectangle.`);
      }
      const image = await primitives.decode(chunk.encoded);
      try {
        const size = primitives.imageSize(image);
        if (
          !Number.isSafeInteger(size.width)
          || !Number.isSafeInteger(size.height)
          || size.width <= 0
          || size.height <= 0
        ) {
          throw new Error(`Whole-page tile ${tile.index} has invalid decoded image dimensions.`);
        }
        if (
          source.x + source.width > size.width + EPSILON
          || source.y + source.height > size.height + EPSILON
        ) {
          throw new Error(
            `Whole-page tile ${tile.index} source falls outside its ${size.width}x${size.height} decoded image.`
          );
        }
        await primitives.draw(surface, image, source, tile.destination);
      } finally {
        await primitives.releaseImage?.(image);
      }
    }
    return await primitives.encode(surface);
  } finally {
    await primitives.releaseSurface?.(surface);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Require two consecutive compositor captures to agree before accepting a
 * tile. This bounds asynchronous Notability canvas paint churn without ever
 * mixing two different frames into one output tile.
 */
export async function captureStableWholePageTile<T>(
  capture: () => Promise<T>,
  bytes: (value: T) => Uint8Array,
  pause: () => Promise<void>,
  maximumAttempts = 8,
  requiredConsecutiveFrames = 3
): Promise<T> {
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 3 || maximumAttempts > 20) {
    throw new Error("Whole-page tile stability attempts must be an integer from 3 to 20.");
  }
  if (
    !Number.isSafeInteger(requiredConsecutiveFrames)
    || requiredConsecutiveFrames < 3
    || requiredConsecutiveFrames > maximumAttempts
  ) {
    throw new Error("Whole-page tile stability requires at least three consecutive frames within the attempt limit.");
  }
  let previous = await capture();
  let consecutiveFrames = 1;
  for (let attempt = 2; attempt <= maximumAttempts; attempt += 1) {
    await pause();
    const current = await capture();
    consecutiveFrames = sameBytes(bytes(previous), bytes(current))
      ? consecutiveFrames + 1
      : 1;
    previous = current;
  }
  // Deliberately observe the complete bounded window. Returning on the first
  // matching streak can certify several copies of the previous tile before a
  // late virtualized canvas repaint arrives. Only the final streak represents
  // a frame that stayed stable through the end of the paint window.
  if (consecutiveFrames >= requiredConsecutiveFrames) return previous;
  throw new Error("The Notability page tile did not finish rendering before capture.");
}
