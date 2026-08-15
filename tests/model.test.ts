import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_PAGE_RECT,
  RegionValidationError,
  base64UrlDecode,
  base64UrlEncode,
  canonicalRegionJson,
  isFullPageRect,
  parseRegionJson,
  regionFence,
  textSelectionFingerprint,
  validateNormalizedRect,
  validateRegion
} from "../src/model";
import { region } from "./fixtures";

test("region metadata round-trips through canonical JSON and fenced Markdown", () => {
  const value = region();
  assert.deepEqual(parseRegionJson(canonicalRegionJson(value)), value);
  assert.match(regionFence(value), /^```notability-region\n/);
  assert.match(regionFence(value), /\n```$/);
});

test("normalized rectangle validation fails closed at every boundary", () => {
  assert.deepEqual(validateNormalizedRect({ x: 0, y: 0, width: 1, height: 1 }), { x: 0, y: 0, width: 1, height: 1 });
  for (const rect of [
    { x: -0.1, y: 0, width: 0.2, height: 0.2 },
    { x: 0, y: 0, width: 0, height: 0.2 },
    { x: 0.9, y: 0, width: 0.2, height: 0.2 },
    { x: 0, y: 0.9, width: 0.2, height: 0.2 },
    { x: Number.NaN, y: 0, width: 0.2, height: 0.2 }
  ]) assert.throws(() => validateNormalizedRect(rect), RegionValidationError);
});

test("a complete logical page uses the existing V1 normalized rectangle", () => {
  const value = region({ rect: { ...FULL_PAGE_RECT }, fingerprint: { kind: "none" } });
  assert.equal(isFullPageRect(value.rect), true);
  assert.equal(isFullPageRect({ x: 0, y: 0, width: 1, height: 0.999 }), false);
  assert.deepEqual(parseRegionJson(canonicalRegionJson(value)), value);
  assert.match(regionFence(value), /"width": 1/);
});

test("region validator rejects unsupported versions, page drift, and malformed fingerprints", () => {
  assert.throws(() => validateRegion({ ...region(), v: 2 }), /Unsupported region version/);
  assert.throws(() => validateRegion(region({ page: 32, expectedPageCount: 31 })), /outside/);
  assert.throws(() => validateRegion(region({ fingerprint: { kind: "text-sha256", digest: "sha256:no", characters: 1 } })), /SHA-256/);
  assert.throws(() => validateRegion(region({ pageAspect: 0 })), /positive/);
});

test("base64url helpers preserve Unicode without unsafe URL characters", () => {
  const source = "MOSFET — Étude";
  const encoded = base64UrlEncode(source);
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.equal(base64UrlDecode(encoded), source);
});

test("PDF text fingerprints normalize whitespace without retaining source text", () => {
  const first = textSelectionFingerprint("  threshold\n voltage  ");
  const second = textSelectionFingerprint("threshold voltage");
  assert.deepEqual(first, second);
  assert.equal(first.kind, "text-sha256");
  if (first.kind === "text-sha256") {
    assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.characters, 17);
    assert.doesNotMatch(JSON.stringify(first), /threshold|voltage/);
  }
  assert.deepEqual(textSelectionFingerprint(" \n\t "), { kind: "none" });
});
