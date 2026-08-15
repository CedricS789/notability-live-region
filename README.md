# Notability Live Region

Keep typed reasoning in Obsidian while viewing Notability notes beside Markdown. Copy a visual rectangle, a supported PDF text selection, or a complete logical page as a self-contained Obsidian link or embed.

> [!IMPORTANT]
> Notability Live Region is an independent, unofficial community project. It is not affiliated with, endorsed by, or supported by Notability, Ginger Labs, or Obsidian. Notability is a trademark of Ginger Labs, Inc.

## Install

Once the plugin is accepted into the Obsidian Community directory:

1. Open **Settings → Community plugins → Browse**.
2. Search for **Notability Live Region**.
3. Select **Install**, then **Enable**.

Until then, advanced users can install a matching GitHub release manually by copying `main.js`, `manifest.json`, and `styles.css` into their vault's plugin directory. Do not mix files from different releases.

The plugin requires Obsidian 1.13.0 or newer on desktop. Mobile is not supported.

## Quick start

1. Open a Markdown note and place the cursor where a future embed should go.
2. Run **New Notability viewer** from the ribbon or command palette.
3. Paste a permitted `https://notability.com/app/note/...` URL and select **Load**.
4. Position the page using Notability while **Browse** is active.
5. Choose one capture action:
   - **Area**: drag one visual rectangle, then choose **Copy link** or **Copy embed**.
   - **Text**: select text in a rendered, text-based imported PDF, then copy it.
   - **Embed page**: capture the complete current logical page without drawing a rectangle.
6. Paste the copied result into Markdown, or enable **Insert on copy** before **Copy embed** to insert into the guarded Markdown cursor automatically.

Press `Esc` during an Area drag or while a capture explicitly says it is cancellable. The viewer restores its temporary zoom and page state before unlocking, and no new preview is saved. A final cache or clipboard write cannot be rolled back once it begins and is not presented as cancellable.

## Viewer and capture behavior

- **Browse** passes input to the real Notability web app. It may expose editing according to the signed-in account and note permissions.
- **Area** and **Text** lock physical wheel, trackpad, touch, and ordinary scroll-key movement. Position the note in Browse first. Entering or re-clicking either selection mode cancels an older saved-region alignment so it cannot snap back during a new selection.
- **Text** supports only unambiguous selection in a rendered PDF text layer. Handwriting, scans, native Notability pages, ambiguous selections, and cross-page selections fail closed without OCR; use Area instead.
- A successful copy clears the completed outline and returns the viewer to Browse. A failed operation preserves the selection mode for retry.
- Every invocation of **New Notability viewer** creates an independent tab. Multiple live webviews consume substantial memory, so close viewers that are no longer needed.

During raster capture, the plugin temporarily increases the Electron webview sampling scale and hides Notability's floating page navigator, drawing toolbars, zoom toast, tooltips, and open popovers. It verifies that this capture-only suppression remains active on both sides of every raster read, then restores the exact style it installed. If UI suppression, page identity, or geometry cannot be verified, the capture is discarded.

Complete-page capture divides the logical page into bounded tiles, verifies the same page around every tile, waits for rendering stability, and joins the tiles into one PNG. This can take several seconds. A harmless responsive resize across the temporary capture scale is accepted; a real note, page, orientation, or within-phase layout change is rejected.

## Insert on copy

**Insert on copy** is off by default and applies only to the current viewer session.

When enabled, **Copy embed** becomes **Copy + insert**. The plugin first copies the embed to the clipboard and then uses Obsidian's public editor transaction API to insert it into the exact Markdown editor selection recorded when the action began. It never simulates `Ctrl+V`.

The target file, editor, source mode, document, and selections must remain unchanged. If any guard fails, no note is modified and the already-copied embed remains available for manual paste. The toggle refuses to arm without an editable Markdown target, turns off if that target disappears, and turns off when the viewer is rebound to another Markdown editor so the new destination must be confirmed.

Insert on copy never runs from Area pointer-up, Text selection alone, **Copy link**, or **Refresh preview**.

## Links, embeds, and previews

Copied links use the app-owned `obsidian://notability-live-region` protocol and carry a canonical, self-contained region description. Opening one focuses or creates a matching viewer and aligns the saved region once.

Hold `Ctrl` while resting the pointer on a region link to show its local cached crop in an Obsidian hover preview. The hover path never opens or authenticates a Notability viewer. Reading View and Live Preview render `notability-region` metadata blocks as the same cached image.

Selected PDF text is used only as the visible Markdown label. Region metadata and cache records store the normalized rectangle and SHA-256 fingerprint, not the selected text.

## Exporting notes

Obsidian's native PDF/print renderer waits for cached preview images to decode. Print styles remove interactive controls and capture-age metadata. Missing or unreadable previews remain visible as an explicit printable error.

