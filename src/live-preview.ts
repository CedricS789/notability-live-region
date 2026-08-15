import { RangeSetBuilder, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { mountRegionCard, regionRenderKey, type CardMount } from "./card";
import {
  REGION_BLOCK_LANGUAGE,
  parseRegionJson,
  type NotabilityRegionV1
} from "./model";
import type { RegionService } from "./service-types";

type RegionFenceRange = {
  from: number;
  to: number;
  region: NotabilityRegionV1;
};

const escapedLanguage = REGION_BLOCK_LANGUAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fenceExpression = new RegExp(
  `^ {0,3}\`\`\`${escapedLanguage}[\\t ]*\\r?\\n([\\s\\S]*?)^ {0,3}\`\`\`[\\t ]*\\r?$`,
  "gm"
);

/** Pure source scan used by the StateField. Invalid blocks are omitted. */
export function parseRegionFenceRanges(source: string): RegionFenceRange[] {
  const ranges: RegionFenceRange[] = [];
  for (const match of source.matchAll(fenceExpression)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    try {
      ranges.push({ from, to, region: parseRegionJson(match[1] ?? "") });
    } catch {
      // Invalid metadata must remain source-visible.
    }
  }
  return ranges;
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((selection) => selection.from <= to && selection.to >= from);
}

class RegionWidget extends WidgetType {
  private mount: CardMount | null = null;
  private readonly key: string;

  constructor(
    private readonly region: NotabilityRegionV1,
    private readonly service: RegionService
  ) {
    super();
    this.key = regionRenderKey(region);
  }

  eq(other: RegionWidget): boolean {
    return this.key === other.key;
  }

  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const wrapper = document.win.createDiv();
    wrapper.className = "notability-live-region-cm-widget";
    this.mount = mountRegionCard(wrapper, this.region, this.service);
    document.defaultView?.setTimeout(() => {
      if (wrapper.isConnected) view.requestMeasure();
    }, 0);
    return wrapper;
  }

  destroy(): void {
    this.mount?.dispose();
    this.mount = null;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(state: EditorState, service: RegionService): DecorationSet {
  if (state.field(editorLivePreviewField, false) !== true) return Decoration.none;
  const ranges = parseRegionFenceRanges(state.doc.toString());
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) {
    if (selectionTouches(state, range.from, range.to)) continue;
    builder.add(
      range.from,
      range.to,
      Decoration.replace({
        widget: new RegionWidget(range.region, service),
        block: true
      })
    );
  }
  return builder.finish();
}

/**
 * Direct StateField decorations are intentional: block replacements that span
 * line breaks cannot be supplied through viewport-computed decorations.
 */
export function livePreviewExtension(service: RegionService): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, service);
    },
    update(value, transaction) {
      if (
        !transaction.docChanged &&
        transaction.selection === undefined &&
        !transaction.reconfigured &&
        transaction.effects.length === 0
      ) {
        return value;
      }
      return buildDecorations(transaction.state, service);
    },
    provide: (field) => EditorView.decorations.from(field)
  });
}
