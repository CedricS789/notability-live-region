import assert from "node:assert/strict";
import test from "node:test";
import { regionFence } from "../src/model";
import {
  planPortableExport,
  PortableExportConflictError
} from "../src/portable-export";
import { markdownRegionLink } from "../src/url-policy";
import { noteUrl, region } from "./fixtures";

test("portable export replaces only real top-level region fences and preserves all other Markdown bytes", () => {
  const exported = region({
    id: "nr-portable01",
    title: "  Signals [A]\\B\nintroduction  ",
    page: 7
  });
  const hidden = region({ id: "nr-hidden004", title: "Nested example" });
  const linked = region({ id: "nr-linked004", title: "Ordinary live link" });
  const nestedExample = ["````markdown", regionFence(hidden), "````"].join("\r\n");
  const liveLink = markdownRegionLink("keep this link", linked);
  const fence = regionFence(exported).replaceAll("\n", "\r\n");
  const before = `# Exact heading\r\n\r\n${nestedExample}\r\n\r\n${liveLink}\r\n\r\n`;
  const after = "\r\n\r\nTail  \r\n";
  const markdown = `${before}${fence}${after}`;

  const plan = planPortableExport(markdown);

  assert.equal(
    plan.markdown,
    `${before.replace(liveLink, "keep this link")}![Signals \\[A\\]\\\\B introduction, page 7](notability-assets/nr-portable01.png)${after}`
  );
  assert.equal(plan.embedCount, 1);
  assert.deepEqual(plan.assets.map(({ id, path }) => ({ id, path })), [{
    id: exported.id,
    path: "notability-assets/nr-portable01.png"
  }]);
  assert.deepEqual(plan.assets[0]?.region, exported);
});

test("portable export deduplicates assets by identical id while replacing every embed in source order", () => {
  const first = region({ id: "nr-portable02", title: "First", page: 2 });
  const second = region({ id: "nr-portable03", title: "Second", page: 4 });
  const markdown = [regionFence(first), "middle", regionFence(first), regionFence(second)].join("\n\n");

  const plan = planPortableExport(markdown);

  assert.equal(plan.embedCount, 3);
  assert.deepEqual(plan.assets.map((asset) => asset.id), [first.id, second.id]);
  assert.equal(
    plan.markdown,
    [
      "![First, page 2](notability-assets/nr-portable02.png)",
      "middle",
      "![First, page 2](notability-assets/nr-portable02.png)",
      "![Second, page 4](notability-assets/nr-portable03.png)"
    ].join("\n\n")
  );
});

test("portable export treats canonically equivalent metadata as one asset", () => {
  const canonical = region({ id: "nr-portable04", title: "Equivalent" });
  const equivalent = region({
    ...canonical,
    url: `${noteUrl.replace("notability.com", "www.notability.com")}?ignored=1#ignored`
  });

  const plan = planPortableExport(`${regionFence(equivalent)}\n${regionFence(canonical)}`);

  assert.equal(plan.embedCount, 2);
  assert.equal(plan.assets.length, 1);
  assert.equal(plan.assets[0]?.region.url, noteUrl);
});

test("portable export rejects one id with conflicting canonical metadata", () => {
  const first = region({ id: "nr-conflict2", page: 2 });
  const conflict = region({ id: first.id, page: 3 });

  assert.throws(
    () => planPortableExport(`${regionFence(first)}\n\n${regionFence(conflict)}`),
    (error: unknown) => error instanceof PortableExportConflictError
      && error.id === first.id
      && /conflicting canonical metadata/.test(error.message)
  );
});

test("portable Markdown does not retain raw region metadata", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const value = region({
    id: "nr-portable05",
    title: "Safe title",
    fingerprint: { kind: "text-sha256", digest, characters: 12 }
  });

  const plan = planPortableExport(`${regionFence(value)}\n\n${markdownRegionLink("evidence label", value)}`);

  assert.equal(
    plan.markdown,
    "![Safe title, page 3](notability-assets/nr-portable05.png)\n\nevidence label"
  );
  for (const privateSource of [value.url, digest, value.capturedAt, '"fingerprint"', '"rect"', "```notability-region"]) {
    assert.equal(plan.markdown.includes(privateSource), false);
  }
});

test("portable export removes plugin URLs from links even when there are no image assets", () => {
  const hidden = region({ id: "nr-hidden005" });
  const linked = region({ id: "nr-linked005" });
  const markdown = [
    "before",
    markdownRegionLink("live link", linked),
    "````markdown",
    regionFence(hidden),
    "````",
    "```notability-region",
    "{bad}",
    "```",
    "after"
  ].join("\n");

  assert.deepEqual(planPortableExport(markdown), {
    markdown: markdown.replace(markdownRegionLink("live link", linked), "live link"),
    assets: [],
    embedCount: 0
  });
});

test("portable export is a byte-for-byte no-op when no regions are present", () => {
  const markdown = "# Plain note\r\n\r\nNo Notability regions here.\r\n";
  assert.deepEqual(planPortableExport(markdown), { markdown, assets: [], embedCount: 0 });
});

test("portable export supports tilde and longer CommonMark fences", () => {
  const tilde = region({ id: "nr-portable06", title: "Tilde" });
  const longer = region({ id: "nr-portable07", title: "Longer" });
  const markdown = [
    `~~~notability-region\n${JSON.stringify(tilde)}\n~~~`,
    `\`\`\`\`notability-region\n${JSON.stringify(longer)}\n\`\`\`\``
  ].join("\n\n");

  const plan = planPortableExport(markdown);

  assert.equal(plan.embedCount, 2);
  assert.deepEqual(plan.assets.map((asset) => asset.id), [tilde.id, longer.id]);
  assert.equal(
    plan.markdown,
    [
      "![Tilde, page 3](notability-assets/nr-portable06.png)",
      "![Longer, page 3](notability-assets/nr-portable07.png)"
    ].join("\n\n")
  );
});
