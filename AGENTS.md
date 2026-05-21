# Agent Notes

This repository is a local-only RevealJS editor. Future agents should preserve the existing design goal: edit handcrafted RevealJS decks without migrating them into a rigid app schema.

## Working Context

- App repo: `D:\revealjs-editor`
- Default editor URL: `http://localhost:5173`
- Backend URL: `http://localhost:3030`
- Main files:
  - `server/index.mjs`
  - `src/App.tsx`
  - `src/styles.css`
  - `SPEC.md`
  - `README.md`

## Commands

Run from `D:\revealjs-editor`:

```powershell
npm run dev
npm run check
npm test
npm run build
node --check server\index.mjs
```

For decks that use `copy.md`, validate with the workspace sync script:

```powershell
node <workspace>\scripts\sync-copy.mjs <deck-id> --check
```

Use the appropriate deck id when validating a different deck.

## Implementation Principles

- Keep editing local-only. Do not add public write APIs or production editing controls.
- Preserve existing RevealJS HTML/CSS and slide dimensions unless explicitly asked.
- Prefer existing `copy.md` conventions for text changes.
- Treat `index.html` as structure/layout when `copy.md` exists.
- Keep changes scoped to the selected deck and requested behavior.
- Do not install packages unless the user explicitly asks and the need is clear.
- Do not revert unrelated deck changes. The selected deck workspace is likely dirty during editor use.

## Editable Block Contract

Editable text is identified by comment markers:

```html
<!-- copy:s03.t002 -->Text<!-- /copy -->
```

The backend parses these markers from `index.html` and returns a manifest of slides and blocks. The frontend then injects an overlay into the iframe to create hover and click targets.

Important:

- Block IDs must stay stable.
- Do not rewrite copy comments unnecessarily.
- Do not remove copy markers while editing visible text.
- Preserve hidden-slide attributes in source files.

## Current Editing Behavior

- Hovering an editable block in normal mode shows a highlight.
- Clicking an editable block enters edit mode and selects it.
- In-slide edits use `contenteditable`.
- Sidebar edits use a textarea plus formatting controls.
- Click-away auto-applies changed text.
- `Escape` cancels the active draft and must not save.
- `Ctrl+Z` and `Ctrl+Y` work for both active drafts and committed click-away saves.
- Most text saves patch the preview in place and should not reload the iframe.
- Current slide structure controls support duplicate, insert after, hide/show, move up, and move down.
- Structural slide edits are backend file writes against top-level `<section>` blocks. Duplicating and inserting append new `copy.md` blocks when `copy.md` exists.
- Workspace roots are loaded from `revealjs-editor.config.json`, overridden by `DECK_ROOTS`, and can be changed at runtime from the sidebar.

## Watcher Gotchas

The backend exposes deck change events through:

```text
GET /api/decks/:deckId/events
```

The frontend listens with `EventSource`.

Avoid disruptive reloads:

- Do not call `setReloadKey` for ordinary text saves.
- Use `previewBlockText`, `refreshOverlay`, and `refreshTextStyleOptions` for in-place updates.
- The frontend suppresses watcher events from its own saves with `ignoreOwnFileRefreshUntilRef`.
- External file changes should refresh the manifest, but if a block is actively selected, preview reload should be deferred.

## Hidden Slides

The backend serves preview HTML with source hidden slides made navigable locally. This should not write back to the deck.

Do not change deck source visibility unless the user specifically asks to change hidden slide behavior.

## Text Formatting

The editor supports a deliberately small inline markup subset:

```text
**bold**
*italic*
[label](https://example.com)
[email](mailto:name@example.com)
```

Safe link protocols are `http`, `https`, and `mailto`.

Keep frontend and backend renderers aligned:

- `src/App.tsx` has `renderInlineMarkup`
- `server/index.mjs` has `renderInline`
- `<workspace>\scripts\sync-copy.mjs` may also need matching behavior for decks that sync from `copy.md`

## Style Editing

The text style dropdown is inferred from existing editable block wrappers and computed CSS in the iframe. It stores changes by updating wrapper tag/class in `index.html`.

Gotchas:

- This is not a full design-token system.
- Style changes currently reload the iframe.
- If a CSS style is not represented by an existing editable block, it may not appear in the dropdown.

## Structural Slide Editing

Backend endpoints:

```text
POST /api/decks/:deckId/slides/:slideId/duplicate
POST /api/decks/:deckId/slides/:slideId/insert-after
PUT  /api/decks/:deckId/slides/:slideId/visibility
POST /api/decks/:deckId/slides/:slideId/move
```

Gotchas:

- These operations use the same top-level `<section>` parser as the manifest. Nested Reveal section stacks are not yet first-class.
- Duplicate and insert generate new `data-slide-id` values and new `copy:` block IDs.
- Duplicate and insert append blocks to `copy.md` when present.
- Reorder currently moves HTML sections only; it does not reorder `copy.md` headings.

## Codex Agent Jobs

Agent jobs are launched from `server/index.mjs` with `codex exec`.

Current command shape:

```text
codex --ask-for-approval never exec -C <deck-root> --add-dir <deck-path> --sandbox workspace-write --skip-git-repo-check --color never -
```

The `--ask-for-approval` flag is a top-level Codex flag in this CLI version. Placing it after `exec` causes:

```text
error: unexpected argument '--ask-for-approval' found
```

If Codex launch fails, run:

```powershell
codex --help
codex exec --help
```

## Validation Expectations

After code changes in this repo:

```powershell
npm run check
npm test
npm run build
```

After backend changes:

```powershell
node --check server\index.mjs
```

After changing copy rendering or deck sync behavior:

```powershell
node <workspace>\scripts\sync-copy.mjs <deck-id> --check
```

For frontend behavior changes, verify in the in-app browser when possible. Important flows to test:

- normal-mode hover highlight
- workspace picker and recent workspace buttons
- click editable text to enter edit mode
- click-away auto-apply without iframe reload
- `Escape` cancel without save
- `Ctrl+Z` / `Ctrl+Y` before and after click-away
- hidden slide navigation
- structural slide duplicate/insert/hide/reorder
- style dropdown and link formatting

## Future Work

- Add visual screenshot validation for changed slides.
- Add durable undo history.
- Add a proper review/apply/discard flow for Codex diffs.
- Add asset editing with guardrails.
- Add structural slide review gates and nested section support.
- Replace the minimal markdown renderer with a shared parser.
- Add a real style registry or design-token layer.
