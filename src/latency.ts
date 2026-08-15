export type ViewerLatencySnapshot = {
  leafReadyMs?: number | undefined;
  webviewAttachMs?: number | undefined;
  navigationMs?: number | undefined;
  authenticationRedirectMs?: number | undefined;
  firstPageMs?: number | undefined;
  regionAlignmentMs?: number | undefined;
  redirectCount: number;
};

/** Ephemeral, identity-free timings for diagnosing warm and cold viewer loads. */
export class ViewerLatencyTracker {
  private navigationStartedAt: number | null = null;
  private navigationFinishedAt: number | null = null;
  private regionAlignmentStartedAt: number | null = null;
  private values: ViewerLatencySnapshot = { redirectCount: 0 };

  reset(): void {
    this.navigationStartedAt = null;
    this.navigationFinishedAt = null;
    this.regionAlignmentStartedAt = null;
    this.values = { redirectCount: 0, leafReadyMs: this.values.leafReadyMs, webviewAttachMs: this.values.webviewAttachMs };
  }

  leafReady(milliseconds: number): void { this.values.leafReadyMs = validDuration(milliseconds); }
  webviewAttached(milliseconds: number): void { this.values.webviewAttachMs = validDuration(milliseconds); }

  navigationStarted(now = performance.now()): void {
    this.navigationStartedAt = now;
    this.navigationFinishedAt = null;
    this.regionAlignmentStartedAt = null;
    this.values.navigationMs = undefined;
    this.values.authenticationRedirectMs = undefined;
    this.values.firstPageMs = undefined;
    this.values.regionAlignmentMs = undefined;
    this.values.redirectCount = 0;
  }

  authenticationRedirect(now = performance.now()): void {
    if (this.navigationStartedAt === null) return;
    this.values.redirectCount += 1;
    if (this.values.authenticationRedirectMs === undefined) {
      this.values.authenticationRedirectMs = validDuration(now - this.navigationStartedAt);
    }
  }

  /** Backward-compatible alias used by the focused tracker test. */
  redirect(now = performance.now()): void { this.authenticationRedirect(now); }

  navigationFinished(now = performance.now()): void {
    if (this.navigationStartedAt === null) return;
    this.navigationFinishedAt = now;
    this.values.navigationMs = validDuration(now - this.navigationStartedAt);
  }

  firstPage(now = performance.now()): void {
    if (this.navigationStartedAt === null) return;
    if (this.values.firstPageMs === undefined) {
      this.values.firstPageMs = validDuration(now - this.navigationStartedAt);
    }
  }

  regionAlignmentStarted(now = performance.now()): void {
    this.regionAlignmentStartedAt = now;
    this.values.regionAlignmentMs = undefined;
  }

  regionAligned(now = performance.now()): void {
    const startedAt = this.regionAlignmentStartedAt ?? this.navigationStartedAt;
    if (startedAt === null) return;
    if (this.values.regionAlignmentMs === undefined) {
      this.values.regionAlignmentMs = validDuration(now - startedAt);
    }
  }

  snapshot(): ViewerLatencySnapshot { return { ...this.values }; }
}

/**
 * Classify a transient main-frame navigation without retaining its URL. A
 * non-note page reached while a canonical note request is pending is treated
 * as an authentication/application redirect; about:blank is just startup.
 */
export function isAuthenticationRedirect(value: string | undefined): boolean {
  if (!value || value === "about:blank") return false;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return !(hostname === "notability.com" && /^\/app\/note\/[^/]+\/?$/i.test(parsed.pathname));
  } catch {
    return false;
  }
}

function validDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}
