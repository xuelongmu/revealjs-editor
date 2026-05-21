import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";

const execFileAsync = promisify(execFile);
const app = express();
const port = Number(process.env.PORT || 3030);
const modulePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(modulePath), "..");
const configPath = process.env.REVEAL_EDITOR_CONFIG
  ? path.resolve(process.env.REVEAL_EDITOR_CONFIG)
  : path.join(repoRoot, "revealjs-editor.config.json");
const defaultDeckRoot = path.join(process.cwd(), "fixtures", "decks");
let deckRoots = await loadInitialDeckRoots();

const blockPattern = /<!--\s*copy:([a-z0-9._-]+)\s*-->([\s\S]*?)<!--\s*\/copy\s*-->/gi;
const jobs = new Map();
const deckWatchers = new Map();

app.use(express.json({ limit: "1mb" }));

async function loadInitialDeckRoots() {
  if (process.env.DECK_ROOTS) {
    return process.env.DECK_ROOTS
      .split(";")
      .map((value) => path.resolve(value.trim()))
      .filter(Boolean);
  }

  const rawConfig = await fs.readFile(configPath, "utf8").catch(() => null);
  if (rawConfig) {
    const config = JSON.parse(rawConfig);
    const configuredRoots = Array.isArray(config.deckRoots) ? config.deckRoots : [];
    const resolvedRoots = configuredRoots
      .map((value) => path.resolve(repoRoot, String(value || "").trim()))
      .filter(Boolean);
    if (resolvedRoots.length) return resolvedRoots;
  }

  return [defaultDeckRoot];
}

function assertSafeId(value) {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    const error = new Error(`Unsafe identifier: ${value}`);
    error.status = 400;
    throw error;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function shouldIgnoreWatchEvent(filename = "") {
  const normalized = String(filename).replaceAll("\\", "/");
  return (
    normalized.includes("/.git/") ||
    normalized.startsWith(".git/") ||
    normalized.includes("/node_modules/") ||
    normalized.startsWith("node_modules/") ||
    normalized.endsWith("~") ||
    normalized.endsWith(".tmp")
  );
}

function sendDeckEvent(client, eventName, payload) {
  client.write(`event: ${eventName}\n`);
  client.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function closeDeckWatchers() {
  for (const state of deckWatchers.values()) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.watcher?.close?.();
    for (const client of state.clients) {
      sendDeckEvent(client, "workspace-change", {
        changedAt: new Date().toISOString()
      });
      client.end();
    }
  }
  deckWatchers.clear();
}

async function setDeckRoots(nextRoots) {
  const resolvedRoots = nextRoots
    .map((value) => path.resolve(String(value || "").trim()))
    .filter(Boolean);

  if (!resolvedRoots.length) {
    const error = new Error("At least one workspace path is required.");
    error.status = 400;
    throw error;
  }

  for (const root of resolvedRoots) {
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) {
      const error = new Error(`Workspace is not a directory: ${root}`);
      error.status = 400;
      throw error;
    }
  }

  deckRoots = Array.from(new Set(resolvedRoots));
  closeDeckWatchers();
  return deckRoots;
}

async function pickWorkspaceDirectory() {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select a RevealJS deck workspace'",
    "$dialog.ShowNewFolderButton = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }"
  ].join("; ");

  const result = await execFileAsync(
    "powershell",
    ["-NoProfile", "-STA", "-Command", script],
    {
      cwd: process.cwd(),
      windowsHide: false,
      timeout: 1000 * 60 * 10
    }
  );

  return result.stdout.trim();
}

function ensureDeckWatcher(deck) {
  const existing = deckWatchers.get(deck.id);
  if (existing) return existing;

  const state = {
    clients: new Set(),
    debounceTimer: null,
    watcher: null
  };

  const notifyChange = (filename) => {
    if (shouldIgnoreWatchEvent(filename)) return;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      const payload = {
        deckId: deck.id,
        file: filename ? String(filename) : null,
        changedAt: new Date().toISOString()
      };
      for (const client of state.clients) {
        sendDeckEvent(client, "deck-change", payload);
      }
    }, 250);
  };

  try {
    state.watcher = watch(deck.path, { recursive: true }, (_eventType, filename) => {
      notifyChange(filename);
    });
    state.watcher.on("error", (error) => {
      for (const client of state.clients) {
        sendDeckEvent(client, "watch-error", {
          deckId: deck.id,
          message: error.message
        });
      }
    });
  } catch (error) {
    state.watchError = error;
  }

  deckWatchers.set(deck.id, state);
  return state;
}

