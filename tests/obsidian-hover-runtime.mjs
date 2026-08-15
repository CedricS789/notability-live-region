export const hoverPopovers = [];
export const notices = [];

export class Component {
  constructor() {
    this.loaded = false;
    this.events = [];
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    this.onload?.();
  }

  unload() {
    if (!this.loaded) return;
    this.loaded = false;
    while (this.events.length > 0) this.events.pop()();
    this.onunload?.();
  }

  register(callback) {
    this.events.push(callback);
  }

  registerDomEvent(element, type, callback, options) {
    element.addEventListener(type, callback, options);
    this.register(() => element.removeEventListener(type, callback, options));
  }
}

export class MarkdownRenderChild extends Component {
  constructor(containerEl) {
    super();
    this.containerEl = containerEl;
  }
}

export class HoverPopover extends Component {
  constructor(parent, targetEl) {
    super();
    this.parent = parent;
    this.targetEl = targetEl;
    this.hoverEl = targetEl.ownerDocument.createElement("div");
    this.hoverEl.className = "popover hover-popover";
    this.state = "showing";
    this.hideCalls = 0;
    this.onTarget = true;
    this.onHover = false;
    this.hideTimer = null;
    this.targetMouseover = (event) => {
      if (!this.movedWithin(event, this.targetEl)) {
        this.onTarget = true;
        this.transition();
      }
    };
    this.targetMouseout = (event) => {
      if (!this.movedWithin(event, this.targetEl)) {
        this.onTarget = false;
        this.transition();
      }
    };
    this.hoverMouseover = () => {
      this.onHover = true;
      this.transition();
    };
    this.hoverMouseout = () => {
      this.onHover = false;
      this.transition();
    };
    targetEl.addEventListener("mouseover", this.targetMouseover);
    targetEl.addEventListener("mouseout", this.targetMouseout);
    this.hoverEl.addEventListener("mouseover", this.hoverMouseover);
    this.hoverEl.addEventListener("mouseout", this.hoverMouseout);
    hoverPopovers.push(this);
  }

  movedWithin(event, root) {
    const NodeConstructor = root.ownerDocument.defaultView?.Node;
    return Boolean(
      NodeConstructor
      && event.relatedTarget instanceof NodeConstructor
      && root.contains(event.relatedTarget)
    );
  }

  transition() {
    if (this.onTarget || this.onHover) {
      if (this.hideTimer !== null) {
        this.targetEl.ownerDocument.defaultView.clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      return;
    }
    if (this.state === "showing") {
      this.hide();
      return;
    }
    if (this.state === "shown" && this.hideTimer === null) {
      this.hideTimer = this.targetEl.ownerDocument.defaultView.setTimeout(() => {
        this.hideTimer = null;
        if (!this.onTarget && !this.onHover) this.hide();
      }, 5);
    }
  }

  show() {
    if (this.state !== "showing") return;
    // Deliberately matches Obsidian's delayed onShow ownership sequence.
    this.parent.hoverPopover?.hide();
    if (this.state === "hidden") return;
    this.parent.hoverPopover = this;
    this.state = "shown";
    this.targetEl.ownerDocument.body.append(this.hoverEl);
    this.load();
  }

  hide() {
    this.hideCalls += 1;
    if (this.state === "hidden") return;
    this.state = "hidden";
    if (this.hideTimer !== null) {
      this.targetEl.ownerDocument.defaultView.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.targetEl.removeEventListener("mouseover", this.targetMouseover);
    this.targetEl.removeEventListener("mouseout", this.targetMouseout);
    this.hoverEl.removeEventListener("mouseover", this.hoverMouseover);
    this.hoverEl.removeEventListener("mouseout", this.hoverMouseout);
    this.hoverEl.remove();
    if (this.parent.hoverPopover === this) this.parent.hoverPopover = null;
    this.unload();
  }
}

export class Notice {
  constructor(message) {
    this.message = message;
    notices.push(message);
  }

  hide() {}
}

export function showPendingHoverPopovers() {
  for (const popover of hoverPopovers) popover.show();
}

export function resetHoverRuntime() {
  for (const popover of hoverPopovers) popover.hide();
  hoverPopovers.length = 0;
  notices.length = 0;
}
