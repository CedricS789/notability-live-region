import { DEFAULT_MAX_CACHE_MIB } from "./cache";

export type NotabilityRegionSettings = {
  maxCacheMiB: number;
  recentNoteUrls: string[];
};

export const DEFAULT_SETTINGS: NotabilityRegionSettings = {
  maxCacheMiB: DEFAULT_MAX_CACHE_MIB,
  recentNoteUrls: []
};

const V0_2_DEFAULT_MAX_CACHE_MIB = 256;
const V0_3_DEFAULT_MAX_CACHE_MIB = 1024;

export type SettingsMigration = {
  settings: NotabilityRegionSettings;
  changed: boolean;
};

export function migrateRegionSettings(raw: unknown): SettingsMigration {
  const record = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const hadLegacyAgeSetting = Object.prototype.hasOwnProperty.call(record, "maxCacheAgeDays");
  const configuredMax = typeof record.maxCacheMiB === "number"
    && Number.isFinite(record.maxCacheMiB)
    && record.maxCacheMiB >= 1
    ? Math.round(record.maxCacheMiB)
    : null;
  const usedOldDefault = configuredMax === V0_3_DEFAULT_MAX_CACHE_MIB
    || (hadLegacyAgeSetting && configuredMax === V0_2_DEFAULT_MAX_CACHE_MIB);
  const maxCacheMiB = usedOldDefault
    ? DEFAULT_SETTINGS.maxCacheMiB
    : configuredMax ?? DEFAULT_SETTINGS.maxCacheMiB;
  const recentNoteUrls = Array.isArray(record.recentNoteUrls)
    ? record.recentNoteUrls.filter((value): value is string => typeof value === "string")
    : [];
  return {
    settings: { maxCacheMiB, recentNoteUrls },
    changed: hadLegacyAgeSetting
      || configuredMax === null
      || usedOldDefault
      || recentNoteUrls.length !== (Array.isArray(record.recentNoteUrls) ? record.recentNoteUrls.length : 0)
  };
}
