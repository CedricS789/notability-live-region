import assert from "node:assert/strict";
import test from "node:test";
import { base64UrlEncode, canonicalRegionJson } from "../src/model";
import {
  INTERNAL_REGION_ACTION,
  MAX_ENCODED_REGION_LENGTH,
  UrlPolicyError,
  compactCanonicalRegionJson,
  defaultRegionLabel,
  extractNoteId,
  isAllowedNotabilityOrigin,
  markdownRegionLink,
  parseInternalRegionMarkdownUrl,
  parseInternalRegionProtocolParams,
  parseLegacyRegionMarkdownUrl,
  parseRegionMarkdownUrl,
  redactUrl,
  regionMarkdownUrl,
  sanitizeNotabilityNoteUrl,
  textSelectionLabel
} from "../src/url-policy";
import { noteUrl, region } from "./fixtures";

function legacyRegionUrl(value = region()): string {
  return `${noteUrl}#obsidian-notability-region=${base64UrlEncode(canonicalRegionJson(value).trimEnd())}`;
}

test("note URL policy emits one canonical HTTPS Notability note URL", () => {
  assert.equal(sanitizeNotabilityNoteUrl(`${noteUrl}/?utm_source=test#page=3`), noteUrl);
  assert.equal(
    sanitizeNotabilityNoteUrl("https://www.NOTABILITY.com/app/note/11111111-2222-4333-8444-555555555555/"),
    noteUrl
  );
  assert.equal(extractNoteId(noteUrl), "11111111-2222-4333-8444-555555555555");
  assert.equal(isAllowedNotabilityOrigin(noteUrl), true);
  for (const value of [
    "http://notability.com/app/note/11111111-2222-4333-8444-555555555555",
    "https://evil.example/app/note/11111111-2222-4333-8444-555555555555",
    "https://notability.com/app",
    "https://user:pass@notability.com/app/note/11111111-2222-4333-8444-555555555555",
    "https://notability.com:444/app/note/11111111-2222-4333-8444-555555555555"
  ]) assert.throws(() => sanitizeNotabilityNoteUrl(value), UrlPolicyError);
});

test("new region URLs are compact self-contained internal Obsidian actions", () => {
  const value = region({ title: "Résumé Δ handwritten" });
  const encoded = regionMarkdownUrl(value);
  assert.ok(encoded.startsWith(`obsidian://${INTERNAL_REGION_ACTION}?region=`));
  assert.doesNotMatch(encoded, /https?:/);
  assert.deepEqual(parseInternalRegionMarkdownUrl(encoded), value);
  assert.deepEqual(parseRegionMarkdownUrl(encoded), value);
  assert.doesNotMatch(compactCanonicalRegionJson(value), /\n/);

  const withNonCanonicalNestedUrl = region({ url: `${noteUrl}/?tracking=1#page=2` });
  assert.deepEqual(parseRegionMarkdownUrl(regionMarkdownUrl(withNonCanonicalNestedUrl)), region());
});

test("internal parser rejects tampering, alternate actions, paths, credentials, ports, fragments, and extra parameters", () => {
  const encoded = regionMarkdownUrl(region());
  const payload = encoded.slice(encoded.indexOf("region=") + "region=".length);
  const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
  for (const candidate of [
    `obsidian://other-action?region=${payload}`,
    `obsidian://NOTABILITY-LIVE-REGION?region=${payload}`,
    `obsidian://${INTERNAL_REGION_ACTION}/open?region=${payload}`,
    `obsidian://user@${INTERNAL_REGION_ACTION}?region=${payload}`,
    `obsidian://${INTERNAL_REGION_ACTION}:99?region=${payload}`,
    `${encoded}#fragment`,
    `${encoded}&extra=1`,
    `${encoded}&region=${payload}`,
    `obsidian://${INTERNAL_REGION_ACTION}?other=${payload}`,
    `obsidian://${INTERNAL_REGION_ACTION}?region=%${(payload.charCodeAt(0)).toString(16)}${payload.slice(1)}`,
    `obsidian://${INTERNAL_REGION_ACTION}?region=${payload}=`,
    `obsidian://${INTERNAL_REGION_ACTION}?region=${tamperedPayload}`,
    `obsidian://${INTERNAL_REGION_ACTION}?region=${"A".repeat(MAX_ENCODED_REGION_LENGTH + 1)}`
  ]) assert.equal(parseInternalRegionMarkdownUrl(candidate), null, candidate.slice(0, 100));
  assert.throws(() => regionMarkdownUrl(region({ title: "x".repeat(10_000) })), UrlPolicyError);
});