async function discoverDecks() {
  const decks = [];

  for (const root of deckRoots) {
    if (!(await pathExists(root))) continue;

    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const deckPath = path.join(root, entry.name);
      const htmlPath = path.join(deckPath, "index.html");
      if (await pathExists(htmlPath)) {
        decks.push({
          id: entry.name,
          name: entry.name,
          path: deckPath,
          root
        });
      }
    }
  }

  return decks.sort((left, right) => left.name.localeCompare(right.name));
}

async function getDeck(deckId) {
  assertSafeId(deckId);
  const decks = await discoverDecks();
  const deck = decks.find((candidate) => candidate.id === deckId);
  if (!deck) {
    const error = new Error(`Unknown deck: ${deckId}`);
    error.status = 404;
    throw error;
  }
  return deck;
}

function decodeHtml(value) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isSafeLinkUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function findClosingParen(value, startIndex) {
  for (let index = startIndex; index < value.length; index += 1) {
    if (value[index] === ")") return index;
  }
  return -1;
}

function renderInline(value) {
  let rendered = "";
  let index = 0;

  while (index < value.length) {
    if (value.startsWith("**", index)) {
      const endIndex = value.indexOf("**", index + 2);
      if (endIndex > index + 2) {
        rendered += `<strong>${renderInline(value.slice(index + 2, endIndex))}</strong>`;
        index = endIndex + 2;
        continue;
      }
    }

    if (value[index] === "*") {
      const endIndex = value.indexOf("*", index + 1);
      if (endIndex > index + 1) {
        rendered += `<em>${renderInline(value.slice(index + 1, endIndex))}</em>`;
        index = endIndex + 1;
        continue;
      }
    }

    if (value[index] === "[") {
      const labelEnd = value.indexOf("](", index + 1);
      if (labelEnd > index + 1) {
        const hrefEnd = findClosingParen(value, labelEnd + 2);
        if (hrefEnd > labelEnd + 2) {
          const label = value.slice(index + 1, labelEnd);
          const href = value.slice(labelEnd + 2, hrefEnd);
          if (isSafeLinkUrl(href)) {
            const target = href.startsWith("mailto:") ? "" : " target=\"_blank\" rel=\"noopener\"";
            rendered += `<a class="copy-link" href="${escapeHtml(href)}"${target}>${renderInline(label)}</a>`;
          } else {
            rendered += escapeHtml(value.slice(index, hrefEnd + 1));
          }
          index = hrefEnd + 1;
          continue;
        }
      }
    }

    const nextSpecial = ["**", "*", "["]
      .map((token) => value.indexOf(token, index + 1))
      .filter((candidate) => candidate !== -1)
      .sort((left, right) => left - right)[0];
    const endIndex = nextSpecial ?? value.length;
    rendered += escapeHtml(value.slice(index, endIndex));
    index = endIndex;
  }

  return rendered;
}

function renderCopy(value) {
  return value.split(/\r?\n/).map(renderInline).join("<br>");
}

