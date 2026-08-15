import type { CapturedNativeImage } from "./webview-types";

export type EncodedPreviewImage = {
  bytes: Uint8Array;
  chosenScale: number;
  availableScales: number[];
  pixelWidth: number;
  pixelHeight: number;
};

function normalizedScales(image: CapturedNativeImage): number[] {
  const values = image.getScaleFactors?.() ?? [1];
  const scales = [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))]
    .sort((left, right) => left - right);
  return scales.length ? scales : [1];
}

/** Preserve the best real NativeImage representation without inventing pixels. */
export function encodeBestPreviewImage(image: CapturedNativeImage, maximumScale = 2): EncodedPreviewImage {
  if (image.isEmpty()) throw new Error("The captured preview is empty.");
  const availableScales = normalizedScales(image);
  const capped = availableScales.filter((scale) => scale <= maximumScale + 0.000001);
  const chosenScale = capped.at(-1);
  if (!chosenScale) {
    throw new Error(`The captured preview has no real image representation at or below ${maximumScale}x.`);
  }
  const size = image.getSize(chosenScale);
  if (
    !Number.isFinite(size.width)
    || !Number.isFinite(size.height)
    || size.width < 1
    || size.height < 1
  ) throw new Error("The captured preview returned invalid pixel dimensions.");
  const bytes = image.toPNG({ scaleFactor: chosenScale });
  if (!bytes.byteLength) throw new Error("The captured preview could not be encoded.");
  return {
    bytes,
    chosenScale,
    availableScales,
    pixelWidth: Math.round(size.width),
    pixelHeight: Math.round(size.height)
  };
}
