# RevealJS Local Editor

A local-only editor for existing RevealJS decks. It loads static RevealJS presentations from a selected local workspace, overlays editable text regions on the live deck, writes text edits back to the deck source, and can launch a scoped Codex agent job for broader presentation changes.

## Goals

- Preserve handcrafted RevealJS slide layouts.
- Avoid forcing decks into a rigid JSON, MDX, or component schema.
- Let text blocks be edited directly in the running presentation.
- Keep `copy.md` and `index.html` aligned for decks that use the copy sync convention.
- Keep all editing and Codex execution local-only.

## Quick Start

Install dependencies:

```powershell
npm install
```

Run the local editor:

```powershell
npm run dev
```

Open:

```text
http://localhost:5173
```

The backend runs on:

```text
http://localhost:3030
```

By default, the backend scans the included fixture decks. Use the workspace picker in the sidebar to choose the local folder that contains your RevealJS deck folders.

You can also set initial workspaces with `revealjs-editor.config.json`:

```json
{
  "deckRoots": [
    "fixtures/decks"
  ]
}
```

Relative paths are resolved from this repository root. `DECK_ROOTS` still works as an environment override:

```powershell
$env:DECK_ROOTS = "D:\path\to\deck-workspace"
npm run dev
```

Multiple initial roots can be separated with semicolons, but the in-app workspace picker currently switches to one selected root at a time.

## Scripts

```powershell
npm run dev       # Run Express backend and Vite frontend
npm run check     # Type-check frontend
npm test          # Run backend helper tests
npm run build     # Type-check and build frontend
npm run preview   # Preview built frontend
```

## Deck Requirements

Each deck must be a directory with an `index.html` file:

```text
deck-folder/
  index.html
  copy.md        optional
  assets/        optional
  bts-pics/      optional
  bts-video/     optional
  logos/         optional
  font/          optional
```

Editable text is discovered through copy comments:

```html
<!-- copy:s03.title -->Slide title<!-- /copy -->
```

If a deck has `copy.md`, text saves update `copy.md` first and then run the deck sync script:

```powershell
node .\scripts\sync-copy.mjs <deck-id>
node .\scripts\sync-copy.mjs <deck-id> --check
```

If a deck does not have `copy.md`, text saves fall back to replacing the matching copy block in `index.html`.

## Editing Flow

1. Choose a workspace folder with `Browse`, or paste a workspace path and click `Open`.
2. Select a deck in the sidebar.
3. Hover editable text in the slide preview. Normal mode shows highlight only on hover.
4. Click an editable block. This enters edit mode and selects the block.
5. Type directly in the slide, or use the sidebar text area.
6. Click away to auto-apply the edit.
7. Press `Escape` to cancel the active draft without saving.

The sidebar also supports:

- recently opened workspaces
- slide navigation, including hidden slides
- structural slide actions: duplicate, insert after, hide/show, move up, move down
- text style selection based on CSS styles found in the current deck
- bold and italic markdown insertion
- markdown link insertion
- Codex prompted edits

## Keyboard Behavior

Shortcuts are intentionally scoped to editing:

```text
Escape       cancel active draft and clear selection
Ctrl+Z       undo active draft, or undo last committed edit after click-away
Ctrl+Y       redo active draft, or redo last committed edit after click-away
Ctrl+Shift+Z redo active draft or committed edit
```

Global RevealJS navigation hotkeys are not used by the editor because they interfere with text editing.

## Codex Prompted Edits

The Codex pane launches a local `codex exec` process scoped to the selected deck root and deck folder. The generated prompt includes:

- user request
- current deck path
- selected block and current slide, when available
- current slide copy blocks
- deck editing conventions
- validation instructions

The backend captures:

- job status
- stdout and stderr
- validation result
- git diff for the deck path

The current command shape expects a recent Codex CLI:

```text
codex --ask-for-approval never exec -C <deck-root> --add-dir <deck-path> --sandbox workspace-write --skip-git-repo-check --color never -
```

