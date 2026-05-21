# RevealJS Local Editor Spec

## Goal

Build a local-only editor for existing RevealJS decks that lets a user edit slide content directly inside the running presentation and prompt Codex to make broader deck changes.

The first target deck family is `D:\hypercentric-decks`, which currently uses standalone RevealJS `index.html` files with local assets and optional `copy.md` files. The editor must preserve the handcrafted design of these decks instead of forcing every slide into a rigid schema.

## Non-Goals

- Public web editing.
- Multi-user collaboration.
- Cloud auth.
- Hosted agent execution.
- Replacing RevealJS.
- Requiring existing decks to migrate to JSON, MDX, or React components.
- Publishing editor APIs or Codex controls with public decks.

## Operating Model

Editing is available only in a local development environment.

Example local editor URL:

```text
http://localhost:5173/decks/creative-ai-nyc?edit=1
```

Published decks remain static presentation artifacts:

```text
index.html
assets/
bts-pics/
bts-video/
logos/
font/
```

The public deck must not load the editor runtime, expose write endpoints, or provide Codex agent controls.

## Chosen Architecture

Use a hybrid annotated-HTML approach:

```text
HTML as source of truth
+ editable DOM annotations
+ optional copy.md compatibility
+ local backend for file writes
+ Codex agent for prompted changes
+ review gate for risky edits
```

This preserves bespoke HTML/CSS slide design while giving the editor stable handles for inline edits and agent-scoped changes.

## Deck Compatibility

The editor should support decks shaped like:

```text
deck-folder/
  index.html
  copy.md                  optional
  assets/                  optional
  bts-pics/                optional
  bts-video/               optional
  logos/                   optional
  font/                    optional
```

Initial reference decks:

```text
D:\hypercentric-decks\sponsorship-deck
D:\hypercentric-decks\creative-ai-nyc
D:\hypercentric-decks\generative-production-challenge
```

The editor must work with current copy marker blocks:

```html
<!-- copy:s03.t002 -->ComfyUI NYC proved the demand.<!-- /copy -->
```

Future-friendly annotated form:

```html
<section data-slide-id="s03" data-slide-kind="origin-story">
  <h2 data-editable="text" data-block-id="s03.title">
    <!-- copy:s03.title -->ComfyUI NYC proved the demand.<!-- /copy -->
  </h2>
</section>
```

For existing decks that only have `copy:` comments, the editor should infer editable text blocks from those comments.

## Annotation Contract

### Slides

Recommended slide annotation:

```html
<section data-slide-id="s03" data-slide-kind="origin-story">
```

Fields:

- `data-slide-id`: stable logical slide ID.
- `data-slide-kind`: optional descriptive type for humans and agents.

If missing, derive slide ID from position:

```text
s01
s02
s03
```

### Editable Text

Recommended:

```html
<p data-editable="text" data-block-id="s03.lead">...</p>
```

Current compatible form:

```html
<p><!-- copy:s03.lead -->...<!-- /copy --></p>
```

Rules:

- Every editable text block must have a stable block ID.
- Existing `copy:` IDs count as stable block IDs.
- Inline editing must preserve surrounding HTML structure.
- Plain text edits should HTML-escape unsafe content.
- Existing safe Markdown links in `copy.md` may continue to render as links through the current sync behavior.

### Editable Assets

Recommended:

```html
<img
  data-editable="asset"
  data-block-id="s03.image.1"
  src="assets/bts_4.webp"
  alt="Creative AI community event"
>
```

Supported asset targets:

- `img[src]`
- `video[src]`
- inline background images on known containers, where practical

Asset editing is review-gated in the first version.

## User Flows

### Open Deck

1. User starts the local editor.
2. User selects or provides a deck folder.
3. Editor serves the deck through a local URL.
4. RevealJS initializes normally.
5. Editor scans the document for editable blocks.

### Toggle Edit Mode

User presses `E` or uses an editor toggle.

Edit mode shows:

- subtle hover outlines on editable blocks
- current slide ID
- selected block ID
- local save state
- prompt drawer entry point

Reveal navigation remains usable.

### Inline Text Edit

1. User clicks editable text.
2. Text becomes editable in place.
3. User commits with `Enter`, blur, or explicit save.
4. Editor writes the change to the source file.
5. If `copy.md` exists and the block maps to a `copy:` region, update `copy.md`.
6. Sync `copy.md` back into `index.html` when the deck uses that convention.
7. Refresh only what is needed to keep the current slide stable.

### Prompted Edit

1. User opens the prompt drawer.
2. User chooses scope:
   - selected block
   - current slide
   - slide range
   - whole deck
3. User enters a prompt.
4. Backend creates a Codex agent job with deck context.
5. Agent modifies files in the local workspace.
6. Editor shows diff, validation, and preview.
7. User applies, discards, or asks for a revision.

Example prompts:

```text
Make this slide sharper for a sponsor audience.
```

```text
Add a slide after this one explaining why in-person workflow demos matter.
```

```text
Replace this image with something more production-focused from the assets folder.
```

## Codex Agent Contract

