import { embedInsertionAtRange, parseStandaloneRegionFence } from "./editor-format";

export type EmbedInsertionPosition = { line: number; ch: number };
export type EmbedInsertionSelection = {
  anchor: EmbedInsertionPosition;
  head: EmbedInsertionPosition;
};
export type EmbedInsertionChange = {
  from: EmbedInsertionPosition;
  to: EmbedInsertionPosition;
  text: string;
};

export interface EmbedInsertionAdapter {
  isCurrent(): boolean;
  document(): string;
  selections(): readonly EmbedInsertionSelection[];
  offset(position: EmbedInsertionPosition): number;
  selectedText(from: EmbedInsertionPosition, to: EmbedInsertionPosition): string;
  transact(changes: readonly EmbedInsertionChange[]): void;
}

export interface PreparedEmbedInsertion {
  /** One-shot guarded commit. False means the clipboard must be used instead. */
  commit(markdown: string): boolean;
}

function clonePosition(position: EmbedInsertionPosition): EmbedInsertionPosition {
  return { line: position.line, ch: position.ch };
}

function cloneSelection(selection: EmbedInsertionSelection): EmbedInsertionSelection {
  return { anchor: clonePosition(selection.anchor), head: clonePosition(selection.head) };
}

function samePosition(left: EmbedInsertionPosition, right: EmbedInsertionPosition): boolean {
  return left.line === right.line && left.ch === right.ch;
}

function sameSelections(
  left: readonly EmbedInsertionSelection[],
  right: readonly EmbedInsertionSelection[]
): boolean {
  return left.length === right.length && left.every((selection, index) => {
    const other = right[index];
    return Boolean(other)
      && samePosition(selection.anchor, other!.anchor)
      && samePosition(selection.head, other!.head);
  });
}

function orderedRange(selection: EmbedInsertionSelection): {
  from: EmbedInsertionPosition;
  to: EmbedInsertionPosition;
} {
  const before = selection.anchor.line < selection.head.line
    || (selection.anchor.line === selection.head.line && selection.anchor.ch <= selection.head.ch);
  return before
    ? { from: selection.anchor, to: selection.head }
    : { from: selection.head, to: selection.anchor };
}

/**
 * Snapshot an exact Markdown insertion target before a potentially long
 * capture. Commit is one-shot and fails closed when the view, document, or any
 * selection changed. The caller keeps the clipboard as the recovery path.
 */
export function prepareGuardedEmbedInsertion(adapter: EmbedInsertionAdapter): PreparedEmbedInsertion | null {
  if (!adapter.isCurrent()) return null;
  const document = adapter.document();
  const selections = adapter.selections().map(cloneSelection);
  if (selections.length === 0) return null;
  let consumed = false;

  return {
    commit(markdown: string): boolean {
      if (consumed) return false;
      consumed = true;
      if (!adapter.isCurrent() || adapter.document() !== document) return false;
      if (!sameSelections(selections, adapter.selections())) return false;
      const region = parseStandaloneRegionFence(markdown);
      if (!region) return false;

      const changes: EmbedInsertionChange[] = [];
      for (const selection of selections) {
        const range = orderedRange(selection);
        const fromOffset = adapter.offset(range.from);
        const toOffset = adapter.offset(range.to);
        const selectedText = adapter.selectedText(range.from, range.to);
        if (document.slice(fromOffset, toOffset) !== selectedText) return false;
        const replacement = embedInsertionAtRange(
          document,
          { from: fromOffset, to: toOffset },
          selectedText,
          region
        );
        changes.push({
          from: clonePosition(range.from),
          to: clonePosition(range.to),
          text: replacement
        });
      }
      adapter.transact(changes);
      return true;
    }
  };
}
