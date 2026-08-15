import type { NotabilityRegionV1 } from "./model";

/** A user-requested capture cancellation, distinct from a capture failure. */
export class CaptureCancelledError extends Error {
  override readonly name = "CaptureCancelledError";

  constructor() {
    super("Notability capture cancelled.");
  }
}

/**
 * Per-view monotonic cancellation. A ticket remains valid until Escape
 * invalidates it; the next operation then takes a fresh valid ticket.
 */
export class CaptureCancellationGate {
  private generation = 0;

  snapshot(): number {
    return this.generation;
  }

  cancel(): void {
    this.generation += 1;
  }

  isCurrent(ticket: number): boolean {
    return Number.isSafeInteger(ticket) && ticket === this.generation;
  }

  assertCurrent(ticket: number): void {
    if (!this.isCurrent(ticket)) throw new CaptureCancelledError();
  }
}

export type CaptureSelectionSnapshot = Readonly<{
  opened: NotabilityRegionV1 | null;
  materialized: NotabilityRegionV1 | null;
}>;

/**
 * Tracks whether a visible rectangle already has stable metadata. A manual
 * drag invalidates that metadata; repeated copy actions then reuse the first
 * materialized region until the rectangle changes again.
 */
export class CaptureSelectionState {
  private materialized: NotabilityRegionV1 | null = null;
  private opened: NotabilityRegionV1 | null = null;

  openedRegion(): NotabilityRegionV1 | null {
    return this.opened;
  }

  reusableRegion(): NotabilityRegionV1 | null {
    return this.materialized;
  }

  snapshot(): CaptureSelectionSnapshot {
    return { opened: this.opened, materialized: this.materialized };
  }

  restore(snapshot: CaptureSelectionSnapshot): void {
    this.opened = snapshot.opened;
    this.materialized = snapshot.materialized;
  }

  open(region: NotabilityRegionV1): void {
    this.opened = region;
    this.materialized = region;
  }

  startManualSelection(): void {
    this.opened = null;
    this.materialized = null;
  }

  materialize(create: () => NotabilityRegionV1): NotabilityRegionV1 {
    if (this.materialized) return this.materialized;
    const region = create();
    this.materialized = region;
    return region;
  }

  clear(): void {
    this.opened = null;
    this.materialized = null;
  }
}

/** Monotonic latest-request gate for async viewer navigation. */
export class LatestRequestGate {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.generation;
  }
}

/**
 * Independent latest-request gates keyed by a stable identity. This lets
 * rapid region opens for one note be latest-wins without cancelling work for
 * another note.
 */
export class KeyedLatestRequestGate {
  private generation = 0;
  private readonly current = new Map<string, number>();

  begin(key: string): number {
    const requestId = ++this.generation;
    this.current.set(key, requestId);
    return requestId;
  }

  isCurrent(key: string, requestId: number): boolean {
    return this.current.get(key) === requestId;
  }

  finish(key: string, requestId: number): void {
    if (this.isCurrent(key, requestId)) this.current.delete(key);
  }
}

/**
 * An explicit saved-region open gets one alignment attempt. Incidental load or
 * history events cannot re-arm it, and manual user navigation cancels it.
 */
export class OneShotRegionAlignment {
  private generation = 0;
  private pending: { generation: number; regionId: string; claimed: boolean } | null = null;

  arm(regionId: string): number {
    const generation = ++this.generation;
    this.pending = { generation, regionId, claimed: false };
    return generation;
  }

  claim(regionId: string): number | null {
    const pending = this.pending;
    if (!pending || pending.claimed || pending.regionId !== regionId) return null;
    pending.claimed = true;
    return pending.generation;
  }

  isCurrent(generation: number): boolean {
    return this.pending?.generation === generation;
  }

  complete(generation: number): void {
    if (this.isCurrent(generation)) this.pending = null;
  }

  cancel(): void {
    this.generation += 1;
    this.pending = null;
  }
}

/** A displayed note is reusable only when no physical load can still finish afterward. */
export function canReuseLoadedNote(
  loaded: boolean,
  targetMatches: boolean,
  actualWebviewMatches: boolean,
  hasInFlightLoad: boolean
): boolean {
  return loaded && targetMatches && actualWebviewMatches && !hasInFlightLoad;
}