function readCopyBlocks(markdown) {
  const blocks = new Map();
  for (const match of markdown.matchAll(blockPattern)) {
    blocks.set(match[1], match[2].replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
  }
  return blocks;
}

function getAttribute(tag, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return tag.match(pattern)?.[1] ?? null;
}

function getBlockWrapper(sectionHtml, blockIndex) {
  const beforeBlock = sectionHtml.slice(0, blockIndex);
  const tagPattern = /<([a-zA-Z][\w:-]*)(\s[^<>]*)?>/g;
  const ignoredTags = new Set(["br", "hr", "img", "input", "source", "track", "meta", "link"]);
  const candidates = [];
  let tagMatch;

  while ((tagMatch = tagPattern.exec(beforeBlock)) !== null) {
    const raw = tagMatch[0];
    const tagName = tagMatch[1].toLowerCase();
    if (raw.startsWith("</") || raw.endsWith("/>") || ignoredTags.has(tagName)) continue;
    candidates.push({
      tagName,
      raw,
      index: tagMatch.index,
      className: getAttribute(raw, "class") || "",
      style: getAttribute(raw, "style") || ""
    });
  }

  return candidates.at(-1) || null;
}

function parseManifest(html, copyBlocks = new Map()) {
  const sectionPattern = /<section\b[\s\S]*?<\/section>/gi;
  const slides = [];
  const blocks = [];
  let sectionMatch;
  let slideIndex = 0;

  while ((sectionMatch = sectionPattern.exec(html)) !== null) {
    slideIndex += 1;
    const sectionHtml = sectionMatch[0];
    const openingTag = sectionHtml.match(/<section\b[^>]*>/i)?.[0] ?? "";
    const fallbackSlideId = `s${String(slideIndex).padStart(2, "0")}`;
    const slideId = getAttribute(openingTag, "data-slide-id") || fallbackSlideId;
    const slideKind = getAttribute(openingTag, "data-slide-kind");
    const hidden = /data-visibility\s*=\s*["']hidden["']/i.test(openingTag);
    const slide = {
      id: slideId,
      index: slideIndex,
      kind: slideKind,
      hidden,
      blocks: []
    };

    for (const blockMatch of sectionHtml.matchAll(blockPattern)) {
      const id = blockMatch[1];
      const htmlValue = blockMatch[2];
      const text = copyBlocks.has(id) ? copyBlocks.get(id) : decodeHtml(htmlValue);
      const wrapper = getBlockWrapper(sectionHtml, blockMatch.index || 0);
      const block = {
        id,
        slideId,
        slideIndex,
        text,
        html: htmlValue,
        textStyle: wrapper
          ? {
              tagName: wrapper.tagName,
              className: wrapper.className,
              style: wrapper.style
            }
          : null
      };
      slide.blocks.push(block);
      blocks.push(block);
    }

    slides.push(slide);
  }

  return { slides, blocks };
}

function getSlideSections(html) {
  const sectionPattern = /<section\b[\s\S]*?<\/section>/gi;
  const sections = [];
  let sectionMatch;
  let slideIndex = 0;

  while ((sectionMatch = sectionPattern.exec(html)) !== null) {
    slideIndex += 1;
    const sectionHtml = sectionMatch[0];
    const openingTag = sectionHtml.match(/<section\b[^>]*>/i)?.[0] ?? "";
    const fallbackSlideId = `s${String(slideIndex).padStart(2, "0")}`;
    sections.push({
      id: getAttribute(openingTag, "data-slide-id") || fallbackSlideId,
      index: slideIndex,
      html: sectionHtml,
      openingTag,
      start: sectionMatch.index,
      end: sectionMatch.index + sectionHtml.length
    });
  }

  return sections;
}

function findSlideSection(html, slideId) {
  const sections = getSlideSections(html);
  const section = sections.find((candidate) => candidate.id === slideId);
  if (!section) {
    const error = new Error(`Slide not found: ${slideId}`);
    error.status = 404;
    throw error;
  }
  return { section, sections };
}

function createUniqueId(existingIds, baseId) {
  const normalizedBase = String(baseId || "item")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
  if (!existingIds.has(normalizedBase)) return normalizedBase;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${normalizedBase}-${index}`;
    if (!existingIds.has(candidate)) return candidate;
  }

  return `${normalizedBase}-${randomUUID().slice(0, 8)}`;
}

function replaceHtmlRange(html, start, end, replacement) {
  return `${html.slice(0, start)}${replacement}${html.slice(end)}`;
}

function upsertSlideId(sectionHtml, slideId) {
  const openingTag = sectionHtml.match(/<section\b[^>]*>/i)?.[0];
  if (!openingTag) return sectionHtml;
  const nextOpeningTag = updateAttribute(openingTag, "data-slide-id", slideId);
  return sectionHtml.replace(openingTag, nextOpeningTag);
}

function remapCopyBlocks(sectionHtml, nextSlideId, existingBlockIds, copyBlocks = new Map()) {
  const mappedBlocks = [];
  const nextHtml = sectionHtml.replace(blockPattern, (fullMatch, oldBlockId, htmlValue) => {
    const suffix = oldBlockId.includes(".") ? oldBlockId.slice(oldBlockId.indexOf(".") + 1) : oldBlockId;
    const nextBlockId = createUniqueId(existingBlockIds, `${nextSlideId}.${suffix}`);
    existingBlockIds.add(nextBlockId);
    const text = copyBlocks.has(oldBlockId) ? copyBlocks.get(oldBlockId) : decodeHtml(htmlValue);
    mappedBlocks.push({ id: nextBlockId, text });
    return `<!-- copy:${nextBlockId} -->${renderCopy(text)}<!-- /copy -->`;
  });

  return { html: nextHtml, blocks: mappedBlocks };
}

async function appendCopyMarkdownBlocks(deck, slideId, blocks) {
  if (!blocks.length) return;
  const copyPath = path.join(deck.path, "copy.md");
  if (!(await pathExists(copyPath))) return;

  const markdown = await fs.readFile(copyPath, "utf8");
  const nextMarkdown = `${markdown.trimEnd()}\n\n## ${slideId}\n\n${blocks
    .map((block) => `### ${block.id}\n<!-- copy:${block.id} -->\n${block.text}\n<!-- /copy -->`)
    .join("\n\n")}\n`;
  await fs.writeFile(copyPath, nextMarkdown, "utf8");
}

async function readDeckManifest(deck) {
  const htmlPath = path.join(deck.path, "index.html");
  const copyPath = path.join(deck.path, "copy.md");
  const html = await fs.readFile(htmlPath, "utf8");
  const hasCopyMd = await pathExists(copyPath);
  const copyMarkdown = hasCopyMd ? await fs.readFile(copyPath, "utf8") : "";
  const copyBlocks = hasCopyMd ? readCopyBlocks(copyMarkdown) : new Map();
  const manifest = parseManifest(html, copyBlocks);

  return {
    deck: {
      id: deck.id,
      name: deck.name,
      hasCopyMd,
      path: deck.path
    },
    ...manifest
  };
}

async function syncCopy(deck) {
  const scriptPath = path.join(deck.root, "scripts", "sync-copy.mjs");
  if (!(await pathExists(scriptPath))) return { skipped: true };

  const syncResult = await execFileAsync("node", [scriptPath, deck.id], {
    cwd: deck.root,
    windowsHide: true
  });
  const checkResult = await execFileAsync("node", [scriptPath, deck.id, "--check"], {
    cwd: deck.root,
    windowsHide: true
  });

  return {
    skipped: false,
    stdout: `${syncResult.stdout}${checkResult.stdout}`,
    stderr: `${syncResult.stderr}${checkResult.stderr}`
  };
}

async function runDeckCheck(deck) {
  const scriptPath = path.join(deck.root, "scripts", "sync-copy.mjs");
  if (!(await pathExists(scriptPath))) {
    return { skipped: true, ok: true, stdout: "", stderr: "" };
  }

  try {
    const result = await execFileAsync("node", [scriptPath, deck.id, "--check"], {
      cwd: deck.root,
      windowsHide: true
    });
    return {
      skipped: false,
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    return {
      skipped: false,
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message
    };
  }
}

async function readDeckDiff(deck) {
  try {
    const result = await execFileAsync("git", ["diff", "--", deck.id], {
      cwd: deck.root,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 20
    });
    return result.stdout;
  } catch (error) {
    return error.stdout || error.stderr || "";
  }
}

function listAssetsPrompt(deckId) {
  return [
    `${deckId}/assets`,
    `${deckId}/bts-pics`,
    `${deckId}/bts-video`,
    `${deckId}/logos`,
    `${deckId}/font`
  ].join("\n- ");
}

function buildAgentPrompt({ deck, userPrompt, scope, manifest }) {
  const selectedBlock = scope?.blockId
    ? manifest.blocks.find((block) => block.id === scope.blockId)
    : null;
  const currentSlide = selectedBlock
    ? manifest.slides.find((slide) => slide.id === selectedBlock.slideId)
    : scope?.slideId
      ? manifest.slides.find((slide) => slide.id === scope.slideId)
      : null;
  const slideBlocks = currentSlide?.blocks
    .map((block) => `- ${block.id}: ${JSON.stringify(block.text)}`)
    .join("\n") || "(none)";

  return `You are editing a local RevealJS deck.

User request:
${userPrompt}

Scope:
- Deck folder: ${deck.id}
- Deck path: ${deck.path}
- Current slide: ${currentSlide?.id || "(not specified)"}
- Selected block: ${selectedBlock?.id || "(not specified)"}

Current slide copy blocks:
${slideBlocks}

Editable deck conventions:
- Existing editable text is marked with HTML comments like <!-- copy:s03.title -->...<!-- /copy -->.
- The deck may also have copy.md with matching copy blocks.
- Prefer editing ${deck.id}/copy.md for copy-only changes when copy.md exists.
- Edit ${deck.id}/index.html only when structure, layout, assets, or styling must change.
- If you edit copy.md, run: node .\\scripts\\sync-copy.mjs ${deck.id}
- After edits, run: node .\\scripts\\sync-copy.mjs ${deck.id} --check

Asset folders to consider:
- ${listAssetsPrompt(deck.id)}

Rules:
- Keep changes focused on the user request and stated scope.
- Preserve existing copy block IDs unless intentionally creating new blocks.
- Keep asset paths relative to ${deck.id}/index.html.
- Preserve RevealJS width and height unless explicitly asked.
- Do not remove slides, pricing, metrics, sponsor-facing claims, or hidden-slide visibility unless the user explicitly requested that exact change.
- Do not install packages.
- Do not modify files outside ${deck.id}/ unless a docs update is clearly necessary for changed sponsor-facing facts.

When finished, summarize what changed and mention validation results.`;
}

function publicJob(job) {
  return {
    id: job.id,
    deckId: job.deckId,
    status: job.status,
    prompt: job.prompt,
    scope: job.scope,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    exitCode: job.exitCode,
    stdout: job.stdout,
    stderr: job.stderr,
    validation: job.validation,
    diff: job.diff,
    error: job.error
  };
}

async function startAgentJob(deck, body) {
  const manifest = await readDeckManifest(deck);
  const userPrompt = String(body?.prompt || "").trim();
  if (!userPrompt) {
    const error = new Error("Prompt is required.");
    error.status = 400;
    throw error;
  }

  const job = {
    id: randomUUID(),
    deckId: deck.id,
    prompt: userPrompt,
    scope: body?.scope || {},
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exitCode: null,
    stdout: "",
    stderr: "",
    validation: null,
    diff: "",
    error: null
  };
  jobs.set(job.id, job);

  const agentPrompt = buildAgentPrompt({
    deck,
    userPrompt,
    scope: job.scope,
    manifest
  });

  const child = spawn(
    "codex",
    [
      "--ask-for-approval",
      "never",
      "exec",
      "-C",
      deck.root,
      "--add-dir",
      deck.path,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-"
    ],
    {
      cwd: deck.root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );

  child.stdin.write(agentPrompt);
  child.stdin.end();

  child.stdout.on("data", (chunk) => {
    job.stdout += chunk.toString();
    job.updatedAt = new Date().toISOString();
  });

  child.stderr.on("data", (chunk) => {
    job.stderr += chunk.toString();
    job.updatedAt = new Date().toISOString();
  });

  child.on("error", async (error) => {
    job.status = "failed";
    job.error = error.message;
    job.updatedAt = new Date().toISOString();
    job.validation = await runDeckCheck(deck);
    job.diff = await readDeckDiff(deck);
  });

  child.on("close", async (code) => {
    job.exitCode = code;
    job.validation = await runDeckCheck(deck);
    job.diff = await readDeckDiff(deck);
    job.status = code === 0 ? "completed" : "failed";
    job.updatedAt = new Date().toISOString();
  });

  return job;
}

async function updateCopyMarkdown(deck, blockId, text) {
  const copyPath = path.join(deck.path, "copy.md");
  const markdown = await fs.readFile(copyPath, "utf8");
  const pattern = new RegExp(
    `(<!--\\s*copy:${escapeRegExp(blockId)}\\s*-->)([\\s\\S]*?)(<!--\\s*\\/copy\\s*-->)`,
    "i"
  );

  if (!pattern.test(markdown)) {
    const error = new Error(`Block not found in copy.md: ${blockId}`);
    error.status = 404;
    throw error;
  }

  const nextMarkdown = markdown.replace(pattern, `$1\n${text}\n$3`);
  await fs.writeFile(copyPath, nextMarkdown, "utf8");
  const sync = await syncCopy(deck);
  if (sync.skipped) {
    await updateHtmlBlock(deck, blockId, text);
  }
  return sync;
}

async function updateHtmlBlock(deck, blockId, text) {
  const htmlPath = path.join(deck.path, "index.html");
  const html = await fs.readFile(htmlPath, "utf8");
  const pattern = new RegExp(
    `(<!--\\s*copy:${escapeRegExp(blockId)}\\s*-->)([\\s\\S]*?)(<!--\\s*\\/copy\\s*-->)`,
    "i"
  );

  if (!pattern.test(html)) {
    const error = new Error(`Block not found in index.html: ${blockId}`);
    error.status = 404;
    throw error;
  }

  const nextHtml = html.replace(pattern, `$1${renderCopy(text)}$3`);
  await fs.writeFile(htmlPath, nextHtml, "utf8");
  return { skipped: true };
}

function updateAttribute(openingTag, name, value) {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(["'])[^"']*\\1`, "i");
  const withoutAttribute = openingTag.replace(pattern, "");
  if (!value) return withoutAttribute;
  return withoutAttribute.replace(/>$/, ` ${name}="${escapeHtml(value)}">`);
}

