# Contributing

Thank you for helping improve Notability Live Region.

## Before opening a change

- Search existing issues and discussions.
- Use synthetic Notability note URLs and content in every report, fixture, screenshot, and test.
- Never commit credentials, session data, private note URLs, vault files, cached previews, or machine-specific paths.
- Keep changes narrowly scoped. Performance work must include a before/after measurement rather than replacing native Browse input speculatively.

## Development

Use Node.js 22 or newer:

```bash
npm ci
npm run check
```

`npm run check` must pass before a pull request is ready. Production `main.js` is generated and must not be committed.

## Pull requests

Describe the user-visible behavior, root cause for fixes, validation performed, and compatibility impact. Add focused tests for new behavior and preserve fail-closed capture, cache, URL, and editor-insertion boundaries.

By contributing, you agree that your work is licensed under the repository's MIT license.
