export type CapturedNativeImage = {
  isEmpty(): boolean;
  getScaleFactors(): number[];
  getSize(scaleFactor?: number): { width: number; height: number };
  toPNG(options?: { scaleFactor?: number }): Uint8Array;
};

export interface ElectronWebviewElement extends HTMLElement {
  src: string;
  partition: string;
  loadURL(url: string): Promise<void>;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  getWebContentsId(): number;
  getURL(): string;
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<CapturedNativeImage>;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebviewElement;
  }

  /** Obsidian installs its DOM convenience factories on each workspace window. */
  interface Window {
    createDiv(): HTMLDivElement;
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
  }
}
