export type FakeHoverPopover = {
  parent: { hoverPopover: FakeHoverPopover | null };
  targetEl: HTMLElement;
  hoverEl: HTMLElement;
  state: "showing" | "shown" | "hidden";
  hideCalls: number;
  show(): void;
  hide(): void;
};

export const hoverPopovers: FakeHoverPopover[];
export const notices: string[];
export function showPendingHoverPopovers(): void;
export function resetHoverRuntime(): void;
