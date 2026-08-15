import { createHash, randomUUID } from "node:crypto";
import {
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  normalizePath,
  type Editor,
  type EditorPosition,
  type EditorSelection,
  type TFile,
  type WorkspaceLeaf
} from "obsidian";
import {
  PREVIEW_CAPTURE_VERSION,
  RegionCache,
  type CacheClearResult,
  type CacheStats,
  type PreviewCaptureInput,
  type PreviewDescriptor
} from "./cache";
import { readingViewRegionProcessor } from "./card";
import {
  NOTABILITY_REGION_VIEW,
  NotabilityCaptureView,
  type CaptureHost,
  type EmbedInsertionTarget
} from "./capture-view";
import { buildRegionPasteReplacement } from "./editor-format";
import { notabilityRegionPasteExtension, shouldHandleWorkspaceRegionPaste } from "./editor-paste";
import { prepareGuardedEmbedInsertion, type PreparedEmbedInsertion } from "./embed-insertion";
import { chooseEmbedInsertionTarget } from "./embed-target";
import { KeyedLatestRequestGate } from "./capture-state";
import { livePreviewExtension } from "./live-preview";
import { livePreviewRegionLinksExtension, readingViewRegionLinksProcessor } from "./link-handler";
import { REGION_BLOCK_LANGUAGE, type NotabilityRegionV1 } from "./model";
import { planPortableExport } from "./portable-export";
import { writePortableExportBundle } from "./portable-export-files";
import { PortableExportConfirmationModal } from "./portable-export-ui";
import { resolveNotabilityViewerPartition } from "./viewer";
import { buildAtomicPasteChanges, ViewerLeafController } from "./viewer-leaf";
import type { RegionService } from "./service-types";
import {
  DEFAULT_SETTINGS,
  migrateRegionSettings,
  NotabilityRegionSettingTab,
  type NotabilityRegionSettings,
  type SettingsHost
} from "./settings";
import {
  extractNoteId,
  INTERNAL_REGION_ACTION,
  parseInternalRegionProtocolParams,
  sanitizeNotabilityNoteUrl
} from "./url-policy";

function orderedRange(selection: EditorSelection): { from: EditorPosition; to: EditorPosition } {
  const before = selection.anchor.line < selection.head.line
    || (selection.anchor.line === selection.head.line && selection.anchor.ch <= selection.head.ch);
  return before
    ? { from: selection.anchor, to: selection.head }
    : { from: selection.head, to: selection.anchor };
}

const PORTABLE_EXPORT_ROOT = "Notability Exports";

function portableExportSegment(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = [...cleaned].slice(0, 80).join("").replace(/[. ]+$/g, "");
  return truncated || "Notability note";
}

function portableExportTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d{3}Z$/, "Z");
}

function portableExportDigest(data: ArrayBuffer): string {
  return createHash("sha256").update(new Uint8Array(data)).digest("hex");
}

export default class NotabilityLiveRegionPlugin extends Plugin implements RegionService, CaptureHost, SettingsHost {
  settings: NotabilityRegionSettings = { ...DEFAULT_SETTINGS };
  private cache!: RegionCache;
  private viewerLeaves!: ViewerLeafController;
  private lastMarkdownLeaf: WorkspaceLeaf | null = null;
  private readonly cacheUpdateListeners = new Set<(regionId: string) => void>();
  private readonly codeMirrorPasteEvents = new WeakSet<ClipboardEvent>();
  private readonly regionRoutes = new KeyedLatestRequestGate();
  private portableExportInProgress = false;