Agent prompts must be scoped and conservative.

Template:

```text
You are editing a local RevealJS deck.

User request:
{userPrompt}

Scope:
Deck folder: {deckFolder}
Current slide: {slideId}
Selected block: {blockId}

Rules:
- Prefer editing copy.md for copy-only changes when copy.md exists.
- Edit index.html only when structure, layout, assets, or styling must change.
- Preserve existing copy block IDs unless intentionally creating new blocks.
- Keep asset paths relative to the deck folder.
- Preserve RevealJS dimensions unless explicitly asked.
- Do not remove slides, pricing, metrics, or sponsor-facing claims without review.
- After edits, run the deck validation commands.
```

## Risk Model

### Auto-Apply Candidates

These can be auto-applied after validation:

- single-block text edits
- typo fixes
- copy rewrites scoped to selected block
- speaker-note edits if notes support is added

### Review Required

These require explicit user approval:

- adding slides
- deleting slides
- reordering slides
- changing CSS
- changing layout HTML
- changing images or videos
- changing sponsor pricing
- changing attendance, reach, or performance metrics
- changing hidden slide visibility
- adding external links or remote assets

### Blocked For MVP

These should not be performed by the in-presentation editor:

- publishing to production
- installing packages
- running arbitrary shell commands from the browser
- modifying files outside the selected deck or configured workspace

## Backend Responsibilities

The local backend should provide:

- deck discovery
- static serving of deck folders
- parsing editable blocks
- updating `index.html`
- updating `copy.md` when present
- running sync checks
- launching Codex agent jobs
- reading job status and logs
- returning diffs
- validating rendered decks where practical

Suggested API shape:

```text
GET  /api/decks
GET  /api/decks/:deckId/manifest
POST /api/decks/:deckId/blocks/:blockId
POST /api/decks/:deckId/agent-jobs
GET  /api/agent-jobs/:jobId
POST /api/agent-jobs/:jobId/apply
POST /api/agent-jobs/:jobId/discard
```

## Frontend Responsibilities

The editor runtime should provide:

- RevealJS wrapper or injected overlay
- edit mode toggle
- block hover and selection
- inline text editor
- slide toolbar
- prompt drawer
- asset picker
- diff/review panel
- validation status
- keyboard shortcuts

Initial shortcuts:

```text
E       toggle edit mode
Esc     close editor UI or cancel active edit
Enter   commit inline edit
Ctrl+Z  undo local unsaved edit where possible
```

## Validation

For `D:\hypercentric-decks`, validation should include:

```powershell
node .\scripts\sync-copy.mjs <deck-folder> --check
```

Additional validation targets:

- `index.html` exists
- all local image/video/font references resolve
- all `copy:` blocks have unique IDs
- `copy.md` blocks match `index.html` blocks when `copy.md` exists
- RevealJS can load the deck locally
- current slide can render at 1920 x 1080

Visual QA should eventually include screenshots at 1920 x 1080 for changed slides.

## Suggested Implementation Phases

### Phase 1: Local Deck Viewer

- Create Vite app and local backend.
- Configure allowed deck roots.
- Serve an existing deck from `D:\hypercentric-decks`.
- Load it in an iframe or controlled route.
- Confirm RevealJS navigation still works.

### Phase 2: Editable Block Discovery

- Parse `index.html`.
- Discover `copy:` blocks.
- Infer slide IDs from containing `<section>`.
- Return a manifest of slides and editable blocks.
- Overlay hover outlines in edit mode.

### Phase 3: Inline Text Editing

- Select a text block.
- Edit text in place.
- Write through to `copy.md` when present.
- Run existing sync script.
- Refresh deck without losing current slide.

### Phase 4: Prompt Drawer And Job Shell

- Add prompt drawer.
- Capture scope and context.
- Create local job records.
- Show pending/running/complete states.

### Phase 5: Codex Integration

- Launch Codex agent with scoped prompt.
- Let agent edit local deck files.
- Collect changed files and diff.
- Run validation.
- Show review panel.

### Phase 6: Asset And Structural Editing

- Add asset picker.
- Support image/video swaps.
- Support slide duplicate, hide, and move.
- Require review for structural changes.

### Phase 7: Render QA

- Add changed-slide screenshot capture.
- Detect missing assets and obvious clipping.
- Keep validation results visible before apply.

## Open Questions

- Should the editor modify `index.html` directly for decks with `copy.md`, or always modify `copy.md` first for text?
- Should `copy.md` remain generated from `index.html`, or continue as a human-edited source?
- Should editor annotations be added automatically to existing decks?
- Should Codex jobs run in the current repo, the deck repo, or a temporary worktree?
- Should the editor support undo by git diff, file snapshots, or an internal history log?
- How much structural editing should be exposed before a component/template system exists?

## Recommended First Milestone

Build a local editor that opens `D:\hypercentric-decks\creative-ai-nyc`, toggles edit mode, lets the user edit one existing `copy:` text block inline, updates `copy.md`, runs `sync-copy.mjs creative-ai-nyc --check`, and keeps the deck visually unchanged except for the edited text.
