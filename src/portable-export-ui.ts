import { Modal, Setting, type App } from "obsidian";

export type PortableExportSummary = {
  sourcePath: string;
  destinationPath: string;
  embedCount: number;
  assetCount: number;
  totalBytes: number;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Explicit consent before hidden cache pixels become ordinary vault files. */
export class PortableExportConfirmationModal extends Modal {
  private resolver: ((confirmed: boolean) => void) | null = null;
  private settled = false;

  constructor(app: App, private readonly summary: PortableExportSummary) {
    super(app);
  }

  confirm(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.setTitle("Create portable Notability export?");
    this.contentEl.createEl("p", {
      text: `Create a separate Markdown copy of ${this.summary.sourcePath} with ${this.summary.embedCount} ${this.summary.embedCount === 1 ? "embed" : "embeds"} backed by ${this.summary.assetCount} ordinary PNG ${this.summary.assetCount === 1 ? "file" : "files"} (${formatBytes(this.summary.totalBytes)}). The source note will not be changed.`
    });
    this.contentEl.createEl("p", {
      text: `Output: ${this.summary.destinationPath}. These PNGs contain the visible Notability material and may be synchronized like other vault files.`
    });
    this.contentEl.createEl("p", {
      text: "The generated Markdown uses standard relative image links, so PDF, HTML, Word, Pandoc, and other source-based exporters can carry the previews without this plugin."
    });

    const actions = new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("Cancel")
        .onClick(() => this.finish(false)))
      .addButton((button) => button
        .setCta()
        .setButtonText("Create export copy")
        .onClick(() => this.finish(true)));
    actions.settingEl.addClass("notability-live-region-confirm-actions");
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.settle(false);
  }

  private finish(value: boolean): void {
    this.settle(value);
    this.close();
  }

  private settle(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolver?.(value);
    this.resolver = null;
  }
}
