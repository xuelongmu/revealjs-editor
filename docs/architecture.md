# Architecture

RevealJS Local Editor is a local web app with an Express backend, a Vite/React frontend, and a deck preview served from the local filesystem. The design goal is to edit existing handcrafted RevealJS decks without converting them into a rigid application schema.

## System Overview

```text
Browser
  React editor shell
  RevealJS iframe preview
  Floating Codex assistant

Local backend
  Express API
  Deck discovery and static serving
  HTML/copy.md parsing and file writes
  File watcher events
  Codex SDK thread execution

Local filesystem
  Workspace root
    deck-a/index.html
    deck-a/copy.md
    deck-a/assets/*
```

The frontend never writes deck files directly. It calls the backend, and the backend performs local filesystem operations against configured workspace roots.

## Key Files

```text
server/index.mjs                 Express server, deck parsing, writes, SSE, Codex SDK
src/App.tsx                      React editor shell and iframe overlay runtime
src/styles.css                   Editor and assistant UI styling
shared/presentationMarkdown.mjs  Shared safe markdown renderer
test/server.test.mjs             Backend and contract tests
SPEC.md                          Original product spec
```

## Runtime Flow

1. `npm run dev` starts the backend on `http://localhost:3030` and Vite on `http://localhost:5173`.
2. The frontend calls `GET /api/decks` to load available decks from configured roots.
3. The selected deck is loaded in an iframe from `/deck-content/:deckId/index.html`.
4. The backend serves deck assets from the deck folder with no-store caching.
5. The frontend calls `GET /api/decks/:deckId/manifest` to get slides and editable blocks.
6. The frontend injects an editor overlay into the iframe for hover, click, and inline editing.
7. Text edits are saved through backend APIs.
8. The frontend listens to server-sent events for deck changes and agent thread updates.

## Deck Discovery

Deck roots come from:

1. `revealjs-editor.config.json`
2. `DECK_ROOTS`
3. the in-app workspace picker

A deck is any child directory with an `index.html` file. Workspace roots are local paths; this is not a remote project browser.

## Deck Contract

The editor relies on stable copy markers:

```html
<!-- copy:s03.t002 -->Text<!-- /copy -->
```

Rules:

- Block IDs must be stable and unique.
- Text edits must preserve surrounding layout HTML.
- Existing copy markers should not be rewritten unless a slide is duplicated or inserted.
- Hidden slide source attributes should be preserved.
- `copy.md` is preferred for copy-only changes when present.

Recommended slide metadata:

```html
<section data-slide-id="s03" data-slide-kind="origin-story">
```

If `data-slide-id` is missing, the manifest parser derives an ID from slide position.

## Manifest Model

The backend parses `index.html` into:

- deck summary
- slide summaries
- editable block summaries
- block style metadata where available

The frontend uses the manifest for:

- sidebar slide list
- selected block state
- iframe overlay hit targets
- current slide context for the assistant
- style dropdown options

## Text Editing

Text can be edited directly inside the iframe or through the sidebar textarea.

Save behavior:

- With `copy.md`: update the matching block in `copy.md`, then run the sync path back into `index.html`.
- Without `copy.md`: update the matching copy marker in `index.html`.
- Patch the live preview in place for ordinary text saves.
- Avoid iframe reloads unless the operation changes structure or style.

The markdown subset is deliberately small and shared between frontend and backend:

- `**bold**`
- `*italic*`
- `~~strike~~`
- inline code
- `[label](https://example.com)`
- `[email](mailto:name@example.com)`
- unordered and ordered lists
- paragraph breaks

Only `http`, `https`, and `mailto` links are rendered as links.

## Iframe Overlay

The iframe remains the real RevealJS deck. The editor injects a lightweight overlay layer into the iframe document.

Responsibilities:

- compute editable block rectangles
- show hover highlights
- select blocks on click
- enable `contenteditable` for the active block
- track RevealJS slide changes
- preserve the current slide across reloads when possible