test("internal parser requires canonical compact validated JSON and a canonical nested note URL", () => {
  const value = region();
  const { title, ...rest } = value;
  const prettyPayload = base64UrlEncode(canonicalRegionJson(value).trimEnd());
  const reorderedPayload = base64UrlEncode(JSON.stringify({ title, ...rest }));
  const nonCanonicalUrlPayload = base64UrlEncode(JSON.stringify({ ...value, url: `${value.url}/` }));
  const extraFieldPayload = base64UrlEncode(JSON.stringify({ ...value, extra: true }));
  for (const payload of [prettyPayload, reorderedPayload, nonCanonicalUrlPayload, extraFieldPayload]) {
    assert.equal(parseInternalRegionMarkdownUrl(`obsidian://${INTERNAL_REGION_ACTION}?region=${payload}`), null);
  }
});

test("Obsidian protocol callback parameters accept only the exact internal action payload", () => {
  const encoded = regionMarkdownUrl(region());
  const payload = encoded.slice(encoded.indexOf("region=") + "region=".length);
  assert.deepEqual(parseInternalRegionProtocolParams({ action: INTERNAL_REGION_ACTION, region: payload }), region());
  assert.deepEqual(parseInternalRegionProtocolParams({ region: payload }), region());
  assert.equal(parseInternalRegionProtocolParams({ action: "other", region: payload }), null);
  assert.equal(parseInternalRegionProtocolParams({ action: INTERNAL_REGION_ACTION, region: payload, extra: "1" }), null);
  assert.equal(parseInternalRegionProtocolParams({ action: INTERNAL_REGION_ACTION, region: `${payload}=` }), null);
});

test("strict legacy parser keeps old HTTPS artifacts readable but they are never generated", () => {
  const legacy = legacyRegionUrl();
  assert.deepEqual(parseLegacyRegionMarkdownUrl(legacy), region());
  assert.deepEqual(parseRegionMarkdownUrl(legacy), region());
  assert.equal(regionMarkdownUrl(region()).startsWith("https:"), false);

  const otherNote = legacy.replace(
    "11111111-2222-4333-8444-555555555555",
    "11111111-1111-1111-1111-111111111111"
  );
  for (const candidate of [
    otherNote,
    legacy.replace("https://notability.com", "https://www.notability.com"),
    legacy.replace("#", "?extra=1#"),
    `${legacy}&extra=1`,
    noteUrl
  ]) assert.equal(parseLegacyRegionMarkdownUrl(candidate), null);
});

test("Markdown labels use a clean title fallback and safely normalize selected text", () => {
  assert.equal(defaultRegionLabel(region()), "1 - Chapter_CMOSbasics2, p. 3");
  assert.equal(defaultRegionLabel(region({ title: " \n\t " })), "Notability note, p. 3");
  assert.match(
    markdownRegionLink("Gate ] voltage\nproof", region()),
    /^\[Gate \\] voltage proof\]\(obsidian:\/\//
  );
  assert.ok(markdownRegionLink("Gate \\] [ voltage\r\nproof", region()).startsWith(String.raw`[Gate \\\] \[ voltage proof](`));
  assert.match(markdownRegionLink(" ", region()), /^\[1 - Chapter_CMOSbasics2, p\. 3\]/);
});

test("URL redaction keeps origin and path but removes query and fragment", () => {
  assert.equal(redactUrl(`${noteUrl}?secret=1#private`), noteUrl);
  assert.equal(redactUrl("not a URL"), "[invalid URL]");
});

test("PDF text fallback labels collapse whitespace and stop at 160 Unicode characters", () => {
  assert.equal(textSelectionLabel("  drain\n current\t equation "), "drain current equation");
  assert.equal([...textSelectionLabel("Î©".repeat(200))].length, 160);
  assert.equal(textSelectionLabel("   "), "");
});
