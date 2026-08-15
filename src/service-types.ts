import type { NotabilityRegionV1 } from "./model";
import type { PreviewDescriptor } from "./cache";

export type CacheUpdateListener = (regionId: string) => void;

export interface RegionService {
  preview(region: NotabilityRegionV1): Promise<PreviewDescriptor | null>;
  openRegion(region: NotabilityRegionV1): Promise<void>;
  refreshRegion(region: NotabilityRegionV1): Promise<void>;
  /**
   * Subscribe to completed preview writes. The returned function must remove
   * this exact listener and be safe to call more than once.
   */
  subscribeCacheUpdates(listener: CacheUpdateListener): () => void;
}
