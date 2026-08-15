# Changelog

All notable changes to Notability Live Region are documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-08-15

### Added

- Independent Notability viewer tabs beside Markdown.
- Area, supported PDF-text, and complete logical-page capture.
- Self-contained internal links, cached embeds, and Ctrl-hover previews.
- Guarded session-only **Insert on copy** delivery.
- Portable Markdown export copies with ordinary PNG assets.
- Native Reading View and PDF/print rendering support.
- Escape cancellation with mandatory viewer restoration.
- Capture-only suppression of floating Notability interface elements.
- Configurable 5 GiB local preview cache with safe pruning and clearing.

### Changed

- Cache storage now follows Obsidian's configured vault directory instead of assuming `.obsidian`.
- Production releases are minified and built reproducibly through GitHub Actions.
- The optional local deployer requires an explicit vault environment variable.

### Removed

- Dormant bulk preview-rebuild interface and runner.
- Plugin-unload behavior that detached open viewer leaves.

[1.0.0]: https://github.com/CedricS789/notability-live-region/releases/tag/1.0.0