  async onload(): Promise<void> {
    if (!Platform.isDesktopApp) {
      console.warn("[Notability Live Region] This plugin requires the Obsidian desktop app.");
      return;
    }
    const migrated = migrateRegionSettings(await this.loadData());
    this.settings = migrated.settings;
    if (migrated.changed) await this.saveData(this.settings);
    const cacheRoot = normalizePath(
      `${this.app.vault.configDir}/plugins/${this.manifest.id}/cache`
    );
    this.cache = new RegionCache(this.app, () => this.settings, cacheRoot);
    await this.cache.prune().catch((error) => console.warn("[Notability Live Region] Cache prune failed", error));
    this.viewerLeaves = new ViewerLeafController(this.app.workspace, NOTABILITY_REGION_VIEW);

    this.registerView(NOTABILITY_REGION_VIEW, (leaf) => new NotabilityCaptureView(leaf, this));
    this.registerMarkdownCodeBlockProcessor(REGION_BLOCK_LANGUAGE, readingViewRegionProcessor(this));
    this.registerMarkdownPostProcessor(readingViewRegionLinksProcessor(this));
    this.registerEditorExtension([
      notabilityRegionPasteExtension((event) => this.codeMirrorPasteEvents.add(event)),
      livePreviewExtension(this),
      livePreviewRegionLinksExtension(this)
    ]);

    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      this.viewerLeaves.recordLeafActivity(leaf);
      if (leaf?.view instanceof MarkdownView) {
        this.lastMarkdownLeaf = leaf;
      } else if (leaf?.view instanceof NotabilityCaptureView) {
        leaf.view.setReturnMarkdownLeaf(this.resolveEmbedInsertionTarget(null)?.leaf ?? null);
      }
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      const leaf = this.app.workspace.getMostRecentLeaf();
      if (leaf?.view instanceof NotabilityCaptureView) {
        leaf.view.setReturnMarkdownLeaf(this.resolveEmbedInsertionTarget(null)?.leaf ?? null);
      }
    }));
    this.registerEvent(this.app.workspace.on("editor-paste", (event, editor) => {
      if (event.defaultPrevented) return;
      if (this.handleEditorPaste(event, editor)) event.preventDefault();
    }));
    this.registerObsidianProtocolHandler(INTERNAL_REGION_ACTION, (params) => {
      const region = parseInternalRegionProtocolParams(params);
      if (region) void this.openRegion(region);
    });

    const activeLeaf = this.app.workspace.getMostRecentLeaf();
    if (activeLeaf?.view instanceof MarkdownView) this.lastMarkdownLeaf = activeLeaf;

    this.addRibbonIcon("panel-right-open", "New Notability viewer", () => void this.createViewer());
    this.addCommand({
      id: "open-capture-view",
      name: "New Notability viewer",
      callback: () => void this.createViewer()
    });
    this.addCommand({
      id: "toggle-auto-insert-embeds",
      name: "Toggle inserting Notability embeds on copy",
      checkCallback: (checking) => {
        const view = this.app.workspace.getMostRecentLeaf()?.view;
        if (!(view instanceof NotabilityCaptureView)) return false;
        if (!checking) view.toggleAutoInsertEmbeds();
        return true;
      }
    });
    this.addCommand({
      id: "create-portable-export-copy",
      name: "Create portable Notability export copy",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!file || file.extension.toLowerCase() !== "md") return false;
        if (!checking) void this.createPortableExportCopy(file);
        return true;
      }
    });
    this.addSettingTab(new NotabilityRegionSettingTab(this.app, this));
  }

  private handleEditorPaste(event: ClipboardEvent, editor: Editor): boolean {
    if (!shouldHandleWorkspaceRegionPaste(event, this.codeMirrorPasteEvents)) return false;
    const clipboard = event.clipboardData?.getData("text/plain");
    if (!clipboard) return false;
    const document = editor.getValue();
    const selections = editor.listSelections();
    const changes = buildAtomicPasteChanges(
      selections,
      orderedRange,
      ({ from, to }) => buildRegionPasteReplacement(
        document,
        { from: editor.posToOffset(from), to: editor.posToOffset(to) },
        editor.getRange(from, to),
        clipboard
      )
    );
    if (!changes) return false;
    editor.transaction({ changes }, "notability-live-region-paste");
    return true;
  }

  private async createPortableExportCopy(file: TFile): Promise<void> {
    if (this.portableExportInProgress) {
      new Notice("A portable Notability export is already being prepared.");
      return;
    }
    this.portableExportInProgress = true;
    try {
      const source = await this.app.vault.read(file);
      const plan = planPortableExport(source);
      if (plan.embedCount === 0) {
        new Notice("This note contains no valid Notability embeds to export.");
        return;
      }

      let totalBytes = 0;
      const unavailable: NotabilityRegionV1[] = [];
      const approvedPixels = new Map<string, { bytes: number; digest: string }>();
      for (const asset of plan.assets) {
        const snapshot = await this.cache.readSnapshot(asset.region);
        if (!snapshot) unavailable.push(asset.region);
        else {
          approvedPixels.set(asset.id, {
            bytes: snapshot.data.byteLength,
            digest: portableExportDigest(snapshot.data)
          });
          totalBytes += snapshot.data.byteLength;
        }
      }
      if (unavailable.length > 0) {
        const examples = unavailable
          .slice(0, 3)
          .map((region) => `${region.title}, p. ${region.page}`)
          .join("; ");
        const remainder = unavailable.length > 3 ? `; and ${unavailable.length - 3} more` : "";
        new Notice(`Portable export stopped because ${unavailable.length} cached ${unavailable.length === 1 ? "preview is" : "previews are"} missing or unreadable: ${examples}${remainder}. Refresh those regions, then retry.`, 10_000);
        return;
      }

      const sourceName = portableExportSegment(file.basename);
      const destinationPath = await this.availablePortableExportPath(sourceName);
      const confirmed = await new PortableExportConfirmationModal(this.app, {
        sourcePath: file.path,
        destinationPath,
        embedCount: plan.embedCount,
        assetCount: plan.assets.length,
        totalBytes
      }).confirm();
      if (!confirmed) return;

      await writePortableExportBundle({
        adapter: this.app.vault.adapter,
        plan: {
          markdown: plan.markdown,
          markdownFileName: `${sourceName}.md`,
          destinationPath,
          assets: plan.assets
        },
        stagingId: randomUUID(),
        readAsset: async (region) => {
          const approved = approvedPixels.get(region.id);
          const snapshot = await this.cache.readSnapshot(region);
          if (!snapshot || !approved) return null;
          if (
            snapshot.data.byteLength !== approved.bytes
            || portableExportDigest(snapshot.data) !== approved.digest
          ) {
            throw new Error(`The cached preview for ${region.id} changed after confirmation. Retry the export.`);
          }
          return snapshot.data;
        },
        sourceStillCurrent: async () => await this.app.vault.read(file) === source
      });
      new Notice(`Portable Notability export created at ${destinationPath}. The source note was not changed.`, 8_000);
    } catch (error) {
      new Notice(`Could not create the portable Notability export: ${error instanceof Error ? error.message : String(error)}`, 10_000);
    } finally {
      this.portableExportInProgress = false;
    }
  }

  private async availablePortableExportPath(sourceName: string): Promise<string> {
    const root = normalizePath(PORTABLE_EXPORT_ROOT);
    const base = normalizePath(`${root}/${sourceName}-${portableExportTimestamp()}`);
    for (let suffix = 0; suffix < 1_000; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
      if (!(await this.app.vault.adapter.exists(candidate))) return candidate;
    }
    throw new Error("No available portable export destination could be allocated.");
  }

  private markdownOrigin(): WorkspaceLeaf | null {
    const active = this.app.workspace.getMostRecentLeaf();
    if (active?.view instanceof MarkdownView) {
      this.lastMarkdownLeaf = active;
      return this.resolveEmbedInsertionTarget(null)?.leaf ?? null;
    }
    return this.resolveEmbedInsertionTarget(this.lastMarkdownLeaf)?.leaf ?? null;
  }

  private async captureView(leaf: WorkspaceLeaf): Promise<NotabilityCaptureView> {
    if (leaf.isDeferred) await leaf.loadIfDeferred();
    const view = leaf.view;
    if (!(view instanceof NotabilityCaptureView)) throw new Error("Cannot open the Notability viewer.");
    return view;
  }

  private async createViewer(): Promise<NotabilityCaptureView> {
    const origin = this.markdownOrigin();
    const leaf = await this.viewerLeaves.openBlank(origin);
    const view = await this.captureView(leaf);
    // A restored/deferred leaf may materialize only after the controller has
    // selected it, so attach the per-view return target again once it is live.
    view.setReturnMarkdownLeaf(origin);
    return view;
  }

  private async routeRegion(
    region: NotabilityRegionV1,
    action: (view: NotabilityCaptureView) => Promise<void>
  ): Promise<void> {
    const noteId = extractNoteId(region.url);
    const requestId = this.regionRoutes.begin(noteId);
    const origin = this.markdownOrigin();
    try {
      // Bind the Markdown origin only after the latest caller wins. Passing it
      // through the shared controller promise would let an older continuation
      // overwrite a newer request's per-view return target.
      const leaf = await this.viewerLeaves.openForNote(region.url, null);
      if (!this.regionRoutes.isCurrent(noteId, requestId)) return;
      const view = await this.captureView(leaf);
      if (!this.regionRoutes.isCurrent(noteId, requestId)) return;
      view.setReturnMarkdownLeaf(origin);
      await action(view);
    } finally {
      this.regionRoutes.finish(noteId, requestId);
    }
  }

  viewerPartition(): string { return resolveNotabilityViewerPartition(this.app); }

  async focusMarkdownAfterCopy(): Promise<void> {
    const target = this.resolveEmbedInsertionTarget(null);
    if (!target) return;
    try {
      await this.app.workspace.revealLeaf(target.leaf);
      this.app.workspace.setActiveLeaf(target.leaf, { focus: true });
    } catch {
      if (this.lastMarkdownLeaf === target.leaf) this.lastMarkdownLeaf = null;
    }
  }

  async savePreview(region: NotabilityRegionV1, bytes: Uint8Array, capture: Omit<PreviewCaptureInput, "captureVersion">): Promise<void> {
    await this.cache.put(region, bytes, { ...capture, captureVersion: PREVIEW_CAPTURE_VERSION });
    for (const listener of [...this.cacheUpdateListeners]) {
      try {
        listener(region.id);
      } catch (error) {
        console.warn("[Notability Live Region] A preview-refresh listener failed", error);
      }
    }
  }

  subscribeCacheUpdates(listener: (regionId: string) => void): () => void {
    this.cacheUpdateListeners.add(listener);
    return () => this.cacheUpdateListeners.delete(listener);
  }

  async preview(region: NotabilityRegionV1): Promise<PreviewDescriptor | null> { return this.cache.get(region); }

  async openRegion(region: NotabilityRegionV1): Promise<void> {
    await this.routeRegion(region, (view) => view.openRegion(region));
  }

  async refreshRegion(region: NotabilityRegionV1): Promise<void> {
    await this.routeRegion(region, (view) => view.refreshRegion(region));
  }

  async rememberUrl(value: string): Promise<void> {
    const url = sanitizeNotabilityNoteUrl(value);
    this.settings.recentNoteUrls = [url, ...this.settings.recentNoteUrls.filter((entry) => entry !== url)].slice(0, 8);
    await this.saveRegionSettings();
  }

  requestLayoutSave(): void { this.app.workspace.requestSaveLayout(); }

  resolveEmbedInsertionTarget(preferredLeaf: WorkspaceLeaf | null): EmbedInsertionTarget | null {
    const liveLeaves = this.app.workspace.getLeavesOfType("markdown");
    const requestedLeaf = preferredLeaf ?? this.lastMarkdownLeaf;
    const leaf = chooseEmbedInsertionTarget({
      liveLeaves,
      requestedLeaf,
      isEditable: (candidate) => {
        const view = candidate.view;
        return view instanceof MarkdownView && view.getMode() === "source" && Boolean(view.file);
      }
    });
    if (!leaf) {
      if (this.lastMarkdownLeaf && !liveLeaves.includes(this.lastMarkdownLeaf)) this.lastMarkdownLeaf = null;
      return null;
    }
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.file) return null;
    return { leaf, label: view.file.path, identity: view.file };
  }

  prepareEmbedInsertion(leaf: WorkspaceLeaf | null): PreparedEmbedInsertion | null {
    const target = this.resolveEmbedInsertionTarget(leaf);
    if (!target) return null;
    leaf = target.leaf;
    const view = target.leaf.view;
    if (!(view instanceof MarkdownView) || view.getMode() !== "source" || !view.file) return null;
    const editor = view.editor;
    const file = view.file;
    return prepareGuardedEmbedInsertion({
      isCurrent: () => (
        this.app.workspace.getLeavesOfType("markdown").includes(leaf)
        && leaf.view === view
        && view.editor === editor
        && view.file === file
        && view.getMode() === "source"
      ),
      document: () => editor.getValue(),
      selections: () => editor.listSelections(),
      offset: (position) => editor.posToOffset(position),
      selectedText: (from, to) => editor.getRange(from, to),
      transact: (changes) => editor.transaction(
        { changes: changes.map((change) => ({ ...change })) },
        "notability-live-region-auto-insert"
      )
    });
  }

  async saveRegionSettings(): Promise<void> { await this.saveData(this.settings); }

  async previewCacheStats(): Promise<CacheStats> { return this.cache.stats(); }

  async clearPreviewCache(): Promise<CacheClearResult> {
    const result = await this.cache.clear();
    for (const listener of [...this.cacheUpdateListeners]) {
      try {
        listener("*");
      } catch (error) {
        console.warn("[Notability Live Region] A preview-clear listener failed", error);
      }
    }
    return result;
  }
}
