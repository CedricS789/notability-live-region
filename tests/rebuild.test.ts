import assert from "node:assert/strict";
import test from "node:test";
import { scanMarkdownRegions } from "../src/rebuild";
import { base64UrlEncode, canonicalRegionJson, regionFence } from "../src/model";
import { markdownRegionLink } from "../src/url-policy";
import { noteUrl, region } from "./fixtures";

test("Markdown scanning finds internal and legacy links plus region fences without mutation", () => {
  const linked = region({ id: "nr-linked001", page: 2 });
  const embedded = region({ id: "nr-embedded1", page: 4 });
  const legacy = `${noteUrl}#obsidian-notability-region=${base64UrlEncode(canonicalRegionJson(linked).trimEnd())}`;
  const markdown = [
    "before",
    markdownRegionLink("linked", linked),
    regionFence(embedded),
    `[legacy](${legacy})`,
    "```notability-region\n{bad}\n```",
    "after"
  ].join("\n\n");
  const original = `${markdown}`;

  const found = scanMarkdownRegions(markdown, "notes/a.md");

  assert.equal(markdown, original);
  assert.deepEqual(found.map((item) => [item.kind, item.region.id, item.sourcePath]), [
    ["link", linked.id, "notes/a.md"],
    ["fence", embedded.id, "notes/a.md"],
    ["link", linked.id, "notes/a.md"]
  ]);
  assert.ok(found[0] && found[1] && found[2] && found[0].to <= found[1].from && found[1].to <= found[2].from);
});

test("Markdown scanning rejects malformed legacy and ordinary HTTPS links", () => {
  const value = region({ id: "nr-legacy002" });
  const legacy = `${noteUrl}#obsidian-notability-region=${base64UrlEncode(canonicalRegionJson(value).trimEnd())}`;
  const markdown = [
    `[ordinary](${noteUrl})`,
    "[external](https://example.com/reference)",
    `[wrong host](${legacy.replace("notability.com", "www.notability.com")})`,
    `[extra query](${legacy.replace("#", "?extra=1#")})`,
    `[extra fragment field](${legacy}&extra=1)`,
    `[mismatched note](${legacy.replace("11111111-2222-4333-8444-555555555555", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")})`
  ].join("\n");

  assert.deepEqual(scanMarkdownRegions(markdown, "notes/unrelated.md"), []);
});

test("Markdown scanning ignores internal links inside arbitrary fenced code", () => {
  const linked = region({ id: "nr-visible01" });
  const hidden = region({ id: "nr-hidden001" });
  const markdown = [
    "```markdown",
    markdownRegionLink("example only", hidden),
    "```",
    "",
    "~~~~text",
    markdownRegionLink("also hidden", hidden),
    "~~~~",
    "",
    markdownRegionLink("visible", linked)
  ].join("\n");

  assert.deepEqual(scanMarkdownRegions(markdown, "notes/fences.md").map((item) => item.region.id), [linked.id]);
});

test("Markdown scanning ignores legacy links inside closed or unclosed fenced code", () => {
  const hidden = region({ id: "nr-hidden003" });
  const visible = region({ id: "nr-visible03" });
  const hiddenLegacy = `${noteUrl}#obsidian-notability-region=${base64UrlEncode(canonicalRegionJson(hidden).trimEnd())}`;
  const visibleLegacy = `${noteUrl}#obsidian-notability-region=${base64UrlEncode(canonicalRegionJson(visible).trimEnd())}`;
  const markdown = [
    "```markdown",
    `[closed](${hiddenLegacy})`,
    "```",
    `[visible](${visibleLegacy})`,
    "~~~text",
    `[unclosed](${hiddenLegacy})`
  ].join("\n");

  assert.deepEqual(scanMarkdownRegions(markdown, "notes/legacy-fences.md").map((item) => item.region.id), [visible.id]);
});

test("Markdown scanning ignores nested region examples inside a larger fence", () => {
  const hidden = region({ id: "nr-hidden002" });
  const visible = region({ id: "nr-visible02" });
  const markdown = [
    "````markdown",
    regionFence(hidden),
    "````",
    "",
    regionFence(visible)
  ].join("\n");

  assert.deepEqual(scanMarkdownRegions(markdown, "notes/nested-fence.md").map((item) => item.region.id), [visible.id]);
});

test("Markdown scanning keeps only the visible duplicate after a code example", () => {
  const linked = region({ id: "nr-code0001", page: 2 });
  const literal = markdownRegionLink("example", linked);
  const markdown = ["```markdown", literal, "```", literal].join("\n");
  const found = scanMarkdownRegions(markdown, "notes/code.md");

  assert.equal(found.length, 1);
  assert.equal(found[0]?.from, markdown.lastIndexOf(literal));
});