function normalizeStyleTagName(value) {
  const tagName = String(value || "").trim().toLowerCase();
  const allowed = new Set(["h1", "h2", "h3", "p", "div", "span"]);
  if (!allowed.has(tagName)) {
    const error = new Error(`Unsupported text style tag: ${tagName}`);
    error.status = 400;
    throw error;
  }
  return tagName;
}

function normalizeClassName(value) {
  const className = String(value || "").trim();
  if (!className) return "";
  if (!/^[a-zA-Z0-9:_ -]+$/.test(className)) {
    const error = new Error(`Unsupported class name: ${className}`);
    error.status = 400;
    throw error;
  }
  return className.replace(/\s+/g, " ");
}

async function updateHtmlBlockStyle(deck, blockId, style) {
  const htmlPath = path.join(deck.path, "index.html");
  const html = await fs.readFile(htmlPath, "utf8");
  const pattern = new RegExp(
    `<!--\\s*copy:${escapeRegExp(blockId)}\\s*-->[\\s\\S]*?<!--\\s*\\/copy\\s*-->`,
    "i"
  );
  const blockMatch = pattern.exec(html);
  if (!blockMatch) {
    const error = new Error(`Block not found in index.html: ${blockId}`);
    error.status = 404;
    throw error;
  }

  const wrapper = getBlockWrapper(html, blockMatch.index);
  if (!wrapper) {
    const error = new Error(`No editable text wrapper found for block: ${blockId}`);
    error.status = 400;
    throw error;
  }

  const tagName = normalizeStyleTagName(style?.tagName);
  const className = normalizeClassName(style?.className);
  const closingPattern = new RegExp(`</${escapeRegExp(wrapper.tagName)}>`, "i");
  const afterBlock = html.slice(blockMatch.index + blockMatch[0].length);
  const closingMatch = closingPattern.exec(afterBlock);
  if (!closingMatch) {
    const error = new Error(`No closing wrapper found for block: ${blockId}`);
    error.status = 400;
    throw error;
  }

  let nextOpeningTag = wrapper.raw.replace(/^<([a-zA-Z][\w:-]*)/, `<${tagName}`);
  nextOpeningTag = updateAttribute(nextOpeningTag, "class", className);

  const closingStart = blockMatch.index + blockMatch[0].length + closingMatch.index;
  const nextHtml =
    html.slice(0, wrapper.index) +
    nextOpeningTag +
    html.slice(wrapper.index + wrapper.raw.length, closingStart) +
    `</${tagName}>` +
    html.slice(closingStart + closingMatch[0].length);

  await fs.writeFile(htmlPath, nextHtml, "utf8");
  return { tagName, className };
}

