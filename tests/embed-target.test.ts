import assert from "node:assert/strict";
import test from "node:test";
import { chooseEmbedInsertionTarget } from "../src/embed-target";

type Leaf = { id: string; editable: boolean };

const leaf = (id: string, editable = true): Leaf => ({ id, editable });
const choose = (
  liveLeaves: readonly Leaf[],
  requestedLeaf: Leaf | null
) => chooseEmbedInsertionTarget({
  liveLeaves,
  requestedLeaf,
  isEditable: (candidate) => candidate.editable
});

test("an exact live editable Markdown target is retained", () => {
  const requested = leaf("requested");
  const other = leaf("other");
  assert.equal(choose([requested, other], requested), requested);
});

test("a live non-editable Markdown view cannot receive an embed", () => {
  const reading = leaf("reading", false);
  assert.equal(choose([reading], reading), null);
});

test("a detached target never redirects to another live note", () => {
  const other = leaf("other");
  const closed = leaf("closed");
  assert.equal(choose([other], closed), null);
});

test("restored viewers remain unbound until an editable Markdown target exists", () => {
  assert.equal(choose([], null), null);
});
