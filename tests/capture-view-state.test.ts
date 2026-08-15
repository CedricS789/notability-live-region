import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCaptureViewState,
  CAPTURE_VIEW_STATE_VERSION,
  OpenedRegionModeState,
  parseCaptureViewState
} from "../src/view-state";
import { noteUrl, region } from "./fixtures";

test("v2 view state restores canonical URL, page, mode, title, and opened region", () => {
  const opened = region();
  assert.deepEqual(parseCaptureViewState({
    v: CAPTURE_VIEW_STATE_VERSION,
    url: `https://www.notability.com/app/note/${noteUrl.split("/").at(-1)?.toUpperCase()}/`,
    title: "  CMOS notes  ",
    page: 4,
    mode: "area",
    region: opened
  }), {
    url: noteUrl,
    title: "CMOS notes",
    page: 4,
    mode: "area",
    region: opened
  });
});

test("legacy url-only state remains readable as browse mode", () => {
  assert.deepEqual(parseCaptureViewState({ url: noteUrl }), {
    url: noteUrl,
    title: null,
    page: null,
    mode: "browse",
    region: null
  });
});

test("blank v2 state is valid and contains no transient selection data", () => {
  assert.deepEqual(parseCaptureViewState({ v: 2, mode: "text" }), {
    url: null,
    title: null,
    page: null,
    mode: "text",
    region: null
  });
});

test("view state rejects invalid versions, modes, pages, regions, and cross-note state", () => {
  const otherUrl = "https://notability.com/app/note/11111111-2222-3333-4444-555555555555";
  assert.equal(parseCaptureViewState({ v: 1, url: noteUrl, mode: "browse" }), null);
  assert.equal(parseCaptureViewState({ v: 2, url: noteUrl, mode: "select" }), null);
  assert.equal(parseCaptureViewState({ v: 2, url: noteUrl, page: 0, mode: "browse" }), null);
  assert.equal(parseCaptureViewState({ v: 2, url: noteUrl, mode: "area", region: { ...region(), page: 0 } }), null);
  assert.equal(parseCaptureViewState({ v: 2, url: otherUrl, mode: "area", region: region() }), null);
  assert.doesNotThrow(() => parseCaptureViewState({
    v: 2,
    mode: "area",
    region: region({ url: "https://evil.example/note" })
  }));
  assert.equal(parseCaptureViewState({
    v: 2,
    mode: "area",
    region: region({ url: "https://evil.example/note" })
  }), null);
});

test("unknown and raw-text fields are ignored rather than persisted by the parsed state", () => {
  const parsed = parseCaptureViewState({
    v: 2,
    url: noteUrl,
    page: 2,
    mode: "text",
    selectedText: "secret raw selection",
    pendingNavigation: { request: 42 }
  });
  assert.deepEqual(parsed, {
    url: noteUrl,
    title: null,
    page: 2,
    mode: "text",
    region: null
  });
  assert.equal(JSON.stringify(parsed).includes("secret raw selection"), false);
});

test("v2 serialization emits only durable per-leaf fields", () => {
  const opened = region();
  const state = buildCaptureViewState({
    url: noteUrl,
    title: "CMOS notes",
    page: 3,
    mode: "area",
    region: opened
  });
  assert.deepEqual(Object.keys(state).sort(), ["mode", "page", "region", "title", "url", "v"]);
  assert.deepEqual(state, {
    v: 2,
    url: noteUrl,
    title: "CMOS notes",
    page: 3,
    mode: "area",
    region: opened
  });
  assert.equal(JSON.stringify(state).includes("selectedText"), false);
  assert.equal(JSON.stringify(state).includes("pendingNavigation"), false);
});

test("an opened region keeps its restored mode across repeated alignment events", () => {
  const mode = new OpenedRegionModeState();
  mode.open("text");
  assert.equal(mode.current(), "text");
  assert.equal(mode.current(), "text");

  mode.open("browse");
  assert.equal(mode.current(), "browse");
  mode.clear();
  assert.equal(mode.current(), "area");
  mode.open();
  assert.equal(mode.current(), "area");
});