async function readDeckHtmlAndCopy(deck) {
  const htmlPath = path.join(deck.path, "index.html");
  const copyPath = path.join(deck.path, "copy.md");
  const html = await fs.readFile(htmlPath, "utf8");
  const copyMarkdown = (await pathExists(copyPath)) ? await fs.readFile(copyPath, "utf8") : "";
  return {
    htmlPath,
    html,
    copyBlocks: copyMarkdown ? readCopyBlocks(copyMarkdown) : new Map()
  };
}

async function duplicateSlide(deck, slideId) {
  const { htmlPath, html, copyBlocks } = await readDeckHtmlAndCopy(deck);
  const { section, sections } = findSlideSection(html, slideId);
  const existingSlideIds = new Set(sections.map((candidate) => candidate.id));
  const existingBlockIds = new Set([...html.matchAll(blockPattern)].map((match) => match[1]));
  const nextSlideId = createUniqueId(existingSlideIds, `${slideId}-copy`);
  const remapped = remapCopyBlocks(upsertSlideId(section.html, nextSlideId), nextSlideId, existingBlockIds, copyBlocks);
  const nextHtml = `${html.slice(0, section.end)}\n${remapped.html}${html.slice(section.end)}`;

  await fs.writeFile(htmlPath, nextHtml, "utf8");
  await appendCopyMarkdownBlocks(deck, nextSlideId, remapped.blocks);
  return { slideId: nextSlideId };
}

