import {
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  type App,
  type Plugin,
  type SettingDefinitionItem
} from "obsidian";
import {
  type CacheClearResult,
  type CacheStats
} from "./cache";
import type { NotabilityRegionSettings } from "./settings-data";

export {
  DEFAULT_SETTINGS,
  migrateRegionSettings,
  type NotabilityRegionSettings,
  type SettingsMigration
} from "./settings-data";

export interface SettingsHost {
  settings: NotabilityRegionSettings;
  saveRegionSettings(): Promise<void>;
  previewCacheStats(): Promise<CacheStats>;
  clearPreviewCache(): Promise<CacheClearResult>;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function statsText(stats: CacheStats): string {
  const previewLabel = stats.count === 1 ? "preview" : "previews";
  let text = `${stats.count} cached ${previewLabel}, ${formatBytes(stats.bytes)}.`;
  if (stats.unknownFiles > 0) {
    text += ` ${stats.unknownFiles} unrecognized ${stats.unknownFiles === 1 ? "file was" : "files were"} excluded.`;
  }
  if (stats.failures.length > 0) text += ` ${stats.failures.length} cache ${stats.failures.length === 1 ? "issue was" : "issues were"} reported.`;
  return text;
}

function clearResultText(result: CacheClearResult): string {
  if (result.failures.length > 0) {
    return `Cleared ${result.removed} of ${result.recognized} recognized previews. ${result.failures.length} cache ${result.failures.length === 1 ? "operation failed" : "operations failed"}; unrecognized files were preserved.`;
  }
  return `Cleared ${result.removed} cached ${result.removed === 1 ? "preview" : "previews"} (${formatBytes(result.bytesRemoved)}).`;
}

export class ClearPreviewCacheModal extends Modal {
  constructor(
    app: App,
    private readonly stats: CacheStats,
    private readonly clearCache: () => Promise<CacheClearResult>,
    private readonly completed: (result: CacheClearResult) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Clear preview cache?");
    this.contentEl.createEl("p", {
      text: `This removes ${this.stats.count} recognized cached ${this.stats.count === 1 ? "preview" : "previews"} (${formatBytes(this.stats.bytes)}). Existing Markdown links and region metadata remain, but hover and embed images will disappear until each region is captured again. Unrecognized files are preserved.`
    });

    const actions = new Setting(this.contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => this.close());
        button.buttonEl.autofocus = true;
        button.buttonEl.focus();
      })
      .addButton((button) => button
        .setDestructive()
        .setButtonText("Clear previews")
        .onClick(async () => {
          actions.setDisabled(true);
          try {
            const result = await this.clearCache();
            this.close();
            this.completed(result);
          } catch (error) {
            actions.setDisabled(false);
            new Notice(`Could not clear the preview cache: ${error instanceof Error ? error.message : String(error)}`);
          }
        }));
    actions.settingEl.addClass("notability-live-region-confirm-actions");
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class NotabilityRegionSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  getSettingDefinitions(): SettingDefinitionItem<"maxCacheMiB">[] {
    return [{
      type: "group",
      heading: "Viewer and preview cache",
      items: [
        {
          name: "About the viewer",
          desc: "The persistent viewer opens shared Notability notes beside Markdown and reuses Obsidian's web viewer session when available. Copying a region creates an internal plugin link or embed, never a public web link. Preview images stay in this plugin's hidden cache and are never added to attachments."
        },
        {
          name: "Preview cache limit",
          desc: "Previews never expire with age. Least-recently-used previews are removed only when this local size limit is exceeded. The default is 5 GiB.",
          control: {
            type: "number",
            key: "maxCacheMiB",
            min: 32,
            max: 16384,
            step: 1,
            validate: (value) => Number.isFinite(value) && value >= 32 && value <= 16384
              ? undefined
              : "Enter a cache limit between 32 and 16384 MiB."
          }
        },
        {
          name: "Preview cache usage",
          desc: "Calculating cached previews...",
          render: (setting) => {
            let active = true;
            void this.host.previewCacheStats().then(
              (stats) => {
                if (active && setting.settingEl.isConnected) setting.setDesc(statsText(stats));
              },
              (error: unknown) => {
                if (active && setting.settingEl.isConnected) {
                  setting.setDesc(`Cache usage could not be read: ${error instanceof Error ? error.message : String(error)}`);
                }
              }
            );
            return () => {
              active = false;
            };
          }
        },
        {
          name: "Clear preview cache",
          desc: "Removes generated hover and embed previews while keeping links, region metadata, and unrecognized files.",
          render: (setting) => {
            setting.addButton((button) => button
              .setDestructive()
              .setButtonText("Clear cache...")
              .onClick(async () => {
                button.setDisabled(true);
                try {
                  const stats = await this.host.previewCacheStats();
                  new ClearPreviewCacheModal(
                    this.app,
                    stats,
                    () => this.host.clearPreviewCache(),
                    (result) => {
                      new Notice(clearResultText(result));
                      this.update();
                    }
                  ).open();
                } catch (error) {
                  new Notice(`Could not inspect the preview cache: ${error instanceof Error ? error.message : String(error)}`);
                } finally {
                  button.setDisabled(false);
                }
              }));
          }
        }
      ]
    }];
  }

  getControlValue(key: string): unknown {
    return key === "maxCacheMiB" ? this.host.settings.maxCacheMiB : undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key !== "maxCacheMiB" || typeof value !== "number" || !Number.isFinite(value)) return;
    this.host.settings.maxCacheMiB = Math.round(value);
    await this.host.saveRegionSettings();
  }
}