Raw Markdown, Word, HTML, Pandoc, and some third-party exporters do not run Obsidian postprocessors. Run **Create portable Notability export copy** from an active Markdown note to create:

```text
Notability Exports/<note>-<timestamp>/
├── <note>.md
└── notability-assets/
    └── <region-id>.png
```

The exported Markdown uses ordinary relative image links and strips plugin action URLs from visible links. The source note is never edited. The operation uses only the local cache, requires confirmation, validates image metadata and approved SHA-256 digests, writes into a staging folder, verifies the complete result, and publishes it with one final rename.

## Privacy and local data

- Settings, up to three recent Notability URLs, and the configured cache limit are stored in the plugin's Obsidian data file.
- Cached preview PNGs and `index.json` are stored below `<vault-config-dir>/plugins/notability-live-region/cache` through Obsidian's configured vault adapter.
- Preview cache files are private plugin data, not ordinary vault attachments. They become normal syncable PNGs only after an explicit portable export.
- The default cache limit is 5 GiB with least-recently-used pruning and no age expiration. Manual clearing is available in Settings and removes only recognized cache images.
- The plugin does not store selected PDF text, credentials, passwords, or Notability session cookies in its settings or cache.
- Notability authentication is handled by the embedded web session. The plugin reuses Obsidian's Web Viewer partition when available and otherwise uses a plugin partition.
- The plugin contains no client-side or server-side telemetry. In-memory timing measurements contain no note identity and are discarded with the viewer.

## Disclosures

- **Account:** A Notability account may be required depending on the note and its sharing permissions.
- **Network use:** The embedded viewer loads only user-supplied Notability note URLs and the resources those pages request. Notability receives ordinary web traffic and applies its own terms and privacy policy. Hover previews, cached embeds, settings, and portable export are local-only.
- **External files:** The plugin accesses no files outside the Obsidian vault through its runtime. The optional development deployer operates only on the exact vault explicitly supplied by its environment variable.
- **Vault writes:** Normal capture writes plugin-private cache data. Markdown changes occur only after explicit guarded insertion. Portable export writes ordinary Markdown and PNG files only after confirmation.
- **Payments, ads, and servers:** The plugin has no payment requirement, advertisements, plugin-operated server, analytics service, or remote update mechanism.
- **Permissions and copyright:** Capture only notes and material you own or are authorized to use. Sharing or exporting a preview does not grant rights to its source content.
- **Compatibility:** The integration depends on Notability's private web-page structure. Notability can change that structure without notice, which may temporarily break navigation, selection, UI suppression, or capture.

See Notability's [Terms of Use](https://notability.com/tos.html) and [Privacy Policy](https://notability.com/privacy.html) before using its service.

## Commands

- **New Notability viewer**
- **Toggle inserting Notability embeds on copy**
- **Create portable Notability export copy**

No command has a default hotkey. There is no bulk preview-rebuild command.

## Known limitations and roadmap

- Browse scrolling performance largely follows the embedded Notability web app and can be visibly jittery, especially with several live viewer tabs. Reproduction and frame-pacing benchmarks are tracked publicly before any further input interception is attempted.
- Manual Browse zoom remains Notability-owned. Precise discrete zoom controls are a planned improvement.
- Existing saved regions are immutable because their geometry is self-contained in Markdown. Resize handles are planned first for unsaved Area selections; safe persisted resizing requires a separate vault-wide migration.
- Graph View integration would require opt-in generated companion Markdown nodes. The plugin does not patch private Graph APIs.
- Mobile, OCR, general website adapters, and exact glyph-fragment restoration are not supported.

## Support and security

- Report reproducible bugs and feature requests through [GitHub Issues](https://github.com/CedricS789/notability-live-region/issues).
- Search existing issues before opening a duplicate and remove private note URLs, note content, credentials, and cache images unless they are safe to share publicly.
- Report security vulnerabilities privately through [GitHub Security Advisories](https://github.com/CedricS789/notability-live-region/security/advisories/new). Do not disclose an exploitable vulnerability in a public issue.
- Support is best effort for current Obsidian desktop releases and the current Notability web interface.

## Development

Requirements: Node.js 22 or newer and npm.

```bash
npm ci
npm run check
```

`npm run check` performs strict TypeScript validation, unit and deployment tests, a minified production build, release-metadata checks, bundle assertions, and publication privacy checks.

The production bundle is a GitHub release asset and is intentionally ignored by Git. To deploy a local build, close Obsidian and provide the exact vault explicitly:

```powershell
$env:NOTABILITY_LIVE_REGION_VAULT = 'D:\Path\To\Vault'
npm run deploy
```

The deployer verifies the vault marker, backs up every replaced artifact below the vault's `.tmp/` directory, stages and atomically replaces the runtime files, preserves plugin data and cache, and rolls back the set on failure. It never launches or closes Obsidian.

## License

[MIT](LICENSE) © 2026 Cédric Sipakam
