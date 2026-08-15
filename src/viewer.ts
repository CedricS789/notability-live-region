import type { ElectronWebviewElement } from "./webview-types";

/** Obsidian's own vault-scoped Web Viewer session is preferred to avoid a second Notability login. */
export const NOTABILITY_VIEWER_PARTITION = "persist:notability-live-region";

export type NotabilityWebviewHandle = {
  readonly partition: string;
  dispose(): void;
};

export function isNotabilityViewerPartition(value: string): boolean {
  return value === NOTABILITY_VIEWER_PARTITION || /^persist:vault-[a-z0-9_-]+$/i.test(value);
}

export function resolveNotabilityViewerPartition(app: unknown): string {
  const getter = (app as { getWebviewPartition?: () => unknown } | null)?.getWebviewPartition;
  if (typeof getter === "function") {
    try {
      const value = getter.call(app);
      if (typeof value === "string" && isNotabilityViewerPartition(value)) return value;
    } catch {
      // Fall back to the plugin's own persistent partition.
    }
  }
  return NOTABILITY_VIEWER_PARTITION;
}

/**
 * Prepare an ordinary Electron webview for Notability. V1 deliberately does
 * not claim to sandbox an authenticated page; it relies on Obsidian/Electron
 * for the viewer and restricts only the note URLs accepted by plugin commands.
 */
export function prepareNotabilityWebview(
  webview: ElectronWebviewElement,
  partition = NOTABILITY_VIEWER_PARTITION
): NotabilityWebviewHandle {
  if (!isNotabilityViewerPartition(partition)) throw new Error("The Notability viewer partition is invalid.");
  webview.partition = partition;
  webview.src = "about:blank";
  webview.setAttribute("partition", partition);
  webview.setAttribute("src", "about:blank");
  webview.setAttribute("allowpopups", "");
  webview.setAttribute("webpreferences", [
    "contextIsolation=yes",
    "sandbox=yes",
    "nodeIntegration=no",
    "nodeIntegrationInWorker=no",
    "nodeIntegrationInSubFrames=no",
    "webSecurity=yes",
    "allowRunningInsecureContent=no",
    "webviewTag=no",
    "plugins=no",
    "experimentalFeatures=no",
    "navigateOnDragDrop=no"
  ].join(","));
  webview.removeAttribute("preload");
  webview.removeAttribute("disablewebsecurity");

  let disposed = false;
  return {
    partition,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      webview.remove();
    }
  };
}
