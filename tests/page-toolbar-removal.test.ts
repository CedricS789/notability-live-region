import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewerSource = readFileSync(new URL("../src/capture-view.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("the viewer does not create or wire a plugin-owned page toolbar", () => {
  for (const token of [
    "notability-live-region-page-controls",
    "notability-live-region-page-button",
    "notability-live-region-page-indicator",
    "notability-live-region-page-input",
    "notability-live-region-page-count",
    "previousButton",
    "nextButton",
    "pageInput",
    "pageCountEl",
    "movePage(",
    "jumpToInputPage(",
    "navigateToPage("
  ]) {
    assert.equal(viewerSource.includes(token), false, `capture-view.ts must not contain ${token}`);
  }
  assert.doesNotMatch(viewerSource, /Previous Notability page|Next Notability page|Notability page jump/);
  assert.doesNotMatch(styles, /notability-live-region-page-(?:controls|button|indicator|input|count)/);
});

test("page metadata and programmatic page positioning remain internal", () => {
  assert.match(viewerSource, /this\.browseStatePage = snapshot\.page/);
  assert.match(viewerSource, /snapshot\.pageCount !== targetRegion\.expectedPageCount/);
  assert.match(viewerSource, /expectedPageCount: Math\.max\(snapshot\.pageCount, snapshot\.page\)/);
  assert.match(viewerSource, /scrollToPage\(webview, targetRegion\.page\)/);
  assert.match(viewerSource, /async restorePage\(page: number\)/);
  assert.match(viewerSource, /async copyCurrentPageEmbed\(\)/);
});
