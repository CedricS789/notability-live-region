import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRegionPasteReplacement,
  embedInsertion,
  embedInsertionAtRange,
  findRegionFenceAtOffset,
  findRegionLinkAtOffset,
  parseEntireCopiedRegionLink,
  parseStandaloneRegionFence,
  replaceFence
} from "../src/editor-format";
import { base64UrlEncode, canonicalRegionJson, regionFence } from "../src/model";
import { markdownRegionLink } from "../src/url-policy";
import { noteUrl, region } from "./fixtures";

function legacyLink(label = "legacy"): string {
  const value = region();
  const url = `${noteUrl}#obsidian-notability-region=${base64UrlEncode(canonicalRegionJson(value).trimEnd())}`;
  return `[${label}](${url})`;
}

test("region fence lookup is half-open, position-aware, and replaceable", () => {
  const original = region();
  const fence = regionFence(original);
  const doc = `before\n\n${fence}\n\nafter`;
  assert.equal(findRegionFenceAtOffset(doc, 0), null);
  const found = findRegionFenceAtOffset(doc, doc.indexOf(original.title));
  assert.deepEqual(found?.region, original);
  assert.ok(found);
  assert.deepEqual(findRegionFenceAtOffset(doc, found.range.to - 1)?.region, original);
  assert.equal(findRegionFenceAtOffset(doc, found.range.to), null);
  const changed = region({ page: 4 });
  assert.match(replaceFence(doc, found.range, changed), /"page": 4/);
});

test("malformed fence fails closed and does not mask later prose", () => {
  const doc = "```notability-region\n{bad}\n```\nnormal";
  assert.equal(findRegionFenceAtOffset(doc, 10), null);
  assert.equal(findRegionFenceAtOffset(doc, doc.length - 1), null);
});

test("region link lookup recognizes internal and strict legacy links with half-open cursor ranges", () => {
  for (const link of [markdownRegionLink("threshold", region()), legacyLink()]) {
    const doc = `x ${link} y`;
    const from = doc.indexOf(link);
    const to = from + link.length;
    assert.equal(findRegionLinkAtOffset(doc, from - 1), null);
    assert.deepEqual(findRegionLinkAtOffset(doc, from)?.region, region());
    assert.deepEqual(findRegionLinkAtOffset(doc, to - 1)?.region, region());
    assert.equal(findRegionLinkAtOffset(doc, to), null);
  }
});

test("entire copied-link parser decodes escaped and Unicode labels without accepting surrounding prose", () => {
  const link = markdownRegionLink("Résumé [gate] \\ proof", region());
  assert.deepEqual(parseEntireCopiedRegionLink(`\r\n${link}\n`)?.label, "Résumé [gate] \\ proof");
  assert.deepEqual(parseEntireCopiedRegionLink(link)?.region, region());
  assert.equal(parseEntireCopiedRegionLink(`prefix ${link}`), null);
  assert.equal(parseEntireCopiedRegionLink(`${link} suffix`), null);
  assert.equal(parseEntireCopiedRegionLink("https://notability.com"), null);
});

test("standalone embed parser accepts one valid fence and rejects mixed clipboard content", () => {
  const fence = regionFence(region());
  assert.deepEqual(parseStandaloneRegionFence(fence), region());
  assert.deepEqual(parseStandaloneRegionFence(`\r\n${fence.replaceAll("\n", "\r\n")}\r\n`), region());
  assert.equal(parseStandaloneRegionFence(`context\n${fence}`), null);
  assert.equal(parseStandaloneRegionFence("```notability-region\n{bad}\n```"), null);
});

test("link paste applies the selected Markdown label and otherwise keeps the copied default", () => {
  const copied = markdownRegionLink("", region());
  const selected = "Gate\n[voltage]";
  const document = `before ${selected} after`;
  const from = document.indexOf(selected);
  const replacement = buildRegionPasteReplacement(
    document,
    { from, to: from + selected.length },
    selected,
    copied
  );
  assert.ok(replacement);
  assert.equal(parseEntireCopiedRegionLink(replacement)?.label, "Gate [voltage]");
  assert.deepEqual(parseEntireCopiedRegionLink(replacement)?.region, region());

  const atCursor = buildRegionPasteReplacement("before", { from: 6, to: 6 }, "", copied);
  assert.equal(parseEntireCopiedRegionLink(atCursor ?? "")?.label, "1 - Chapter_CMOSbasics2, p. 3");
});

test("unrelated, malformed, or stale paste payloads return null so normal paste remains untouched", () => {
  const copied = markdownRegionLink("default", region());
  assert.equal(buildRegionPasteReplacement("abc", { from: 1, to: 1 }, "", "ordinary text"), null);
  assert.equal(buildRegionPasteReplacement("abc", { from: 1, to: 2 }, "wrong", copied), null);
  assert.equal(buildRegionPasteReplacement("abc", { from: -1, to: 0 }, "", copied), null);
  assert.equal(buildRegionPasteReplacement("abc", { from: 1, to: 1 }, "", `${copied} extra`), null);
});

test("embed paste preserves selected reasoning and valid block boundaries", () => {
  assert.equal(embedInsertion("", region()), regionFence(region()));
  assert.equal(embedInsertion("My typed reasoning", region()), `My typed reasoning\n\n${regionFence(region())}`);

  const doc = "before\nselected\nafter";
  const from = doc.indexOf("selected");
  const expected = embedInsertionAtRange(doc, { from, to: from + "selected".length }, "selected", region());
  assert.equal(
    buildRegionPasteReplacement(doc, { from, to: from + "selected".length }, "selected", regionFence(region())),
    expected
  );
  assert.equal(
    `${doc.slice(0, from)}${expected}${doc.slice(from + "selected".length)}`,
    `before\n\nselected\n\n${regionFence(region())}\n\nafter`
  );
});

test("embed insertion creates valid block boundaries at an inline cursor", () => {
  const doc = "before after";
  const insertion = embedInsertionAtRange(doc, { from: 6, to: 6 }, "", region());
  assert.equal(`${doc.slice(0, 6)}${insertion}${doc.slice(6)}`, `before\n\n${regionFence(region())}\n\n after`);
});
