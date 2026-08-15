export type ScrollLockInteractionMode = "browse" | "area" | "text";

const GUEST_SCROLL_LOCK_SYMBOL = "notability-live-region.selection-scroll-lock.v3";
export const GUEST_CAPTURE_ESCAPE_MESSAGE = "notability-live-region.capture-escape:";

export function selectionModeLocksScrolling(mode: ScrollLockInteractionMode): boolean {
  return mode === "area" || mode === "text";
}

/**
 * Install or update a document-local, trusted-input-only scroll lock.
 *
 * Notability alignment and tiled capture deliberately dispatch untrusted
 * synthetic wheel events, so those plugin-owned movements remain available.
 * Physical wheel, touchpad, touch, and unmodified scroll-key input is blocked
 * while Area or Text capture mode owns the viewport.
 */
export function buildSelectionScrollLockScript(locked: boolean, generation: number): string {
  if (!Number.isInteger(generation) || generation < 0 || generation > Number.MAX_SAFE_INTEGER) {
    throw new Error("The selection scroll-lock generation is invalid.");
  }
  return `(() => {
    const key = Symbol.for(${JSON.stringify(GUEST_SCROLL_LOCK_SYMBOL)});
    let state = window[key];
    if (!state || typeof state !== 'object') {
      state = {
        locked: false,
        generation: -1,
        captureEscapeId: null,
        captureEscapeGeneration: -1,
        captureEscapeRequestedId: null
      };
      const stopTrustedScroll = (event) => {
        if (!state.locked || event.isTrusted !== true) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
      const stopTrustedScrollKey = (event) => {
        if (
          event.isTrusted === true
          && event.key === 'Escape'
          && event.isComposing !== true
          && typeof state.captureEscapeId === 'string'
        ) {
          state.captureEscapeRequestedId = state.captureEscapeId;
          // Report without consuming the guest key. If a later disarm message
          // is lost, ordinary Notability/Browse Escape behavior must remain
          // available rather than being trapped by stale plugin state.
          console.info(${JSON.stringify(GUEST_CAPTURE_ESCAPE_MESSAGE)} + state.captureEscapeId);
          return;
        }
        if (
          !state.locked
          || event.isTrusted !== true
          || event.ctrlKey
          || event.metaKey
          || event.altKey
          || event.shiftKey
          || !scrollKeys.has(event.key)
        ) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      window.addEventListener('wheel', stopTrustedScroll, { capture: true, passive: false });
      window.addEventListener('touchmove', stopTrustedScroll, { capture: true, passive: false });
      window.addEventListener('keydown', stopTrustedScrollKey, { capture: true });
      window[key] = state;
    }
    if (${generation} >= state.generation) {
      state.generation = ${generation};
      state.locked = ${locked ? "true" : "false"};
    }
    return { generation: state.generation, locked: state.locked };
  })()`;
}

/** Arm or disarm the document-local Escape bridge without moving guest focus. */
export function buildGuestCaptureEscapeScript(id: string | null, generation: number): string {
  if (!Number.isInteger(generation) || generation < 0 || generation > Number.MAX_SAFE_INTEGER) {
    throw new Error("The guest capture-Escape generation is invalid.");
  }
  if (id !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
    throw new Error("The guest capture-Escape identifier is invalid.");
  }
  return `(() => {
    const key = Symbol.for(${JSON.stringify(GUEST_SCROLL_LOCK_SYMBOL)});
    const state = window[key];
    if (!state || typeof state !== 'object') {
      return { available: false, generation: -1, id: null };
    }
    if (${generation} >= state.captureEscapeGeneration) {
      state.captureEscapeGeneration = ${generation};
      state.captureEscapeId = ${id === null ? "null" : JSON.stringify(id)};
      state.captureEscapeRequestedId = null;
    }
    return {
      available: true,
      generation: state.captureEscapeGeneration,
      id: state.captureEscapeId
    };
  })()`;
}

/**
 * Atomically close an armed guest Escape window and report whether Escape was
 * already pressed before the non-abortable host commit boundary.
 */
export function buildGuestCaptureEscapeSealScript(
  id: string,
  armedGeneration: number,
  sealGeneration: number
): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
    throw new Error("The guest capture-Escape identifier is invalid.");
  }
  for (const generation of [armedGeneration, sealGeneration]) {
    if (!Number.isInteger(generation) || generation < 0 || generation > Number.MAX_SAFE_INTEGER) {
      throw new Error("The guest capture-Escape generation is invalid.");
    }
  }
  if (sealGeneration <= armedGeneration) {
    throw new Error("The guest capture-Escape seal generation must advance.");
  }
  return `(() => {
    const key = Symbol.for(${JSON.stringify(GUEST_SCROLL_LOCK_SYMBOL)});
    const state = window[key];
    if (!state || typeof state !== 'object') {
      return { available: false, generation: -1, id: null, matched: false, requested: false };
    }
    const matched = state.captureEscapeGeneration === ${armedGeneration}
      && state.captureEscapeId === ${JSON.stringify(id)};
    const requested = matched && state.captureEscapeRequestedId === ${JSON.stringify(id)};
    if (${sealGeneration} >= state.captureEscapeGeneration) {
      state.captureEscapeGeneration = ${sealGeneration};
      state.captureEscapeId = null;
      state.captureEscapeRequestedId = null;
    }
    return {
      available: true,
      generation: state.captureEscapeGeneration,
      id: state.captureEscapeId,
      matched,
      requested
    };
  })()`;
}
