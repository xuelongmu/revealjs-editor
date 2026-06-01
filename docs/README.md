# Documentation

This directory documents how the RevealJS Local Editor is structured and how its editing contracts work.

## Contents

- [Architecture](architecture.md): system overview, runtime flow, data model, APIs, and agent integration.
- [Project spec](../SPEC.md): original product and implementation plan.
- [Root README](../README.md): quick start and user-facing overview.

## Maintenance Notes

Keep these docs aligned with:

- `server/index.mjs` for backend routes, file writes, watchers, and Codex SDK behavior.
- `src/App.tsx` for editor state, iframe overlay behavior, assistant UI, and keyboard handling.
- `shared/presentationMarkdown.mjs` for the markdown subset rendered by both frontend and backend.
- `test/server.test.mjs` for documented contracts that have executable coverage.