If the CLI changes again, check:

```powershell
codex --help
codex exec --help
```

## Architecture

The app is split into:

```text
server/index.mjs   Express API, deck parsing, file writes, watcher, Codex jobs
src/App.tsx        React editor shell, iframe overlay, editing state, undo/redo
src/styles.css     Editor UI styling
```

The deck itself is loaded in an iframe from:

```text
/deck-content/:deckId/index.html
```

The React app draws an overlay inside the iframe by injecting a small editor stylesheet and a fixed-position hit layer. The overlay is generated from discovered `copy:` comments on the current Reveal slide.

### API Summary

```text
GET  /api/decks
GET  /api/decks/:deckId/manifest
PUT  /api/decks/:deckId/blocks/:blockId
PUT  /api/decks/:deckId/blocks/:blockId/style
POST /api/decks/:deckId/slides/:slideId/duplicate
POST /api/decks/:deckId/slides/:slideId/insert-after
PUT  /api/decks/:deckId/slides/:slideId/visibility
POST /api/decks/:deckId/slides/:slideId/move
POST /api/decks/:deckId/agent-jobs
GET  /api/agent-jobs/:jobId
GET  /api/decks/:deckId/events
```

## Architectural Decisions

- HTML remains the presentation source. The editor reads annotations from existing HTML instead of replacing deck structure with a schema.
- `copy.md` is respected where present. This keeps current deck authoring conventions intact.
- The editor is local-only. Published decks should not ship editor code, write endpoints, or Codex controls.
- Hidden slides are made visible only in the editor preview. The backend transforms `data-visibility="hidden"` to editor-only attributes when serving preview HTML.
- Text saves avoid iframe reloads where possible. The preview is patched in place, and self-triggered watcher events are suppressed to avoid disruptive reloads.
- Manual style changes update wrapper tag/class in `index.html`; text content remains in `copy.md` where that convention exists.
- Codex jobs run against the deck workspace with a conservative prompt and validation step, rather than operating through browser-exposed write powers.

## Gotchas

- Copy block IDs must be stable and unique. Duplicate or missing `copy:` markers make block targeting unreliable.
- The inline renderer only supports a small markdown subset: `**bold**`, `*italic*`, and `[label](url)` for safe `http`, `https`, and `mailto` links.
- Direct in-slide editing is text-first. Rich formatting is best applied from the sidebar because markdown syntax is the durable source form.
- File watching uses `fs.watch`, which can coalesce events or emit more than once on Windows. The frontend debounces watcher events and ignores its own saves for a short window.
- Any explicit iframe reload loses DOM selection, so most edit paths patch the preview in place.
- Style dropdown options are inferred from existing editable blocks and computed CSS in the iframe. If a style is not used by a current copy block, it may not appear.
- The editor stores last slide position in `localStorage` per deck.
- `D:\revealjs-editor` may not be a git repo. The referenced deck root usually is. Do not assume one repository owns both.
- Workspace paths are local machine paths. The browser cannot provide a stable filesystem path through a standard web directory input, so the local backend opens the native folder picker.
- Codex CLI flags are version-sensitive. In this environment, `--ask-for-approval` belongs before `exec`.
- Structural slide edits operate on the same top-level `<section>` model used by the manifest parser. Nested Reveal section stacks are not yet handled as a first-class structure.
- Duplicating or inserting slides updates `copy.md` when present by appending new copy blocks. Reordering does not reorder `copy.md` sections yet.

## Future Improvements

- Add a proper review/apply/discard flow for Codex diffs.
- Add structured changed-slide screenshots for visual QA.
- Add missing asset validation for images, video, fonts, and links.
- Add asset replacement controls with explicit review gates.
- Support a richer markdown parser instead of the current minimal renderer.
- Add persistent undo history across reloads or sessions.
- Add a design-token/style registry so the style dropdown is not limited to currently used editable blocks.
