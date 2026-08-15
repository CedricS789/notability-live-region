import type { ElectronWebviewElement } from "./webview-types";

const CAPTURE_CHROME_STYLE_ATTRIBUTE = "data-obsidian-notability-capture-chrome";

/**
 * Stable semantic anchors are preferred over Notability's generated CSS-module
 * hashes. Prefix fallbacks cover the two known floating controls when their
 * semantic attribute is temporarily absent during a React transition.
 */
export const NOTABILITY_CAPTURE_CHROME_SELECTOR = [
  '[data-testid="page-navigator"]',
  '[class*="PageNavigator_container__"]',
  '[role="toolbar"]',
  '[class*="SharedStyles_toolbarItemBorderStyles__"]',
  '[role="status"][class*="ZoomToast_container__"]',
  '[data-radix-popper-content-wrapper]',
  '[role="tooltip"]'
].join(",\n");

const CAPTURE_CHROME_CSS = `${NOTABILITY_CAPTURE_CHROME_SELECTOR} {
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}`;

function validateCaptureChromeToken(token: string): void {
  if (!/^nlr-ui-[a-z0-9-]{8,}$/.test(token)) {
    throw new Error("Notability capture-chrome token is invalid.");
  }
}

function captureChromeInspectionBody(): string {
  return `
    const styles = [...document.querySelectorAll('style[' + attribute + ']')];
    const owned = styles.filter((style) => style.getAttribute(attribute) === token);
    const targets = [...document.querySelectorAll(selector)];
    const exposed = targets.filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0;
    });
  `;
}

function hideCaptureChromeScript(token: string): string {
  return `(() => {
    const token = ${JSON.stringify(token)};
    const attribute = ${JSON.stringify(CAPTURE_CHROME_STYLE_ATTRIBUTE)};
    const selector = ${JSON.stringify(NOTABILITY_CAPTURE_CHROME_SELECTOR)};
    for (const stale of document.querySelectorAll('style[' + attribute + ']')) stale.remove();
    const host = document.head || document.documentElement;
    if (!host) return { ok: false, token, styleCount: 0, matched: 0, exposed: 0 };
    const style = document.createElement('style');
    style.setAttribute(attribute, token);
    style.textContent = ${JSON.stringify(CAPTURE_CHROME_CSS)};
    host.appendChild(style);
    ${captureChromeInspectionBody()}
    return {
      ok: style.isConnected && owned.length === 1 && exposed.length === 0,
      token,
      styleCount: owned.length,
      matched: targets.length,
      exposed: exposed.length
    };
  })()`;
}

function assertCaptureChromeScript(token: string): string {
  return `(() => {
    const token = ${JSON.stringify(token)};
    const attribute = ${JSON.stringify(CAPTURE_CHROME_STYLE_ATTRIBUTE)};
    const selector = ${JSON.stringify(NOTABILITY_CAPTURE_CHROME_SELECTOR)};
    ${captureChromeInspectionBody()}
    return {
      ok: owned.length === 1 && exposed.length === 0,
      token,
      styleCount: owned.length,
      matched: targets.length,
      exposed: exposed.length
    };
  })()`;
}

function restoreCaptureChromeScript(token: string): string {
  return `(() => {
    const token = ${JSON.stringify(token)};
    const attribute = ${JSON.stringify(CAPTURE_CHROME_STYLE_ATTRIBUTE)};
    const styles = [...document.querySelectorAll('style[' + attribute + ']')];
    const owned = styles.filter((style) => style.getAttribute(attribute) === token);
    for (const style of owned) style.remove();
    const remaining = [...document.querySelectorAll('style[' + attribute + ']')]
      .filter((style) => style.getAttribute(attribute) === token).length;
    return { ok: owned.length === 1 && remaining === 0, token, removed: owned.length, remaining };
  })()`;
}

function validResult(value: unknown, token: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  return result.token === token ? result : null;
}

/** Hide floating Notability UI without changing its layout geometry. */
export async function hideNotabilityCaptureChrome(
  webview: ElectronWebviewElement,
  token: string
): Promise<void> {
  validateCaptureChromeToken(token);
  const result = validResult(await webview.executeJavaScript(hideCaptureChromeScript(token)), token);
  if (result?.ok !== true || result.styleCount !== 1 || result.exposed !== 0) {
    throw new Error("Notability capture controls could not be hidden safely.");
  }
}

/** Fail closed if the suppression style vanished or known chrome became visible. */
export async function assertNotabilityCaptureChromeHidden(
  webview: ElectronWebviewElement,
  token: string
): Promise<void> {
  validateCaptureChromeToken(token);
  const result = validResult(await webview.executeJavaScript(assertCaptureChromeScript(token)), token);
  if (result?.ok !== true || result.styleCount !== 1 || result.exposed !== 0) {
    throw new Error("Notability capture controls became visible during capture.");
  }
}

/** Restore the guest UI only when the exact capture-owned style is present. */
export async function restoreNotabilityCaptureChrome(
  webview: ElectronWebviewElement,
  token: string
): Promise<void> {
  validateCaptureChromeToken(token);
  const result = validResult(await webview.executeJavaScript(restoreCaptureChromeScript(token)), token);
  if (result?.ok !== true || result.removed !== 1 || result.remaining !== 0) {
    throw new Error("Notability capture controls could not be restored safely.");
  }
}
