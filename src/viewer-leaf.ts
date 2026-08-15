import type { Workspace, WorkspaceLeaf } from "obsidian";
import { extractNoteId, sanitizeNotabilityNoteUrl } from "./url-policy";
import { parseCaptureViewState } from "./view-state";

export interface RoutableViewerView {
  matchesNote(url: string): boolean;
  setReturnMarkdownLeaf(leaf: WorkspaceLeaf | null): void;
}

export type ViewerWorkspace = Pick<
  Workspace,
  "getLeavesOfType" | "getLeaf" | "revealLeaf" | "setActiveLeaf" | "getMostRecentLeaf"
>;

/**
 * Owns viewer-leaf placement and note-aware routing. Explicit blank opens are
 * intentionally never deduplicated. Note opens are serialized per note only,
 * so unrelated notes can still create and load in parallel.
 */
export class ViewerLeafController {
  private readonly noteOpenings = new Map<string, Promise<WorkspaceLeaf>>();
  private placementQueue: Promise<void> = Promise.resolve();
  private readonly pendingPlacements = new Set<WorkspaceLeaf>();
  private readonly recency = new Map<WorkspaceLeaf, number>();
  private recencyClock = 0;

  constructor(
    private readonly workspace: ViewerWorkspace,
    private readonly viewType: string,
    private readonly asViewer: (leaf: WorkspaceLeaf) => RoutableViewerView | null = defaultViewer
  ) {}

  /** Every explicit viewer command creates another user-closeable blank tab. */
  async openBlank(originLeaf: WorkspaceLeaf | null = null): Promise<WorkspaceLeaf> {
    const leaf = await this.createLeaf();
    this.bindOrigin(leaf, originLeaf);
    return this.activate(leaf);
  }

  /** Reuse an active/MRU exact-note viewer, or create one without retargeting another note. */
  async openForNote(url: string, originLeaf: WorkspaceLeaf | null = null): Promise<WorkspaceLeaf> {
    const canonicalUrl = sanitizeNotabilityNoteUrl(url);
    const noteId = extractNoteId(canonicalUrl);
    const existing = this.bestMatchingLeaf(canonicalUrl);
    if (existing) {
      this.bindOrigin(existing, originLeaf);
      return this.activate(existing);
    }

    const opening = this.noteOpenings.get(noteId);
    if (opening) {
      const leaf = await opening;
      this.bindOrigin(leaf, originLeaf);
      return this.activate(leaf);
    }

    const operation = this.createForNote(canonicalUrl, originLeaf);
    this.noteOpenings.set(noteId, operation);
    try {
      return await operation;
    } finally {
      if (this.noteOpenings.get(noteId) === operation) this.noteOpenings.delete(noteId);
    }
  }

  /** Feed from active-leaf-change so same-note routing has a public-API MRU signal. */
  recordLeafActivity(leaf: WorkspaceLeaf | null): void {
    this.pruneRecency();
    if (!leaf || !this.liveViewerLeaves().includes(leaf)) return;
    this.recency.set(leaf, ++this.recencyClock);
  }

  private async createForNote(url: string, originLeaf: WorkspaceLeaf | null): Promise<WorkspaceLeaf> {
    // A restored/raced exact-note leaf wins before we allocate another tab.
    const raced = this.bestMatchingLeaf(url);
    if (raced) {
      this.bindOrigin(raced, originLeaf);
      return this.activate(raced);
    }

    const secondRace = this.bestMatchingLeaf(url);
    if (secondRace) {
      this.bindOrigin(secondRace, originLeaf);
      return this.activate(secondRace);
    }
    const leaf = await this.createLeaf({ url });
    this.bindOrigin(leaf, originLeaf);
    return this.activate(leaf);
  }

  /** A null routing placeholder must never clear an existing viewer target. */
  private bindOrigin(leaf: WorkspaceLeaf, originLeaf: WorkspaceLeaf | null): void {
    if (originLeaf) this.asViewer(leaf)?.setReturnMarkdownLeaf(originLeaf);
  }