async function insertSlideAfter(deck, slideId) {
  const { htmlPath, html } = await readDeckHtmlAndCopy(deck);
  const { section, sections } = findSlideSection(html, slideId);
  const existingSlideIds = new Set(sections.map((candidate) => candidate.id));
  const existingBlockIds = new Set([...html.matchAll(blockPattern)].map((match) => match[1]));
  const nextSlideId = createUniqueId(existingSlideIds, "new-slide");
  const titleBlockId = createUniqueId(existingBlockIds, `${nextSlideId}.title`);
  existingBlockIds.add(titleBlockId);
  const bodyBlockId = createUniqueId(existingBlockIds, `${nextSlideId}.body`);
  const blocks = [
    { id: titleBlockId, text: "New Slide" },
    { id: bodyBlockId, text: "Add slide copy here." }
  ];
  const nextSection = `
        <section data-slide-id="${nextSlideId}" data-slide-kind="custom">
          <h2><!-- copy:${titleBlockId} -->${renderCopy(blocks[0].text)}<!-- /copy --></h2>
          <p><!-- copy:${bodyBlockId} -->${renderCopy(blocks[1].text)}<!-- /copy --></p>
        </section>`;
  const nextHtml = `${html.slice(0, section.end)}${nextSection}${html.slice(section.end)}`;

  await fs.writeFile(htmlPath, nextHtml, "utf8");
  await appendCopyMarkdownBlocks(deck, nextSlideId, blocks);
  return { slideId: nextSlideId };
}

