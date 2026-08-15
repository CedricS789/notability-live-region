import { EditorSelection, Prec, Transaction, type Extension, type SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildRegionPasteReplacement } from "./editor-format";
import { buildAtomicPasteChanges } from "./viewer-leaf";

type OffsetSelection = Pick<SelectionRange, "from" | "to">;

export type CodeMirrorRegionPaste = {
  changes: readonly { from: number; to: number; text: string }[];
};

/** Keep the workspace hook as a non-CodeMirror fallback without replaying a handled DOM paste. */
export function shouldHandleWorkspaceRegionPaste(
  event: ClipboardEvent,
  codeMirrorPasteEvents: WeakSet<ClipboardEvent>
): boolean {
  return !event.defaultPrevented && !codeMirrorPasteEvents.has(event);
}

function clipboardPlainText(event: ClipboardEvent): string | null {
  try {
    return event.clipboardData?.getData("text/plain") || null;
  } catch {
    return null;
  }
}

/**
 * Build the complete replacement set before dispatching anything. A malformed
 * payload or stale selection therefore leaves every selection untouched.
 */
export function buildCodeMirrorRegionPaste(
  document: string,
  selections: readonly OffsetSelection[],
  clipboardText: string
): CodeMirrorRegionPaste | null {
  const changes = buildAtomicPasteChanges(
    selections,
    ({ from, to }) => ({ from, to }),
    ({ from, to }) => buildRegionPasteReplacement(
      document,
      { from, to },
      document.slice(from, to),
      clipboardText
    )
  );
  return changes ? { changes } : null;
}

/**
 * Install ahead of Obsidian's workspace paste bridge. This is deliberately
 * scoped to complete, valid Notability link/embed payloads; all other paste
 * events continue through CodeMirror and other plugins normally.
 */
export function notabilityRegionPasteExtension(
  onHandled?: (event: ClipboardEvent) => void
): Extension {
  return Prec.highest(EditorView.domEventHandlers({
    paste(event, view): boolean {
      const clipboardText = clipboardPlainText(event);
      if (!clipboardText) return false;
      const prepared = buildCodeMirrorRegionPaste(
        view.state.doc.toString(),
        view.state.selection.ranges,
        clipboardText
      );
      if (!prepared) return false;

      let index = 0;
      const atomic = view.state.changeByRange((range) => {
        const change = prepared.changes[index];
        index += 1;
        if (!change) throw new Error("Notability paste selection changed before dispatch.");
        return {
          changes: { from: change.from, to: change.to, insert: change.text },
          range: EditorSelection.cursor(change.from + change.text.length)
        };
      });
      view.dispatch({
        ...atomic,
        annotations: Transaction.userEvent.of("input.paste"),
        scrollIntoView: true
      });
      onHandled?.(event);
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
  }));
}
