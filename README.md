# RevealJS Local Editor

A local-only editor for handcrafted RevealJS decks.

The editor opens existing static RevealJS presentations from a local workspace, overlays editable text targets on the live deck preview, writes changes back to the deck source, and exposes a floating Codex assistant for scoped deck work.

## Why This Exists

Many RevealJS decks are intentionally bespoke: custom HTML, custom CSS, local media, and hand-tuned slide layouts. This project keeps that model intact. It does not migrate decks into a JSON schema, React component model, or hosted CMS.

Core goals:

- Preserve existing RevealJS HTML, CSS, media, and slide dimensions.
- Edit annotated copy directly in the running presentation.
- Respect `copy.md` when a deck uses that convention.
- Keep all file writes and agent execution local.
- Make Codex assistance aware of the current deck, slide, and selected block.

## Quick Start

Install dependencies:

```powershell
npm install
```

Run the editor:

```powershell
npm run dev
```

Open the app:

```text
http://localhost:5173
```

The backend runs at:

```text
http://localhost:3030
```

Use the workspace picker in the sidebar to select a local folder that contains RevealJS deck folders.

## Deck Shape

Each deck is a folder with an `index.html` file:

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

Editable text is discovered through stable copy markers:

```html
<!-- copy:s03.t002 -->Text to edit<!-- /copy -->
```

When `copy.md` exists, text saves update `copy.md` first and sync back into `index.html`. Without `copy.md`, the editor patches the matching copy block in `index.html`.

## Features

- Local workspace picker with recent workspaces.
- Live RevealJS preview in an iframe.
- Hover and click targets for editable copy blocks.
- In-slide `contenteditable` editing.
- Sidebar text editing with small markdown formatting controls.
- Click-away save, `Escape` cancel, `Ctrl+Z`, and `Ctrl+Y`.
- Slide navigation, hide/show, duplicate, insert-after, and drag reorder.
- Style picker inferred from existing editable block wrappers.
- Floating Codex assistant with chat and plan modes.
- Agent turns scoped to the current deck, selected slide, and selected block.

## Scripts

```powershell
npm run dev       # Run Express backend and Vite frontend
npm run check     # Type-check frontend
npm test          # Run backend/helper tests
npm run build     # Type-check and build frontend
npm run preview   # Preview the production build
```

For decks that use `copy.md`, validate sync with:

```powershell
node .\scripts\sync-copy.mjs <deck-id> --check
```

## Configuration

Initial deck roots can be configured with `revealjs-editor.config.json`:

```json
{
  "deckRoots": ["fixtures/decks"]
}
```

Relative paths resolve from the repository root. `DECK_ROOTS` can override this at startup:

```powershell
$env:DECK_ROOTS = "D:\path\to\deck-workspace"
npm run dev
```

Multiple roots can be separated with semicolons. The in-app picker switches to one selected workspace at a time.

## Documentation

- [Architecture](docs/architecture.md)
- [Docs index](docs/README.md)
- [Original project spec](SPEC.md)

## Local-Only Boundary

This project is intended for local editing only. Published decks should remain static RevealJS artifacts and should not include editor runtime code, write endpoints, or Codex controls.