async function setSlideVisibility(deck, slideId, hidden) {
  const htmlPath = path.join(deck.path, "index.html");
  const html = await fs.readFile(htmlPath, "utf8");
  const { section } = findSlideSection(html, slideId);
  const nextOpeningTag = updateAttribute(section.openingTag, "data-visibility", hidden ? "hidden" : "");
  const nextSectionHtml = section.html.replace(section.openingTag, nextOpeningTag);
  await fs.writeFile(htmlPath, replaceHtmlRange(html, section.start, section.end, nextSectionHtml), "utf8");
  return { slideId, hidden };
}

async function moveSlide(deck, slideId, direction) {
  const htmlPath = path.join(deck.path, "index.html");
  const html = await fs.readFile(htmlPath, "utf8");
  const sections = getSlideSections(html);
  const index = sections.findIndex((candidate) => candidate.id === slideId);
  if (index === -1) {
    const error = new Error(`Slide not found: ${slideId}`);
    error.status = 404;
    throw error;
  }

  const offset = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  if (!offset) {
    const error = new Error(`Unsupported move direction: ${direction}`);
    error.status = 400;
    throw error;
  }

  const targetIndex = index + offset;
  if (targetIndex < 0 || targetIndex >= sections.length) {
    return { slideId, moved: false };
  }

  const reordered = [...sections];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(targetIndex, 0, moved);
  const firstStart = sections[0].start;
  const lastEnd = sections.at(-1).end;
  const nextSlidesHtml = reordered.map((candidate) => candidate.html).join("\n");
  const nextHtml = `${html.slice(0, firstStart)}${nextSlidesHtml}${html.slice(lastEnd)}`;
  await fs.writeFile(htmlPath, nextHtml, "utf8");
  return { slideId, moved: true };
}

