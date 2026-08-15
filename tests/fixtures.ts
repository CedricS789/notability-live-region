import type { NotabilityRegionV1 } from "../src/model";

export const noteUrl = "https://notability.com/app/note/11111111-2222-4333-8444-555555555555";

export function region(overrides: Partial<NotabilityRegionV1> = {}): NotabilityRegionV1 {
  return {
    v: 1,
    id: "nr-12345678",
    url: noteUrl,
    title: "1 - Chapter_CMOSbasics2",
    page: 3,
    expectedPageCount: 31,
    rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 },
    pageAspect: 0.705882,
    fingerprint: { kind: "none" },
    adapter: "notability-web-v1",
    capturedAt: "2026-08-12T10:00:00.000Z",
    ...overrides
  };
}
