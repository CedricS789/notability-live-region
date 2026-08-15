import { validateRegion, type NotabilityRegionV1 } from "./model";
import { sanitizeNotabilityNoteUrl } from "./url-policy";

export const CAPTURE_VIEW_STATE_VERSION = 2 as const;
export type PersistedInteractionMode = "browse" | "area" | "text";

export type CaptureViewStateV2 = {
  v: typeof CAPTURE_VIEW_STATE_VERSION;
  url?: string;
  title?: string;
  page?: number;
  mode: PersistedInteractionMode;
  region?: NotabilityRegionV1;
};

export type RestoredCaptureViewState = {
  url: string | null;
  title: string | null;
  page: number | null;
  mode: PersistedInteractionMode;
  region: NotabilityRegionV1 | null;
};

/**
 * Remembers the user's durable mode for one opened saved region. Alignment may
 * temporarily enter Area to paint the rectangle, but repeated load events must
 * always return to this mode until another region is opened or the region is
 * cleared.
 */
export class OpenedRegionModeState {
  private mode: PersistedInteractionMode = "area";

  open(mode: PersistedInteractionMode = "area"): void {
    this.mode = mode;
  }

  clear(): void {
    this.mode = "area";
  }

  current(): PersistedInteractionMode {
    return this.mode;
  }
}

export function buildCaptureViewState(value: {
  url: string | null;
  title: string | null;
  page: number | null;
  mode: PersistedInteractionMode;
  region: NotabilityRegionV1 | null;
}): CaptureViewStateV2 {
  return {
    v: CAPTURE_VIEW_STATE_VERSION,
    ...(value.url ? { url: sanitizeNotabilityNoteUrl(value.url) } : {}),
    ...(value.title ? { title: value.title } : {}),
    ...(value.page ? { page: value.page } : {}),
    mode: value.mode,
    ...(value.region ? { region: value.region } : {})
  };
}

function validInteractionMode(value: unknown): value is PersistedInteractionMode {
  return value === "browse" || value === "area" || value === "text";
}

function sameNote(left: string, right: string): boolean {
  return sanitizeNotabilityNoteUrl(left) === sanitizeNotabilityNoteUrl(right);
}

/** Parse layout state without ever accepting raw selected text or transient UI state. */
export function parseCaptureViewState(state: unknown): RestoredCaptureViewState | null {
  if (!state || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  if (record.v === undefined && typeof record.url === "string") {
    try {
      return {
        url: sanitizeNotabilityNoteUrl(record.url),
        title: null,
        page: null,
        mode: "browse",
        region: null
      };
    } catch {
      return null;
    }
  }
  if (record.v !== CAPTURE_VIEW_STATE_VERSION || !validInteractionMode(record.mode)) return null;

  let region: NotabilityRegionV1 | null = null;
  if (record.region !== undefined) {
    try {
      const validated = validateRegion(record.region);
      region = { ...validated, url: sanitizeNotabilityNoteUrl(validated.url) };
    } catch {
      return null;
    }
  }
  let url: string | null = region?.url ?? null;
  if (record.url !== undefined) {
    if (typeof record.url !== "string") return null;
    try {
      const candidate = sanitizeNotabilityNoteUrl(record.url);
      if (region && !sameNote(region.url, candidate)) return null;
      url = candidate;
    } catch {
      return null;
    }
  }
  const title = typeof record.title === "string" && record.title.trim()
    ? record.title.trim().slice(0, 512)
    : null;
  const page = record.page === undefined
    ? region?.page ?? null
    : typeof record.page === "number" && Number.isInteger(record.page) && record.page >= 1
      ? record.page
      : null;
  if (record.page !== undefined && page === null) return null;
  return { url, title, page, mode: record.mode, region };
}
