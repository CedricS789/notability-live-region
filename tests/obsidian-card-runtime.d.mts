export const notices: string[];

export class Component {
  loaded: boolean;
  load(): void;
  unload(): void;
}

export class MarkdownRenderChild extends Component {
  readonly containerEl: HTMLElement;
  constructor(containerEl: HTMLElement);
}

export class Notice {
  readonly message: string;
  constructor(message: string);
  hide(): void;
}

export function setIcon(element: HTMLElement, iconId: string): void;
export function resetCardRuntime(): void;