app.get("/api/decks", async (_req, res, next) => {
  try {
    const decks = await discoverDecks();
    res.json({ deckRoots, decks });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces", async (req, res, next) => {
  try {
    const workspacePath = String(req.body?.path || "").trim();
    await setDeckRoots([workspacePath]);
    const decks = await discoverDecks();
    res.json({ ok: true, deckRoots, decks });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces/pick", async (_req, res, next) => {
  try {
    const workspacePath = await pickWorkspaceDirectory();
    if (!workspacePath) {
      res.status(204).end();
      return;
    }

    await setDeckRoots([workspacePath]);
    const decks = await discoverDecks();
    res.json({ ok: true, deckRoots, decks });
  } catch (error) {
    next(error);
  }
});

app.get("/api/decks/:deckId/manifest", async (req, res, next) => {
  try {
    const deck = await getDeck(req.params.deckId);
    res.json(await readDeckManifest(deck));
  } catch (error) {
    next(error);
  }
});

app.put("/api/decks/:deckId/blocks/:blockId", async (req, res, next) => {
  try {
    const deck = await getDeck(req.params.deckId);
    const text = String(req.body?.text ?? "");
    const copyPath = path.join(deck.path, "copy.md");
    const sync = (await pathExists(copyPath))
      ? await updateCopyMarkdown(deck, req.params.blockId, text)
      : await updateHtmlBlock(deck, req.params.blockId, text);

    res.json({
      ok: true,
      sync,
      manifest: await readDeckManifest(deck)
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/decks/:deckId/blocks/:blockId/style", async (req, res, next) => {
  try {
    const deck = await getDeck(req.params.deckId);
    const style = await updateHtmlBlockStyle(deck, req.params.blockId, req.body?.style);

    res.json({
      ok: true,
      style,
      manifest: await readDeckManifest(deck)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/decks/:deckId/slides/:slideId/duplicate", async (req, res, next) => {
  try {
    const deck = await getDeck(req.params.deckId);
    const result = await duplicateSlide(deck, req.params.slideId);
    res.json({ ok: true, ...result, manifest: await readDeckManifest(deck) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/decks/:deckId/slides/:slideId/insert-after", async (req, res, next) => {
  try {
    const deck = await getDeck(req.params.deckId);
    const result = await insertSlideAfter(deck, req.params.slideId);
    res.json({ ok: true, ...result, manifest: await readDeckManifest(deck) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/decks/:deckId/slides/:slideId/visibility", async (req, res, next) => {
  try {
    const deck = await getDeck(req.params.deckId);
    const result = await setSlideVisibility(deck, req.params.slideId, Boolean(req.body?.hidden));
    res.json({ ok: true, ...result, manifest: await readDeckManifest(deck) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/decks/:deckId/slides/:slideId/move", async (req, res, next) => {
  try {
    const deck = await getDeck(req.params.deckId);
    const result = await moveSlide(deck, req.params.slideId, req.body?.direction);
    res.json({ ok: true, ...result, manifest: await readDeckManifest(deck) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/decks/:deckId/agent-jobs", async (req, res, next) => {
  try {
    const deck = await getDeck(req.params.deckId);
    const job = await startAgentJob(deck, req.body);
    res.status(202).json({ ok: true, job: publicJob(job) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agent-jobs/:jobId", (req, res, next) => {
  try {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      const error = new Error(`Unknown job: ${req.params.jobId}`);
      error.status = 404;
      throw error;
    }
    res.json({ ok: true, job: publicJob(job) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/decks/:deckId/events", async (req, res, next) => {
  try {
    const deck = await getDeck(req.params.deckId);
    const watcherState = ensureDeckWatcher(deck);

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    sendDeckEvent(res, "watch-ready", {
      deckId: deck.id,
      ok: !watcherState.watchError,
      message: watcherState.watchError?.message ?? null
    });

    watcherState.clients.add(res);
    const heartbeat = setInterval(() => {
      sendDeckEvent(res, "watch-heartbeat", {
        deckId: deck.id,
        at: new Date().toISOString()
      });
    }, 30000);

    req.on("close", () => {
      clearInterval(heartbeat);
      watcherState.clients.delete(res);
    });
  } catch (error) {
    next(error);
  }
});

app.use("/deck-content/:deckId", async (req, res, next) => {
  try {
    const deck = await getDeck(req.params.deckId);
    if (req.method === "GET" && (req.path === "/" || req.path === "/index.html")) {
      const htmlPath = path.join(deck.path, "index.html");
      const html = await fs.readFile(htmlPath, "utf8");
      const editorHtml = html.replace(
        /\sdata-visibility=(["'])hidden\1/gi,
        " data-editor-source-visibility=\"hidden\""
      );
      res.setHeader("Cache-Control", "no-store");
      res.type("html").send(editorHtml);
      return;
    }

    express.static(deck.path, {
      etag: false,
      lastModified: false,
      setHeaders(response) {
        response.setHeader("Cache-Control", "no-store");
      }
    })(req, res, next);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    ok: false,
    message: error.message || "Unexpected server error"
  });
});

export {
  appendCopyMarkdownBlocks,
  createUniqueId,
  duplicateSlide,
  getSlideSections,
  insertSlideAfter,
  moveSlide,
  parseManifest,
  readCopyBlocks,
  renderCopy,
  setDeckRoots,
  setSlideVisibility,
  shouldIgnoreWatchEvent,
  updateCopyMarkdown,
  updateHtmlBlock,
  updateHtmlBlockStyle
};

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  app.listen(port, () => {
    console.log(`RevealJS local editor backend listening on http://localhost:${port}`);
    console.log(`Deck roots: ${deckRoots.join("; ")}`);
    console.log("Use the editor workspace picker or DECK_ROOTS to change deck roots.");
  });
}
