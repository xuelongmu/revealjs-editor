import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  duplicateSlide,
  buildAgentPrompt,
  insertSlideAfter,
  moveSlide,
  parseManifest,
  readCopyBlocks,
  renderCopy,
  setSlideVisibility,
  shouldIgnoreWatchEvent,
  updateCopyMarkdown,
  updateHtmlBlock,
  updateHtmlBlockStyle
} from "../server/index.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixtureDeck = path.join(repoRoot, "fixtures", "decks", "basic-deck");

async function createDeckFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "revealjs-editor-"));
  const deckPath = path.join(tempRoot, "basic-deck");
  await fs.cp(fixtureDeck, deckPath, { recursive: true });
  return {
    deck: {
      id: "basic-deck",
      name: "basic-deck",
      path: deckPath,
      root: tempRoot
    },
    tempRoot
  };
}

test("parseManifest reads copy blocks and copy.md overrides", () => {
  const html = `
    <section data-slide-id="s01" data-slide-kind="title">
      <h1><!-- copy:s01.title -->HTML Title<!-- /copy --></h1>
    </section>
    <section data-slide-id="s02" data-visibility="hidden">
      <p><!-- copy:s02.body -->HTML Body<!-- /copy --></p>
    </section>
  `;
  const copyBlocks = readCopyBlocks("<!-- copy:s01.title -->\nMarkdown Title\n<!-- /copy -->");
  const manifest = parseManifest(html, copyBlocks);

  assert.equal(manifest.slides.length, 2);
  assert.equal(manifest.slides[0].kind, "title");
  assert.equal(manifest.slides[1].hidden, true);
  assert.equal(manifest.blocks[0].text, "Markdown Title");
  assert.deepEqual(manifest.blocks[0].textStyle?.tagName, "h1");
});

test("renderCopy supports the editor markdown subset safely", () => {
  assert.equal(
    renderCopy("A **bold** [link](https://example.com)\nNext"),
    'A <strong>bold</strong> <a class="copy-link" href="https://example.com" target="_blank" rel="noopener">link</a><br>Next'
  );
  assert.equal(
    renderCopy("- One\n- **Two**\n- `Three`"),
    '<ul class="copy-list"><li>One</li><li><strong>Two</strong></li><li><code>Three</code></li></ul>'
  );
  assert.equal(
    renderCopy("1. First\n2. ~~Second~~"),
    '<ol class="copy-list"><li>First</li><li><del>Second</del></li></ol>'
  );
  assert.equal(renderCopy("[bad](javascript:alert(1))"), "[bad](javascript:alert(1))");
});

test("updateHtmlBlock and updateHtmlBlockStyle mutate fixture HTML", async (t) => {
  const { deck, tempRoot } = await createDeckFixture();
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  await updateHtmlBlock(deck, "s01.body", "Updated **body**.");
  let html = await fs.readFile(path.join(deck.path, "index.html"), "utf8");
  assert.match(html, /Updated <strong>body<\/strong>\./);

  await updateHtmlBlock(deck, "s01.body", "- Partner workshops\n- Community access");
  html = await fs.readFile(path.join(deck.path, "index.html"), "utf8");
  assert.match(html, /<ul class="copy-list"><li>Partner workshops<\/li><li>Community access<\/li><\/ul>/);

  await updateHtmlBlockStyle(deck, "s01.title", { tagName: "h2", className: "hero-title" });
  html = await fs.readFile(path.join(deck.path, "index.html"), "utf8");
  assert.match(html, /<h2 class="hero-title"><!-- copy:s01\.title -->/);
  assert.match(html, /<!-- \/copy --><\/h2>/);
});

test("updateCopyMarkdown updates copy.md and sync fallback updates HTML", async (t) => {
  const { deck, tempRoot } = await createDeckFixture();
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const sync = await updateCopyMarkdown(deck, "s01.body", "Synced body.");
  assert.equal(sync.skipped, true);

  const markdown = await fs.readFile(path.join(deck.path, "copy.md"), "utf8");
  const html = await fs.readFile(path.join(deck.path, "index.html"), "utf8");
  assert.match(markdown, /<!-- copy:s01\.body -->\nSynced body\.\n<!-- \/copy -->/);
  assert.match(html, /<!-- copy:s01\.body -->Synced body\.<!-- \/copy -->/);
});

test("structural slide edits duplicate, insert, hide, and reorder", async (t) => {
  const { deck, tempRoot } = await createDeckFixture();
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const duplicate = await duplicateSlide(deck, "s01");
  assert.equal(duplicate.slideId, "s01-copy");

  let html = await fs.readFile(path.join(deck.path, "index.html"), "utf8");
  let manifest = parseManifest(html, readCopyBlocks(await fs.readFile(path.join(deck.path, "copy.md"), "utf8")));
  assert.equal(manifest.slides.length, 2);
  assert.ok(manifest.blocks.some((block) => block.id === "s01-copy.title"));

  const inserted = await insertSlideAfter(deck, "s01-copy");
  assert.equal(inserted.slideId, "new-slide");

  await setSlideVisibility(deck, "new-slide", true);
  html = await fs.readFile(path.join(deck.path, "index.html"), "utf8");
  manifest = parseManifest(html);
  assert.equal(manifest.slides.find((slide) => slide.id === "new-slide")?.hidden, true);

  await moveSlide(deck, "new-slide", "up");
  html = await fs.readFile(path.join(deck.path, "index.html"), "utf8");
  manifest = parseManifest(html);
  assert.deepEqual(manifest.slides.map((slide) => slide.id), ["s01", "new-slide", "s01-copy"]);

  await moveSlide(deck, "s01", { targetIndex: 3 });
  html = await fs.readFile(path.join(deck.path, "index.html"), "utf8");
  manifest = parseManifest(html);
  assert.deepEqual(manifest.slides.map((slide) => slide.id), ["new-slide", "s01-copy", "s01"]);
});

test("watcher ignores noisy paths", () => {
  assert.equal(shouldIgnoreWatchEvent(".git/index.lock"), true);
  assert.equal(shouldIgnoreWatchEvent("node_modules/pkg/index.js"), true);
  assert.equal(shouldIgnoreWatchEvent("deck/index.html"), false);
});

test("agent prompt uses explicit slide scope as current slide context", () => {
  const html = `
    <section data-slide-id="s01" data-slide-kind="title">
      <h1><!-- copy:s01.title -->Title<!-- /copy --></h1>
    </section>
    <section data-slide-id="s02" data-slide-kind="details">
      <p><!-- copy:s02.body -->Details<!-- /copy --></p>
    </section>
  `;
  const manifest = parseManifest(html);
  const prompt = buildAgentPrompt({
    deck: {
      id: "basic-deck",
      path: "C:\\decks\\basic-deck",
      root: "C:\\decks"
    },
    userPrompt: "Tighten the current slide.",
    scope: {
      blockId: "s01.title",
      slideId: "s02"
    },
    manifest
  });

  assert.match(prompt, /- Current slide: s02/);
  assert.match(prompt, /- Current slide index: 2/);
  assert.match(prompt, /- Current slide kind: details/);
  assert.match(prompt, /- Selected block: s01\.title/);
  assert.match(prompt, /- Selected block slide: s01/);
  assert.match(prompt, /- s02\.body: "Details"/);
  assert.doesNotMatch(prompt, /- s01\.title: "Title"/);
});
