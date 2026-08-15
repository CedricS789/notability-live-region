import assert from "node:assert/strict";
import test from "node:test";
import {
  CaptureCancellationGate,
  CaptureCancelledError,
  CaptureSelectionState,
  KeyedLatestRequestGate,
  LatestRequestGate,
  OneShotRegionAlignment,
  canReuseLoadedNote
} from "../src/capture-state";
import { region } from "./fixtures";

test("capture cancellation invalidates only the current operation ticket", () => {
  const gate = new CaptureCancellationGate();
  const first = gate.snapshot();
  assert.equal(gate.isCurrent(first), true);

  gate.cancel();
  assert.equal(gate.isCurrent(first), false);
  assert.throws(() => gate.assertCurrent(first), CaptureCancelledError);

  const second = gate.snapshot();
  assert.equal(gate.isCurrent(second), true);
  gate.assertCurrent(second);
});

test("copying an unchanged draft reuses its first materialized region", () => {
  const state = new CaptureSelectionState();
  const first = region({ id: "nr-first-region" });
  const second = region({ id: "nr-second-region" });

  assert.equal(state.materialize(() => first), first);
  assert.equal(state.materialize(() => second), first);
});

test("a manual drag clears opened metadata and invalidates materialized identity", () => {
  const state = new CaptureSelectionState();
  const opened = region({ id: "nr-opened-region" });
  const replacement = region({ id: "nr-replacement-region" });

  state.open(opened);
  assert.equal(state.openedRegion(), opened);
  assert.equal(state.reusableRegion(), opened);

  state.startManualSelection();
  assert.equal(state.openedRegion(), null);
  assert.equal(state.reusableRegion(), null);
  assert.equal(state.materialize(() => replacement), replacement);
});

test("a cancelled temporary page selection restores its prior opened and reusable identity", () => {
  const state = new CaptureSelectionState();
  const opened = region({ id: "nr-opened-before-page" });
  state.open(opened);
  const snapshot = state.snapshot();

  state.startManualSelection();
  const temporary = region({ id: "nr-temporary-page" });
  assert.equal(state.materialize(() => temporary), temporary);

  state.restore(snapshot);
  assert.equal(state.openedRegion(), opened);
  assert.equal(state.reusableRegion(), opened);
});

test("opening a saved region makes refresh and copy share its existing metadata", () => {
  const state = new CaptureSelectionState();
  const opened = region({ id: "nr-opened-region" });
  state.open(opened);

  assert.equal(state.materialize(() => region({ id: "nr-unused-region" })), opened);
  assert.equal(state.openedRegion(), opened);
});

test("saved-region alignment is one-shot, latest-wins, and manually cancellable", () => {
  const alignment = new OneShotRegionAlignment();
  const first = alignment.arm("nr-first");
  assert.equal(alignment.claim("nr-other"), null);
  assert.equal(alignment.claim("nr-first"), first);
  assert.equal(alignment.claim("nr-first"), null);
  assert.equal(alignment.isCurrent(first), true);

  const second = alignment.arm("nr-second");
  assert.equal(alignment.isCurrent(first), false);
  assert.equal(alignment.claim("nr-second"), second);
  alignment.cancel();
  assert.equal(alignment.isCurrent(second), false);

  const third = alignment.arm("nr-third");
  assert.equal(alignment.claim("nr-third"), third);
  alignment.complete(third);
  assert.equal(alignment.isCurrent(third), false);
});

test("saved-region alignment cancellation and re-arming invalidate every older token", () => {
  const alignment = new OneShotRegionAlignment();

  alignment.arm("nr-before-begin");
  alignment.cancel();
  assert.equal(alignment.claim("nr-before-begin"), null);

  const first = alignment.arm("nr-same");
  assert.equal(alignment.claim("nr-same"), first);
  const replacement = alignment.arm("nr-same");
  assert.equal(alignment.isCurrent(first), false);
  assert.equal(alignment.claim("nr-same"), replacement);

  const other = alignment.arm("nr-other");
  assert.equal(alignment.isCurrent(replacement), false);
  assert.equal(alignment.claim("nr-other"), other);
});

test("only the newest asynchronous navigation request may commit", () => {
  const gate = new LatestRequestGate();
  const first = gate.begin();
  assert.equal(gate.isCurrent(first), true);

  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);

  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
});

test("keyed routing is latest-wins per note without cancelling another note", () => {
  const gate = new KeyedLatestRequestGate();
  const firstA = gate.begin("note-a");
  const firstB = gate.begin("note-b");
  const secondA = gate.begin("note-a");

  assert.equal(gate.isCurrent("note-a", firstA), false);
  assert.equal(gate.isCurrent("note-a", secondA), true);
  assert.equal(gate.isCurrent("note-b", firstB), true);

  gate.finish("note-a", firstA);
  assert.equal(gate.isCurrent("note-a", secondA), true);
  gate.finish("note-a", secondA);
  assert.equal(gate.isCurrent("note-a", secondA), false);
  assert.equal(gate.isCurrent("note-b", firstB), true);
});

test("a displayed note is not reused while an older different-note load can still win", () => {
  assert.equal(canReuseLoadedNote(true, true, true, false), true);
  assert.equal(canReuseLoadedNote(true, true, true, true), false);
  assert.equal(canReuseLoadedNote(true, true, false, false), false);
  assert.equal(canReuseLoadedNote(false, true, true, false), false);
});