  private async withPlacementLock<T>(create: () => Promise<T>): Promise<T> {
    const previous = this.placementQueue;
    let release!: () => void;
    this.placementQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await create();
    } finally {
      release();
    }
  }

  private async createLeaf(state?: Record<string, unknown>): Promise<WorkspaceLeaf> {
    const leaf = await this.withPlacementLock(async () => {
      const viewers = [...this.liveViewerLeaves(), ...this.pendingPlacements];
      const allocated = viewers.length === 0
        ? this.workspace.getLeaf("split", "vertical")
        : this.createTabInViewerGroup(viewers);
      this.pendingPlacements.add(allocated);
      return allocated;
    });
    try {
      await leaf.setViewState({ type: this.viewType, active: true, ...(state ? { state } : {}) });
      return leaf;
    } finally {
      this.pendingPlacements.delete(leaf);
    }
  }

  private createTabInViewerGroup(viewers: WorkspaceLeaf[]): WorkspaceLeaf {
    const preferred = this.preferredViewer(viewers);
    // getLeaf("tab") is the supported API for a new tab. Briefly making the
    // preferred viewer active directs it into that viewer's existing tab group.
    this.workspace.setActiveLeaf(preferred, { focus: false });
    return this.workspace.getLeaf("tab");
  }

  private preferredViewer(viewers: WorkspaceLeaf[]): WorkspaceLeaf {
    const active = this.workspace.getMostRecentLeaf();
    if (active && viewers.includes(active)) return active;
    return [...viewers].sort((left, right) => (this.recency.get(right) ?? 0) - (this.recency.get(left) ?? 0))[0]!;
  }

  private bestMatchingLeaf(url: string): WorkspaceLeaf | null {
    const matches = this.liveViewerLeaves().filter((leaf) => this.leafMatchesNote(leaf, url));
    if (matches.length === 0) return null;
    const active = this.workspace.getMostRecentLeaf();
    if (active && matches.includes(active)) return active;
    return [...matches].sort((left, right) => (this.recency.get(right) ?? 0) - (this.recency.get(left) ?? 0))[0]!;
  }

  private leafMatchesNote(leaf: WorkspaceLeaf, url: string): boolean {
    const viewer = this.asViewer(leaf);
    if (viewer) return viewer.matchesNote(url);
    // Deferred restored leaves expose their persisted state without forcing a
    // webview to load. The strict parser accepts both v2 and legacy {url}.
    try {
      const state = parseCaptureViewState(leaf.getViewState().state);
      return Boolean(state?.url && extractNoteId(state.url) === extractNoteId(url));
    } catch {
      return false;
    }
  }

  private async activate(leaf: WorkspaceLeaf): Promise<WorkspaceLeaf> {
    await this.workspace.revealLeaf(leaf);
    this.workspace.setActiveLeaf(leaf, { focus: true });
    this.recordLeafActivity(leaf);
    return leaf;
  }

  private liveViewerLeaves(): WorkspaceLeaf[] {
    return this.workspace.getLeavesOfType(this.viewType);
  }

  private pruneRecency(): void {
    const live = new Set(this.liveViewerLeaves());
    for (const leaf of this.recency.keys()) {
      if (!live.has(leaf)) this.recency.delete(leaf);
    }
  }
}

function defaultViewer(leaf: WorkspaceLeaf): RoutableViewerView | null {
  const view = leaf.view as Partial<RoutableViewerView> | undefined;
  return view && typeof view.matchesNote === "function" && typeof view.setReturnMarkdownLeaf === "function"
    ? view as RoutableViewerView
    : null;
}

export type RegionPasteChange<TPosition = { line: number; ch: number }> = {
  from: TPosition;
  to: TPosition;
  text: string;
};

/** Build one atomic paste transaction, preserving every current selection. */
export function buildAtomicPasteChanges<TSelection, TPosition>(
  selections: readonly TSelection[],
  rangeOf: (selection: TSelection) => { from: TPosition; to: TPosition },
  replacementFor: (range: { from: TPosition; to: TPosition }) => string | null
): RegionPasteChange<TPosition>[] | null {
  const changes: RegionPasteChange<TPosition>[] = [];
  for (const selection of selections) {
    const range = rangeOf(selection);
    const text = replacementFor(range);
    if (text === null) return null;
    changes.push({ from: range.from, to: range.to, text });
  }
  return changes;
}