Hidden source slides are made navigable in the local preview by transforming hidden-slide attributes while serving preview HTML. This is editor-only behavior and should not write back to deck source.

## Structural Slide Editing

Structural operations are backend writes against top-level RevealJS `<section>` blocks:

```text
POST /api/decks/:deckId/slides/:slideId/duplicate
POST /api/decks/:deckId/slides/:slideId/insert-after
PUT  /api/decks/:deckId/slides/:slideId/visibility
POST /api/decks/:deckId/slides/:slideId/move
```

Current limits:

- Nested Reveal section stacks are not first-class.
- Duplicate and insert create new slide IDs and new copy block IDs.
- Duplicate and insert append new `copy.md` blocks when `copy.md` exists.
- Reorder moves HTML sections only; it does not reorder `copy.md` headings yet.

## Backend API

Workspace and deck APIs:

```text
GET  /api/decks
POST /api/workspaces
POST /api/workspaces/pick
GET  /api/decks/:deckId/manifest
GET  /api/decks/:deckId/events
```

Text and style APIs:

```text
PUT /api/decks/:deckId/blocks/:blockId
PUT /api/decks/:deckId/blocks/:blockId/style
```

Agent APIs:

```text
POST /api/decks/:deckId/agent-threads
GET  /api/agent-threads/:threadId
POST /api/agent-threads/:threadId/turns
GET  /api/agent-threads/:threadId/events
```

Static deck preview:

```text
GET /deck-content/:deckId/index.html
GET /deck-content/:deckId/*
```

## Watchers And Refresh

The backend uses file watchers per deck and exposes changes through:

```text
GET /api/decks/:deckId/events
```

Frontend behavior:

- self-triggered saves are ignored briefly to avoid duplicate reloads
- external edits refresh the manifest
- if a block is actively selected, preview reload can be deferred
- ordinary text saves patch the preview instead of reloading the iframe

## Codex Assistant

The assistant is a floating chat panel built with `@assistant-ui/react`. Backend execution uses `@openai/codex-sdk`.

Agent thread flow:

1. The frontend creates a thread with `POST /api/decks/:deckId/agent-threads`.
2. The frontend sends turns with `POST /api/agent-threads/:threadId/turns`.
3. The backend builds a scoped prompt containing deck path, current slide, selected block, copy blocks, and editing rules.
4. The backend streams Codex SDK events into an in-memory thread record.
5. The frontend receives updates from `GET /api/agent-threads/:threadId/events`.
6. The panel surfaces conversation turns, plan items, command activity, validation, and diff output.

The assistant supports chat and plan modes. `Ctrl+Enter` submits from the composer, and the Send button triggers the same path.

The assistant must remain local-scoped:

- no public write endpoints
- no hosted deck editing
- no remote asset mutation by default
- no writes outside configured workspace/deck scope

## Validation

After code changes, run:

```powershell
npm run check
npm test
npm run build
node --check server\index.mjs
```

For decks using `copy.md`, also run:

```powershell
node <workspace>\scripts\sync-copy.mjs <deck-id> --check
```

Frontend behavior changes should be verified in the browser when possible, especially:

- normal hover highlighting
- inline edit selection
- click-away save without iframe reload
- `Escape` cancel
- `Ctrl+Z` / `Ctrl+Y`
- hidden slide navigation
- slide duplicate/insert/hide/reorder
- assistant submit via Send and `Ctrl+Enter`

## Design Decisions

- HTML remains the deck source.
- Copy markers are the stable block identity contract.
- `copy.md` remains the text source where present.
- The editor is local-only and should not ship with public decks.
- The iframe displays the actual deck rather than a reimplemented slide renderer.
- The backend is the only component that writes files.
- Codex runs with explicit deck and slide context instead of broad project context.

## Known Limits

- Nested Reveal stacks are only partially supported.
- Reordering slides does not reorder `copy.md` sections.
- Style editing is inferred from existing editable blocks, not a token registry.
- Undo history is in-memory and session-scoped.
- Visual screenshot QA is not yet automated.
- Agent diff review/apply/discard is still future work.

