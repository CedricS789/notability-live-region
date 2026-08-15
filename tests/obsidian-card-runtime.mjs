export const notices = [];

export class Component {
  constructor() {
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    this.onload?.();
  }

  unload() {
    if (!this.loaded) return;
    this.loaded = false;
    this.onunload?.();
  }
}

export class MarkdownRenderChild extends Component {
  constructor(containerEl) {
    super();
    this.containerEl = containerEl;
  }
}

export class Notice {
  constructor(message) {
    this.message = message;
    notices.push(message);
  }

  hide() {}
}

export function setIcon(element, iconId) {
  element.dataset.icon = iconId;
}

export function resetCardRuntime() {
  notices.length = 0;
}
