import assert from "node:assert/strict";
import test from "node:test";
import { prepareGuardedEmbedInsertion, type EmbedInsertionSelection } from "../src/embed-insertion";
import { regionFence } from "../src/model";
import { markdownRegionLink } from "../src/url-policy";
import { region } from "./fixtures";

function offset(document: string, position: { line: number; ch: number }): number {
  const lines = document.split("\n");
  let value = 0;
  for (let line = 0; line < position.line; line += 1) value += (lines[line]?.length ?? 0) + 1;
  return value + position.ch;
}

function harness(document: string, selections: EmbedInsertionSelection[]) {
  let current = true;
  let currentDocument = document;
  let currentSelections = selections.map((selection) => ({
    anchor: { ...selection.anchor },
    head: { ...selection.head }
  }));
  const transactions: unknown[][] = [];
  const adapter = {
    isCurrent: () => current,
    document: () => currentDocument,
    selections: () => currentSelections,
    offset: (position: { line: number; ch: number }) => offset(currentDocument, position),
    selectedText: (from: { line: number; ch: number }, to: { line: number; ch: number }) => (
      currentDocument.slice(offset(currentDocument, from), offset(currentDocument, to))
    ),
    transact: (changes: readonly unknown[]) => transactions.push([...changes])
  };
  return {
    adapter,
    transactions,
    setCurrent: (value: boolean) => { current = value; },
    setDocument: (value: string) => { currentDocument = value; },
    setSelections: (value: EmbedInsertionSelection[]) => { currentSelections = value; }
  };
}

test("guarded auto-insert preserves selected reasoning and commits one editor transaction", () => {
  const fixture = harness("alpha target words omega", [{
    anchor: { line: 0, ch: 6 },
    head: { line: 0, ch: 18 }
  }]);
  const prepared = prepareGuardedEmbedInsertion(fixture.adapter);
  assert.ok(prepared);
  assert.equal(prepared.commit(regionFence(region())), true);
  assert.equal(fixture.transactions.length, 1);
  const changes = fixture.transactions[0] as Array<{ text: string }>;
  assert.equal(changes.length, 1);
  assert.match(changes[0]!.text, /^\n\ntarget words\n\n```notability-region\n/);
  assert.equal(prepared.commit(regionFence(region())), false, "a capture ticket cannot write twice");
  assert.equal(fixture.transactions.length, 1);
});

test("guarded auto-insert fails closed when its leaf, document, or selections changed", () => {
  const selection = [{ anchor: { line: 0, ch: 5 }, head: { line: 0, ch: 5 } }];
  const staleLeaf = harness("alpha", selection);
  const staleLeafTicket = prepareGuardedEmbedInsertion(staleLeaf.adapter)!;
  staleLeaf.setCurrent(false);
  assert.equal(staleLeafTicket.commit(regionFence(region())), false);
  assert.equal(staleLeaf.transactions.length, 0);

  const staleDocument = harness("alpha", selection);
  const staleDocumentTicket = prepareGuardedEmbedInsertion(staleDocument.adapter)!;
  staleDocument.setDocument("alpha changed");
  assert.equal(staleDocumentTicket.commit(regionFence(region())), false);
  assert.equal(staleDocument.transactions.length, 0);

  const staleSelection = harness("alpha", selection);
  const staleSelectionTicket = prepareGuardedEmbedInsertion(staleSelection.adapter)!;
  staleSelection.setSelections([{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }]);
  assert.equal(staleSelectionTicket.commit(regionFence(region())), false);
  assert.equal(staleSelection.transactions.length, 0);
});

test("guarded auto-insert handles multiple cursors atomically and rejects non-embed payloads", () => {
  const fixture = harness("one\ntwo", [
    { anchor: { line: 0, ch: 3 }, head: { line: 0, ch: 3 } },
    { anchor: { line: 1, ch: 3 }, head: { line: 1, ch: 3 } }
  ]);
  const prepared = prepareGuardedEmbedInsertion(fixture.adapter)!;
  assert.equal(prepared.commit(regionFence(region())), true);
  assert.equal(fixture.transactions.length, 1);
  assert.equal(fixture.transactions[0]!.length, 2);

  const invalid = harness("one", [{ anchor: { line: 0, ch: 3 }, head: { line: 0, ch: 3 } }]);
  assert.equal(
    prepareGuardedEmbedInsertion(invalid.adapter)!.commit(markdownRegionLink("Fixture", region())),
    false,
    "an embed-only delivery ticket must reject a valid region link"
  );
  assert.equal(invalid.transactions.length, 0);
});
