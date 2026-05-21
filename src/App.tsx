import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type DeckSummary = {
  id: string;
  name: string;
  path: string;
};

type DecksPayload = {
  deckRoots: string[];
  decks: DeckSummary[];
};

type EditableBlock = {
  id: string;
  slideId: string;
  slideIndex: number;
  text: string;
  html: string;
  textStyle: null | {
    tagName: string;
    className: string;
    style: string;
  };
};

type SlideSummary = {
  id: string;
  index: number;
  kind: string | null;
  hidden: boolean;
  blocks: EditableBlock[];
};

type DeckManifest = {
  deck: {
    id: string;
    name: string;
    hasCopyMd: boolean;
    path: string;
  };
  slides: SlideSummary[];
  blocks: EditableBlock[];
};

type AgentJob = {
  id: string;
  deckId: string;
  status: "running" | "completed" | "failed";
  prompt: string;
  scope: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  validation: null | {
    skipped: boolean;
    ok: boolean;
    stdout: string;
    stderr: string;
  };
  diff: string;
  error: string | null;
};

type RevealWindow = Window & {
  Reveal?: {
    getIndices?: () => { h: number; v?: number; f?: number };
    getCurrentSlide?: () => HTMLElement | null;
    slide?: (h: number, v?: number, f?: number) => void;
    on?: (event: string, callback: () => void) => void;
    sync?: () => void;
  };
};

type RestorePoint = { h: number; v?: number; f?: number } | null;
type CaretPoint = { x: number; y: number } | null;
type EditorKeyboardEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};
type TextStyleOption = {
  value: string;
  label: string;
  detail: string;
  tagName: string;
  className: string;
};
type PersistedEdit = {
  deckId: string;
  blockId: string;
  beforeText: string;
  afterText: string;
};

const slideIndexStoragePrefix = "revealjs-local-editor:last-slide:";
const recentWorkspaceStorageKey = "revealjs-local-editor:recent-workspaces";
const maxDraftHistoryEntries = 100;
const maxRecentWorkspaces = 6;

function readStoredSlideIndex(deckId: string, slideCount?: number) {
  try {
    const raw = window.localStorage.getItem(`${slideIndexStoragePrefix}${deckId}`);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed < 1) return null;
    if (slideCount && parsed > slideCount) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredSlideIndex(deckId: string, slideIndex: number) {
  try {
    window.localStorage.setItem(`${slideIndexStoragePrefix}${deckId}`, String(slideIndex));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function readRecentWorkspaces() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(recentWorkspaceStorageKey) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function writeRecentWorkspaces(workspaces: string[]) {
  try {
    window.localStorage.setItem(recentWorkspaceStorageKey, JSON.stringify(workspaces));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function addRecentWorkspace(pathValue: string) {
  const normalized = pathValue.trim();
  if (!normalized) return readRecentWorkspaces();

  const recent = [
    normalized,
    ...readRecentWorkspaces().filter((candidate) => candidate.toLowerCase() !== normalized.toLowerCase())
  ].slice(0, maxRecentWorkspaces);
  writeRecentWorkspaces(recent);
  return recent;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isSafeLinkUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function renderInlineMarkup(value: string): string {
  let rendered = "";
  let index = 0;

  while (index < value.length) {
    if (value.startsWith("**", index)) {
      const endIndex = value.indexOf("**", index + 2);
      if (endIndex > index + 2) {
        rendered += `<strong>${renderInlineMarkup(value.slice(index + 2, endIndex))}</strong>`;
        index = endIndex + 2;
        continue;
      }
    }

    if (value[index] === "*") {
      const endIndex = value.indexOf("*", index + 1);
      if (endIndex > index + 1) {
        rendered += `<em>${renderInlineMarkup(value.slice(index + 1, endIndex))}</em>`;
        index = endIndex + 1;
        continue;
      }
    }

    if (value[index] === "[") {
      const labelEnd = value.indexOf("](", index + 1);
      const hrefEnd = labelEnd === -1 ? -1 : value.indexOf(")", labelEnd + 2);
      if (labelEnd > index + 1 && hrefEnd > labelEnd + 2) {
        const label = value.slice(index + 1, labelEnd);
        const href = value.slice(labelEnd + 2, hrefEnd);
        if (isSafeLinkUrl(href)) {
          const target = href.startsWith("mailto:") ? "" : " target=\"_blank\" rel=\"noopener\"";
          rendered += `<a class="copy-link" href="${escapeHtml(href)}"${target}>${renderInlineMarkup(label)}</a>`;
        } else {
          rendered += escapeHtml(value.slice(index, hrefEnd + 1));
        }
        index = hrefEnd + 1;
        continue;
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

function renderCopyMarkup(value: string) {
  return value.split(/\r?\n/).map(renderInlineMarkup).join("<br>");
}

function textStyleKey(style: EditableBlock["textStyle"] | Pick<TextStyleOption, "tagName" | "className"> | null) {
  if (!style) return "";
  return `${style.tagName}|${style.className}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.message || `Request failed: ${response.status}`);
  }

  return payload as T;
}

export function App() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [deckRoots, setDeckRoots] = useState<string[]>([]);
  const [workspacePath, setWorkspacePath] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => readRecentWorkspaces());
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [selectedDeckId, setSelectedDeckId] = useState<string>("");
  const [manifest, setManifest] = useState<DeckManifest | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [status, setStatus] = useState("Loading decks...");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [restorePoint, setRestorePoint] = useState<RestorePoint>(null);
  const [currentSlideIndex, setCurrentSlideIndex] = useState<number | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [agentJob, setAgentJob] = useState<AgentJob | null>(null);
  const [textStyleOptions, setTextStyleOptions] = useState<TextStyleOption[]>([]);
  const [linkUrl, setLinkUrl] = useState("");
  const [pendingPreviewRefresh, setPendingPreviewRefresh] = useState(false);
  const draftTextRef = useRef("");
  const hasUnsavedDraftRef = useRef(false);
  const selectedDeckIdRef = useRef("");
  const selectedBlockIdRef = useRef<string | null>(null);
  const selectedBlockSourceTextRef = useRef("");
  const previousSelectedBlockIdRef = useRef<string | null>(null);
  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);
  const lastHistoryTextRef = useRef("");
  const persistedUndoStackRef = useRef<PersistedEdit[]>([]);
  const persistedRedoStackRef = useRef<PersistedEdit[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editableElementRef = useRef<HTMLElement | null>(null);
  const editorKeyDownHandlerRef = useRef<((event: KeyboardEvent) => void) | null>(null);
  const persistedHistoryKeyDownHandlerRef = useRef<((event: KeyboardEvent | EditorKeyboardEvent) => void) | null>(null);
  const pendingCaretPointRef = useRef<CaretPoint>(null);
  const currentSlideIndexRef = useRef<number | null>(null);
  const fileRefreshTimerRef = useRef<number | null>(null);
  const autoApplyKeyRef = useRef<string | null>(null);
  const autoApplyPromiseRef = useRef<Promise<void> | null>(null);
  const ignoreOwnFileRefreshUntilRef = useRef(0);

  const clearActiveEdit = useCallback(() => {
    setSelectedBlockId(null);
  }, []);

  const resetDraftHistory = useCallback((text: string) => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    lastHistoryTextRef.current = text;
  }, []);

  const recordDraftHistory = useCallback((nextText: string) => {
    const previousText = lastHistoryTextRef.current;
    if (nextText === previousText) return;

    undoStackRef.current = [...undoStackRef.current.slice(-(maxDraftHistoryEntries - 1)), previousText];
    redoStackRef.current = [];
    lastHistoryTextRef.current = nextText;
  }, []);

  const resetPersistedHistory = useCallback(() => {
    persistedUndoStackRef.current = [];
    persistedRedoStackRef.current = [];
  }, []);

  const recordPersistedHistory = useCallback((edit: PersistedEdit) => {
    if (edit.beforeText === edit.afterText) return;

    persistedUndoStackRef.current = [
      ...persistedUndoStackRef.current.slice(-(maxDraftHistoryEntries - 1)),
      edit
    ];
    persistedRedoStackRef.current = [];
  }, []);

  const rememberSlideIndex = useCallback(
    (slideIndex: number) => {
      currentSlideIndexRef.current = slideIndex;
      setCurrentSlideIndex(slideIndex);
      if (selectedDeckId) writeStoredSlideIndex(selectedDeckId, slideIndex);
    },
    [selectedDeckId]
  );

  const selectedBlock = useMemo(
    () => manifest?.blocks.find((block) => block.id === selectedBlockId) ?? null,
    [manifest, selectedBlockId]
  );

  const selectedSlide = useMemo(
    () => manifest?.slides.find((slide) => slide.id === selectedBlock?.slideId) ?? null,
    [manifest, selectedBlock]
  );

  const currentSlide = useMemo(
    () =>
      manifest?.slides.find((slide) => slide.index === currentSlideIndex) ??
      selectedSlide ??
      manifest?.slides[0] ??
      null,
    [currentSlideIndex, manifest, selectedSlide]
  );

  const hasUnsavedDraft = Boolean(selectedBlock && draftText !== selectedBlockSourceTextRef.current);

  useEffect(() => {
    selectedDeckIdRef.current = selectedDeckId;
  }, [selectedDeckId]);

  useEffect(() => {
    hasUnsavedDraftRef.current = hasUnsavedDraft;
  }, [hasUnsavedDraft]);

  const hiddenSlideCount = useMemo(
    () => manifest?.slides.filter((slide) => slide.hidden).length ?? 0,
    [manifest]
  );

  const deckUrl = selectedDeckId
    ? `/deck-content/${selectedDeckId}/index.html?editorReload=${reloadKey}`
    : "";

  const findBlockComments = useCallback((doc: Document, blockId: string) => {
    const win = iframeRef.current?.contentWindow as RevealWindow | null;
    const hiddenPreviewSlide = doc.querySelector<HTMLElement>(
      ".slides section[data-local-editor-hidden-clone='true'].present"
    );
    const currentSlide =
      hiddenPreviewSlide ?? win?.Reveal?.getCurrentSlide?.() ?? doc.querySelector(".slides section.present");
    const roots = [currentSlide, doc.body].filter(Boolean) as Node[];

    for (const searchRoot of roots) {
      const walker = doc.createTreeWalker(searchRoot, NodeFilter.SHOW_COMMENT);
      let current = walker.nextNode();

      while (current) {
        const comment = current as Comment;
        const match = comment.nodeValue?.match(/^\s*copy:([a-z0-9._-]+)\s*$/i);
        if (match?.[1] === blockId) {
          let next = walker.nextNode();
          while (next) {
            const end = next as Comment;
            if (/^\s*\/copy\s*$/i.test(end.nodeValue || "")) {
              return { start: comment, end };
            }
            next = walker.nextNode();
          }
        }
        current = walker.nextNode();
      }
    }

    return null;
  }, []);

  const handleInlineInput = useCallback((event: Event) => {
    const element = event.currentTarget as HTMLElement;
    const nextText = (element.textContent || "").replace(/\u00a0/g, " ").replace(/\n$/, "");
    recordDraftHistory(nextText);
    draftTextRef.current = nextText;
    setDraftText(nextText);
  }, [recordDraftHistory]);

  const cleanupInlineEditable = useCallback(() => {
    const element = editableElementRef.current;
    if (!element) return;

    element.removeAttribute("contenteditable");
    element.classList.remove("reveal-local-editor-active-text");
    element.removeEventListener("input", handleInlineInput);
    element.onkeydown = null;

    const parent = element.parentNode;
    if (parent) {
      while (element.firstChild) {
        parent.insertBefore(element.firstChild, element);
      }
      parent.removeChild(element);
    }

    editableElementRef.current = null;
  }, [handleInlineInput]);

  const previewBlockText = useCallback(
    (blockId: string, text: string) => {
      if (selectedBlockId === blockId && editableElementRef.current) {
        editableElementRef.current.innerHTML = renderCopyMarkup(text);
        return;
      }

      const doc = iframeRef.current?.contentDocument;
      if (!doc) return;
      const comments = findBlockComments(doc, blockId);
      if (!comments) return;

      const { start, end } = comments;
      let node = start.nextSibling;
      while (node && node !== end) {
        const next = node.nextSibling;
        node.parentNode?.removeChild(node);
        node = next;
      }

      const wrapper = doc.createElement("span");
      wrapper.innerHTML = renderCopyMarkup(text);
      while (wrapper.firstChild) {
        start.parentNode?.insertBefore(wrapper.firstChild, end);
      }
    },
    [findBlockComments, selectedBlockId]
  );

  const activateInlineEditable = useCallback(
    (blockId: string) => {
      const doc = iframeRef.current?.contentDocument;
      if (!doc) return;
      const comments = findBlockComments(doc, blockId);
      if (!comments || !comments.start.parentNode) return;

      const maybeExisting = comments.start.nextSibling;
      const existingEditable =
        maybeExisting?.nodeType === 1 &&
        (maybeExisting as Element).classList.contains("reveal-local-editor-active-text")
          ? (maybeExisting as HTMLElement)
          : null;

      if (existingEditable && editableElementRef.current === existingEditable) return;
      cleanupInlineEditable();

      const wrapper = existingEditable || doc.createElement("span");
      if (!existingEditable) {
        wrapper.className = "reveal-local-editor-active-text";
        let node = comments.start.nextSibling;
        while (node && node !== comments.end) {
          const next = node.nextSibling;
          wrapper.appendChild(node);
          node = next;
        }
        comments.start.parentNode.insertBefore(wrapper, comments.end);
      }

      editableElementRef.current = wrapper;
      wrapper.setAttribute("contenteditable", "true");
      wrapper.classList.add("reveal-local-editor-active-text");
      wrapper.addEventListener("input", handleInlineInput);
      wrapper.onkeydown = (event) => editorKeyDownHandlerRef.current?.(event);
      wrapper.focus();

      const selection = doc.getSelection();
      const pendingCaretPoint = pendingCaretPointRef.current;
      pendingCaretPointRef.current = null;

      let range: Range | null = null;
      if (pendingCaretPoint) {
        const docWithCaret = doc as Document & {
          caretRangeFromPoint?: (x: number, y: number) => Range | null;
          caretPositionFromPoint?: (
            x: number,
            y: number
          ) => { offsetNode: Node; offset: number } | null;
        };

        range = docWithCaret.caretRangeFromPoint?.(pendingCaretPoint.x, pendingCaretPoint.y) ?? null;
        if (!range) {
          const position = docWithCaret.caretPositionFromPoint?.(
            pendingCaretPoint.x,
            pendingCaretPoint.y
          );
          if (position) {
            range = doc.createRange();
            range.setStart(position.offsetNode, position.offset);
            range.collapse(true);
          }
        }

        const containerElement =
          range?.startContainer.nodeType === 1
            ? (range.startContainer as Element)
            : range?.startContainer.parentElement;
        if (containerElement && !wrapper.contains(containerElement) && containerElement !== wrapper) {
          range = null;
        }
      }

      if (!range) {
        range = doc.createRange();
        range.selectNodeContents(wrapper);
        range.collapse(false);
      }

      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    [cleanupInlineEditable, findBlockComments, handleInlineInput]
  );

  const updateDraftText = useCallback(
    (nextText: string, options: { recordHistory?: boolean } = {}) => {
      if (options.recordHistory !== false) recordDraftHistory(nextText);
      draftTextRef.current = nextText;
      setDraftText(nextText);
      if (selectedBlockId) previewBlockText(selectedBlockId, nextText);
    },
    [previewBlockText, recordDraftHistory, selectedBlockId]
  );

  const applyHistoryText = useCallback(
    (nextText: string) => {
      draftTextRef.current = nextText;
      setDraftText(nextText);
      lastHistoryTextRef.current = nextText;
      const blockId = selectedBlockIdRef.current;
      if (blockId) previewBlockText(blockId, nextText);
    },
    [previewBlockText]
  );

  const undoDraftEdit = useCallback(() => {
    const previousText = undoStackRef.current.pop();
    if (previousText === undefined) return;

    redoStackRef.current = [
      ...redoStackRef.current.slice(-(maxDraftHistoryEntries - 1)),
      draftTextRef.current
    ];
    applyHistoryText(previousText);
  }, [applyHistoryText]);

  const redoDraftEdit = useCallback(() => {
    const nextText = redoStackRef.current.pop();
    if (nextText === undefined) return;

    undoStackRef.current = [
      ...undoStackRef.current.slice(-(maxDraftHistoryEntries - 1)),
      draftTextRef.current
    ];
    applyHistoryText(nextText);
  }, [applyHistoryText]);

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent | EditorKeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        const blockId = selectedBlockIdRef.current;
        const sourceText = selectedBlockSourceTextRef.current;
        if (blockId) {
          draftTextRef.current = sourceText;
          setDraftText(sourceText);
          resetDraftHistory(sourceText);
          previewBlockText(blockId, sourceText);
          setStatus(`Canceled edit for ${blockId}.`);
        }
        clearActiveEdit();
        return;
      }

      const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z";
      const isRedo =
        (event.ctrlKey || event.metaKey) &&
        (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"));

      if (isUndo || isRedo) {
        const hasActiveDraftChange =
          Boolean(selectedBlockIdRef.current) && draftTextRef.current !== selectedBlockSourceTextRef.current;
        const hasDraftHistory = isUndo ? undoStackRef.current.length > 0 : redoStackRef.current.length > 0;

        if (!hasActiveDraftChange && !hasDraftHistory) {
          persistedHistoryKeyDownHandlerRef.current?.(event);
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        if (isUndo) undoDraftEdit();
        if (isRedo) redoDraftEdit();
      }
    },
    [clearActiveEdit, previewBlockText, redoDraftEdit, resetDraftHistory, undoDraftEdit]
  );

  useEffect(() => {
    editorKeyDownHandlerRef.current = handleEditorKeyDown;
  }, [handleEditorKeyDown]);

  const loadDecks = useCallback(async () => {
    try {
      const payload = await requestJson<DecksPayload>("/api/decks");
      setDeckRoots(payload.deckRoots);
      setDecks(payload.decks);
      setWorkspacePath(payload.deckRoots[0] || "");
      setWorkspaceDraft(payload.deckRoots[0] || "");
      setRecentWorkspaces(readRecentWorkspaces());

      const nextDeck =
        payload.decks.find((deck) => deck.id === selectedDeckIdRef.current) ?? payload.decks[0] ?? null;
      setSelectedDeckId(nextDeck?.id ?? "");
      if (!nextDeck) {
        setManifest(null);
        setDraftText("");
        draftTextRef.current = "";
      }
      setStatus(payload.decks.length ? "Select a deck to edit." : "No decks found in this workspace.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const applyWorkspacePayload = useCallback((payload: DecksPayload, statusMessage?: string) => {
    setDeckRoots(payload.deckRoots);
    setDecks(payload.decks);
    setWorkspacePath(payload.deckRoots[0] || "");
    setWorkspaceDraft(payload.deckRoots[0] || "");
    if (payload.deckRoots[0]) setRecentWorkspaces(addRecentWorkspace(payload.deckRoots[0]));

    const nextDeck = payload.decks[0] ?? null;
    setSelectedDeckId(nextDeck?.id ?? "");
    setManifest(null);
    clearActiveEdit();
    setDraftText("");
    draftTextRef.current = "";
    setReloadKey((value) => value + 1);
    setStatus(statusMessage ?? (payload.decks.length ? "Workspace opened." : "Workspace opened. No decks found."));
  }, [clearActiveEdit]);

  const openWorkspace = useCallback(
    async (pathValue: string) => {
      const nextPath = pathValue.trim();
      if (!nextPath) {
        setStatus("Enter a workspace path first.");
        return;
      }

      try {
        setWorkspaceBusy(true);
        setStatus("Opening workspace...");
        const payload = await requestJson<DecksPayload>("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: nextPath })
        });
        applyWorkspacePayload(payload, "Workspace opened.");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setWorkspaceBusy(false);
      }
    },
    [applyWorkspacePayload]
  );

  const pickWorkspace = useCallback(async () => {
    try {
      setWorkspaceBusy(true);
      setStatus("Waiting for folder selection...");
      const response = await fetch("/api/workspaces/pick", { method: "POST" });
      if (response.status === 204) {
        setStatus("Workspace selection canceled.");
        return;
      }
      const payload = (await response.json()) as DecksPayload & { message?: string };
      if (!response.ok) {
        throw new Error(payload?.message || `Request failed: ${response.status}`);
      }
      applyWorkspacePayload(payload, "Workspace opened.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorkspaceBusy(false);
    }
  }, [applyWorkspacePayload]);

  const loadManifest = useCallback(async (deckId: string) => {
    if (!deckId) return;
    try {
      setStatus("Reading deck manifest...");
      const nextManifest = await requestJson<DeckManifest>(`/api/decks/${deckId}/manifest`);
      const storedSlideIndex = readStoredSlideIndex(deckId, nextManifest.slides.length);
      setManifest(nextManifest);
      setSelectedBlockId(null);
      selectedBlockIdRef.current = null;
      selectedBlockSourceTextRef.current = "";
      previousSelectedBlockIdRef.current = null;
      currentSlideIndexRef.current = storedSlideIndex;
      setCurrentSlideIndex(storedSlideIndex);
      setDraftText("");
      draftTextRef.current = "";
      resetDraftHistory("");
      resetPersistedHistory();
      setPendingPreviewRefresh(false);
      setStatus(
        `Loaded ${nextManifest.slides.length} slides and ${nextManifest.blocks.length} editable blocks.`
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [resetDraftHistory, resetPersistedHistory]);

  const refreshManifestInPlace = useCallback(async (deckId: string) => {
    const nextManifest = await requestJson<DeckManifest>(`/api/decks/${deckId}/manifest`);
    setManifest(nextManifest);

    const selectedId = selectedBlockIdRef.current;
    if (selectedId && !nextManifest.blocks.some((block) => block.id === selectedId)) {
      setSelectedBlockId(null);
      selectedBlockIdRef.current = null;
      selectedBlockSourceTextRef.current = "";
      previousSelectedBlockIdRef.current = null;
      setStatus(`Deck changed on disk. ${selectedId} no longer exists.`);
    }

    return nextManifest;
  }, []);

  const reloadPreviewPreservingState = useCallback(
    (nextStatus: string) => {
      const win = iframeRef.current?.contentWindow as RevealWindow | null;
      const indices = win?.Reveal?.getIndices?.() ?? null;
      const rememberedSlideIndex = currentSlideIndexRef.current;

      if (indices) setRestorePoint(indices);
      if (selectedDeckId && rememberedSlideIndex) {
        writeStoredSlideIndex(selectedDeckId, rememberedSlideIndex);
      }

      setPendingPreviewRefresh(false);
      setReloadKey((value) => value + 1);
      setStatus(nextStatus);
    },
    [selectedDeckId]
  );

  useEffect(() => {
    loadDecks();
  }, [loadDecks]);

  useEffect(() => {
    loadManifest(selectedDeckId);
  }, [loadManifest, selectedDeckId]);

  useEffect(() => {
    if (!selectedDeckId) return;

    const source = new EventSource(`/api/decks/${selectedDeckId}/events`);

    const refreshFromDisk = () => {
      if (Date.now() < ignoreOwnFileRefreshUntilRef.current) {
        setStatus("Saved deck changes.");
        return;
      }

      if (fileRefreshTimerRef.current) {
        window.clearTimeout(fileRefreshTimerRef.current);
      }

      fileRefreshTimerRef.current = window.setTimeout(async () => {
        const rememberedSlideIndex = currentSlideIndexRef.current;
        if (rememberedSlideIndex) {
          writeStoredSlideIndex(selectedDeckId, rememberedSlideIndex);
        }

        try {
          setStatus("Deck changed on disk. Reading latest manifest...");
          await refreshManifestInPlace(selectedDeckId);

          if (selectedBlockIdRef.current) {
            setPendingPreviewRefresh(true);
            setStatus(
              hasUnsavedDraftRef.current
                ? "Deck changed on disk. Preview refresh is paused until you save or clear the current edit."
                : "Deck changed on disk. Preview refresh is paused while this block is selected."
            );
            return;
          }

          reloadPreviewPreservingState("Deck changed on disk. Refreshed preview.");
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }, 300);
    };

    source.addEventListener("deck-change", refreshFromDisk);
    source.addEventListener("watch-ready", () => {
      setStatus("Watching deck for changes.");
    });
    source.addEventListener("watch-error", (event) => {
      const payload = JSON.parse((event as MessageEvent).data || "{}") as { message?: string };
      setStatus(payload.message ? `Deck watcher error: ${payload.message}` : "Deck watcher error.");
    });

    return () => {
      if (fileRefreshTimerRef.current) {
        window.clearTimeout(fileRefreshTimerRef.current);
      }
      source.close();
    };
  }, [refreshManifestInPlace, reloadPreviewPreservingState, selectedDeckId]);

  useEffect(() => {
    selectedBlockIdRef.current = selectedBlockId;
    if (!selectedBlockId) {
      previousSelectedBlockIdRef.current = null;
      selectedBlockSourceTextRef.current = "";
    }
  }, [selectedBlockId]);

  useEffect(() => {
    if (!editMode) {
      clearActiveEdit();
    }
  }, [clearActiveEdit, editMode]);

  useEffect(() => {
    if (!selectedBlock) return;

    const isNewSelection = previousSelectedBlockIdRef.current !== selectedBlock.id;
    if (isNewSelection) {
      previousSelectedBlockIdRef.current = selectedBlock.id;
      selectedBlockSourceTextRef.current = selectedBlock.text;
      draftTextRef.current = selectedBlock.text;
      setDraftText(selectedBlock.text);
      resetDraftHistory(selectedBlock.text);
      return;
    }

    if (draftTextRef.current === selectedBlockSourceTextRef.current) {
      selectedBlockSourceTextRef.current = selectedBlock.text;
      draftTextRef.current = selectedBlock.text;
      setDraftText(selectedBlock.text);
      resetDraftHistory(selectedBlock.text);
      previewBlockText(selectedBlock.id, selectedBlock.text);
    }
  }, [previewBlockText, resetDraftHistory, selectedBlock]);

  useEffect(() => {
    if (!selectedBlockId) {
      cleanupInlineEditable();
      return;
    }
    window.setTimeout(() => activateInlineEditable(selectedBlockId), 0);
  }, [activateInlineEditable, cleanupInlineEditable, selectedBlockId]);

  useEffect(() => {
    if (!agentJob || !["running"].includes(agentJob.status)) return;

    const timer = window.setInterval(async () => {
      try {
        const payload = await requestJson<{ job: AgentJob }>(`/api/agent-jobs/${agentJob.id}`);
        setAgentJob(payload.job);
        if (payload.job.status === "completed") {
          setStatus("Agent job completed.");
          if (selectedDeckId) {
            await refreshManifestInPlace(selectedDeckId);
            if (selectedBlockIdRef.current) {
              setPendingPreviewRefresh(true);
              setStatus("Agent job completed. Preview refresh is paused while this block is selected.");
            } else {
              reloadPreviewPreservingState("Agent job completed. Refreshed preview.");
            }
          }
        }
        if (payload.job.status === "failed") {
          setStatus("Agent job failed. Check the job output.");
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [agentJob, refreshManifestInPlace, reloadPreviewPreservingState, selectedDeckId]);

  const selectBlock = useCallback(
    (blockId: string) => {
      const block = manifest?.blocks.find((candidate) => candidate.id === blockId);
      if (!block) return;
      setSelectedBlockId(blockId);
      selectedBlockIdRef.current = blockId;
      selectedBlockSourceTextRef.current = block.text;
      previousSelectedBlockIdRef.current = blockId;
      draftTextRef.current = block.text;
      setDraftText(block.text);
      resetDraftHistory(block.text);
      setStatus(`Selected ${block.id} on slide ${block.slideId}.`);
    },
    [manifest, resetDraftHistory]
  );

  const getSlideLabel = useCallback((slide: SlideSummary) => {
    const firstText = slide.blocks
      .map((block) => block.text.trim().split(/\r?\n/)[0])
      .find(Boolean);
    return firstText || slide.kind || slide.id;
  }, []);

  const getBlockElement = useCallback(
    (doc: Document, blockId: string) => {
      const comments = findBlockComments(doc, blockId);
      return comments?.start.parentElement ?? null;
    },
    [findBlockComments]
  );

  const refreshTextStyleOptions = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    const win = iframeRef.current?.contentWindow;
    if (!doc || !win || !manifest) return;

    const options = new Map<string, TextStyleOption>();
    const supportedTags = new Set(["h1", "h2", "h3", "p", "div", "span"]);
    for (const block of manifest.blocks) {
      if (!block.textStyle) continue;
      const tagName = block.textStyle.tagName;
      if (!supportedTags.has(tagName)) continue;
      const className = block.textStyle.className;
      const value = textStyleKey(block.textStyle);
      if (options.has(value)) continue;

      const element = getBlockElement(doc, block.id);
      const computed = element ? win.getComputedStyle(element) : null;
      const classLabel = className ? `.${className.split(/\s+/).join(".")}` : "";
      const detail = computed
        ? `${computed.fontSize} / ${computed.fontWeight}${computed.textTransform !== "none" ? ` / ${computed.textTransform}` : ""}`
        : "deck style";
      options.set(value, {
        value,
        label: `${tagName.toUpperCase()}${classLabel}`,
        detail,
        tagName,
        className
      });
    }

    setTextStyleOptions(Array.from(options.values()));
  }, [getBlockElement, manifest]);

  const resetHiddenPreviewSlides = useCallback((doc: Document) => {
    doc
      .querySelectorAll<HTMLElement>(".slides section[data-local-editor-hidden-clone='true']")
      .forEach((section) => section.remove());

    doc
      .querySelectorAll<HTMLElement>(".slides section[data-local-editor-hidden-preview='true']")
      .forEach((section) => {
        section.setAttribute("data-visibility", "hidden");
        section.removeAttribute("data-local-editor-hidden-preview");
      });
  }, []);

  const refreshOverlay = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    const win = iframe?.contentWindow as RevealWindow | null;
    if (!iframe || !doc || !manifest) return;

    const priorLayer = doc.getElementById("reveal-local-editor-overlay");
    priorLayer?.remove();

    const priorStyle = doc.getElementById("reveal-local-editor-style");
    if (!priorStyle) {
      const style = doc.createElement("style");
      style.id = "reveal-local-editor-style";
      style.textContent = `
        #reveal-local-editor-overlay {
          inset: 0;
          pointer-events: none;
          position: fixed;
          z-index: 2147483647;
        }
        .reveal-local-editor-hit {
          background: transparent;
          border: 2px solid transparent;
          box-shadow: none;
          box-sizing: border-box;
          cursor: text;
          pointer-events: auto;
          position: fixed;
        }
        .reveal-local-editor-hit[data-edit-mode="true"] {
          background: rgba(0, 255, 255, 0.07);
          border-color: rgba(0, 255, 255, 0.82);
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.72);
        }
        .reveal-local-editor-hit:hover {
          background: rgba(216, 255, 50, 0.11);
          border-color: rgba(216, 255, 50, 0.92);
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.72);
        }
        .reveal-local-editor-hit[data-selected="true"] {
          background: rgba(216, 255, 50, 0.16);
          border-color: rgb(216, 255, 50);
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.72);
        }
        .reveal-local-editor-hit[data-selected="true"] {
          pointer-events: none;
        }
        .reveal-local-editor-tag {
          background: #050505;
          color: #d8ff32;
          font: 11px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
          left: -2px;
          max-width: 220px;
          overflow: hidden;
          padding: 3px 5px;
          position: absolute;
          text-overflow: ellipsis;
          top: -22px;
          opacity: 0;
          white-space: nowrap;
        }
        .reveal-local-editor-hit:hover .reveal-local-editor-tag,
        .reveal-local-editor-hit[data-edit-mode="true"] .reveal-local-editor-tag {
          opacity: 1;
        }
        .reveal-local-editor-active-text {
          caret-color: #d8ff32;
          outline: 2px solid rgb(216, 255, 50);
          outline-offset: 4px;
          position: relative;
          z-index: 2147483646;
        }
      `;
      doc.head.appendChild(style);
    }

    const layer = doc.createElement("div");
    layer.id = "reveal-local-editor-overlay";
    doc.body.appendChild(layer);

    const hiddenPreviewSlide = doc.querySelector<HTMLElement>(
      ".slides section[data-local-editor-hidden-clone='true'].present"
    );
    const currentSlide =
      hiddenPreviewSlide ?? win?.Reveal?.getCurrentSlide?.() ?? doc.querySelector(".slides section.present");
    const searchRoot = currentSlide ?? doc.body;
    const comments: Comment[] = [];
    const walker = doc.createTreeWalker(searchRoot, NodeFilter.SHOW_COMMENT);
    let current = walker.nextNode();
    while (current) {
      comments.push(current as Comment);
      current = walker.nextNode();
    }

    const knownBlockIds = new Set(manifest.blocks.map((block) => block.id));

    for (let index = 0; index < comments.length; index += 1) {
      const start = comments[index];
      const startMatch = start.nodeValue?.match(/^\s*copy:([a-z0-9._-]+)\s*$/i);
      if (!startMatch) continue;

      const blockId = startMatch[1];
      if (!knownBlockIds.has(blockId)) continue;

      const end = comments
        .slice(index + 1)
        .find((comment) => /^\s*\/copy\s*$/i.test(comment.nodeValue || ""));
      if (!end) continue;

      const range = doc.createRange();
      range.setStartAfter(start);
      range.setEndBefore(end);

      let rect = range.getBoundingClientRect();
      const parentRect =
        start.parentElement?.nodeType === 1
          ? start.parentElement.getBoundingClientRect()
          : null;

      if ((rect.width < 2 || rect.height < 2) && parentRect) {
        rect = parentRect;
      }

      if (rect.width < 2 || rect.height < 2) continue;

      const hit = doc.createElement("button");
      hit.type = "button";
      hit.className = "reveal-local-editor-hit";
      hit.dataset.blockId = blockId;
      hit.dataset.editMode = String(editMode);
      hit.dataset.selected = String(blockId === selectedBlockId);
      hit.style.left = `${rect.left}px`;
      hit.style.top = `${rect.top}px`;
      hit.style.width = `${rect.width}px`;
      hit.style.height = `${rect.height}px`;
      hit.setAttribute("aria-label", `Edit ${blockId}`);

      const tag = doc.createElement("span");
      tag.className = "reveal-local-editor-tag";
      tag.textContent = blockId;
      hit.appendChild(tag);

      hit.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        pendingCaretPointRef.current = { x: event.clientX, y: event.clientY };
        if (!editMode) setEditMode(true);
        selectBlock(blockId);
      });

      layer.appendChild(hit);
    }

  }, [editMode, manifest, selectBlock, selectedBlockId]);

  const persistBlockText = useCallback(
    async (
      deckId: string,
      blockId: string,
      text: string,
      options: {
        previousText?: string;
        recordHistory?: boolean;
        reloadPreview: boolean;
        statusVerb: string;
        successStatus?: string;
      }
    ) => {
      const win = iframeRef.current?.contentWindow as RevealWindow | null;
      const indices = win?.Reveal?.getIndices?.() ?? null;
      setStatus(`${options.statusVerb} ${blockId}...`);
      const previousText = options.previousText;
      ignoreOwnFileRefreshUntilRef.current = Date.now() + 5000;

      const payload = await requestJson<{ manifest: DeckManifest; sync?: { stdout?: string } }>(
        `/api/decks/${deckId}/blocks/${encodeURIComponent(blockId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        }
      );
      ignoreOwnFileRefreshUntilRef.current = Date.now() + 5000;

      if (options.recordHistory !== false && previousText !== undefined) {
        recordPersistedHistory({
          deckId,
          blockId,
          beforeText: previousText,
          afterText: text
        });
      }

      if (selectedBlockIdRef.current === blockId) {
        selectedBlockSourceTextRef.current = text;
        resetDraftHistory(text);
      }
      setManifest(payload.manifest);
      setPendingPreviewRefresh(false);

      if (options.reloadPreview) {
        setRestorePoint(indices);
        setReloadKey((value) => value + 1);
      } else {
        previewBlockText(blockId, text);
        window.setTimeout(() => {
          refreshOverlay();
          refreshTextStyleOptions();
        }, 0);
      }

      setStatus(options.successStatus ?? `Saved ${blockId}.`);
    },
    [previewBlockText, recordPersistedHistory, refreshOverlay, refreshTextStyleOptions, resetDraftHistory]
  );

  const autoApplyActiveEdit = useCallback(
    async (options: { clearAfterSave: boolean } = { clearAfterSave: true }) => {
      const deckId = selectedDeckIdRef.current;
      const blockId = selectedBlockIdRef.current;
      if (!deckId || !blockId) {
        if (options.clearAfterSave) clearActiveEdit();
        return;
      }

      const text = draftTextRef.current;
      const previousText = selectedBlockSourceTextRef.current;
      if (text === previousText) {
        if (options.clearAfterSave && selectedBlockIdRef.current === blockId) clearActiveEdit();
        return;
      }

      const applyKey = `${deckId}\n${blockId}\n${text}`;
      if (autoApplyKeyRef.current === applyKey && autoApplyPromiseRef.current) {
        await autoApplyPromiseRef.current;
        return;
      }

      const applyPromise = (async () => {
        try {
          await persistBlockText(deckId, blockId, text, {
            previousText,
            reloadPreview: false,
            statusVerb: "Applying"
          });
          if (options.clearAfterSave && selectedBlockIdRef.current === blockId) {
            clearActiveEdit();
          }
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          if (autoApplyKeyRef.current === applyKey) {
            autoApplyKeyRef.current = null;
            autoApplyPromiseRef.current = null;
          }
        }
      })();

      autoApplyKeyRef.current = applyKey;
      autoApplyPromiseRef.current = applyPromise;
      await applyPromise;
    },
    [clearActiveEdit, persistBlockText]
  );

  const handlePersistedHistoryKeyDown = useCallback(
    (event: KeyboardEvent | EditorKeyboardEvent) => {
      const isUndo =
        (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z";
      const isRedo =
        (event.ctrlKey || event.metaKey) &&
        (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"));

      if (!isUndo && !isRedo) return;
      const hasActiveDraftChange =
        Boolean(selectedBlockIdRef.current) && draftTextRef.current !== selectedBlockSourceTextRef.current;
      if (hasActiveDraftChange) return;

      const edit = isUndo ? persistedUndoStackRef.current.pop() : persistedRedoStackRef.current.pop();
      if (!edit) return;

      event.preventDefault();
      event.stopPropagation();

      if (isUndo) {
        persistedRedoStackRef.current = [
          ...persistedRedoStackRef.current.slice(-(maxDraftHistoryEntries - 1)),
          edit
        ];
      } else {
        persistedUndoStackRef.current = [
          ...persistedUndoStackRef.current.slice(-(maxDraftHistoryEntries - 1)),
          edit
        ];
      }

      void persistBlockText(edit.deckId, edit.blockId, isUndo ? edit.beforeText : edit.afterText, {
        recordHistory: false,
        reloadPreview: false,
        statusVerb: isUndo ? "Undoing" : "Redoing",
        successStatus: `${isUndo ? "Undid" : "Redid"} ${edit.blockId}.`
      }).catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    },
    [persistBlockText]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      handlePersistedHistoryKeyDown(event);
    };

    persistedHistoryKeyDownHandlerRef.current = handlePersistedHistoryKeyDown;
    window.addEventListener("keydown", onKeyDown);
    return () => {
      if (persistedHistoryKeyDownHandlerRef.current === handlePersistedHistoryKeyDown) {
        persistedHistoryKeyDownHandlerRef.current = null;
      }
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handlePersistedHistoryKeyDown]);

  const navigateToSlide = useCallback(
    (slide: SlideSummary) => {
      const win = iframeRef.current?.contentWindow as RevealWindow | null;
      const doc = iframeRef.current?.contentDocument;
      if (!win || !doc || !manifest) return;

      clearActiveEdit();
      resetHiddenPreviewSlides(doc);
      win.Reveal?.sync?.();
      win.Reveal?.slide?.(slide.index - 1);
      rememberSlideIndex(slide.index);
      setStatus(`Showing slide ${slide.index}: ${slide.id}.`);
      window.setTimeout(refreshOverlay, 80);
    },
    [clearActiveEdit, manifest, refreshOverlay, rememberSlideIndex, resetHiddenPreviewSlides]
  );

  const attachIframeEditor = useCallback(() => {
    const iframe = iframeRef.current;
    const win = iframe?.contentWindow as RevealWindow | null;
    const doc = iframe?.contentDocument;
    if (!win || !doc) return;

    const onMouseDown = (event: MouseEvent) => {
      const active = editableElementRef.current;
      const target = event.target as Node | null;
      if (active && target && !active.contains(target)) {
        void autoApplyActiveEdit({ clearAfterSave: true });
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      handlePersistedHistoryKeyDown(event);
    };

    doc.addEventListener("mousedown", onMouseDown);
    doc.addEventListener("keydown", onKeyDown);

    const storedSlideIndex = selectedDeckId
      ? readStoredSlideIndex(selectedDeckId, manifest?.slides.length)
      : null;

    if (restorePoint && win.Reveal?.slide) {
      window.setTimeout(() => {
        win.Reveal?.slide?.(restorePoint.h, restorePoint.v, restorePoint.f);
        setRestorePoint(null);
        refreshOverlay();
      }, 100);
    } else if (storedSlideIndex && win.Reveal?.slide) {
      window.setTimeout(() => {
        win.Reveal?.slide?.(storedSlideIndex - 1);
        rememberSlideIndex(storedSlideIndex);
        refreshOverlay();
      }, 100);
    }

    const updateCurrentSlide = () => {
      const currentSlide =
        doc.querySelector<HTMLElement>(".slides section[data-local-editor-hidden-clone='true'].present") ??
        win.Reveal?.getCurrentSlide?.();
      const sourceIndex = currentSlide?.getAttribute("data-local-editor-source-index");
      if (sourceIndex) {
        rememberSlideIndex(Number(sourceIndex));
        return;
      }

      const slideSections = Array.from(doc.querySelectorAll<HTMLElement>(".slides section"));
      const physicalIndex = currentSlide ? slideSections.indexOf(currentSlide) : -1;
      if (physicalIndex >= 0) {
        rememberSlideIndex(physicalIndex + 1);
        return;
      }

      const indices = win.Reveal?.getIndices?.();
      if (indices) rememberSlideIndex(indices.h + 1);
    };

    window.setTimeout(() => {
      updateCurrentSlide();
      refreshOverlay();
      refreshTextStyleOptions();
      const selectedId = selectedBlockIdRef.current;
      if (selectedId) {
        previewBlockText(selectedId, draftTextRef.current);
        activateInlineEditable(selectedId);
      }
    }, 250);
    win.Reveal?.on?.("slidechanged", () => {
      updateCurrentSlide();
      window.setTimeout(() => {
        refreshOverlay();
        refreshTextStyleOptions();
      }, 50);
    });
    win.addEventListener("resize", refreshOverlay);
  }, [
    activateInlineEditable,
    autoApplyActiveEdit,
    clearActiveEdit,
    handlePersistedHistoryKeyDown,
    manifest,
    previewBlockText,
    refreshOverlay,
    refreshTextStyleOptions,
    rememberSlideIndex,
    restorePoint,
    selectedDeckId
  ]);

  useEffect(() => {
    refreshOverlay();
    refreshTextStyleOptions();
  }, [refreshOverlay, refreshTextStyleOptions]);

  const replaceDraftSelection = useCallback(
    (formatSelection: (selection: string) => string, fallback = "") => {
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? draftText.length;
      const end = textarea?.selectionEnd ?? draftText.length;
      const selectedText = draftText.slice(start, end) || fallback;
      const replacement = formatSelection(selectedText);
      const nextText = `${draftText.slice(0, start)}${replacement}${draftText.slice(end)}`;
      updateDraftText(nextText);

      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(start, start + replacement.length);
      });
    },
    [draftText, updateDraftText]
  );

  const applyInlineFormat = useCallback(
    (format: "bold" | "italic") => {
      if (format === "bold") {
        replaceDraftSelection((selection) => `**${selection}**`, "bold text");
      } else {
        replaceDraftSelection((selection) => `*${selection}*`, "italic text");
      }
    },
    [replaceDraftSelection]
  );

  const applyLink = useCallback(() => {
    const href = linkUrl.trim();
    if (!href || !isSafeLinkUrl(href)) {
      setStatus("Enter a valid http, https, or mailto link first.");
      return;
    }

    replaceDraftSelection((selection) => `[${selection}](${href})`, "link text");
  }, [linkUrl, replaceDraftSelection]);

  const saveSelectedBlockStyle = async (styleValue: string) => {
    if (!selectedDeckId || !selectedBlock) return;
    const option = textStyleOptions.find((candidate) => candidate.value === styleValue);
    if (!option) return;

    try {
      const win = iframeRef.current?.contentWindow as RevealWindow | null;
      const indices = win?.Reveal?.getIndices?.() ?? null;
      setStatus(`Applying ${option.label} to ${selectedBlock.id}...`);

      const payload = await requestJson<{ manifest: DeckManifest }>(
        `/api/decks/${selectedDeckId}/blocks/${encodeURIComponent(selectedBlock.id)}/style`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            style: {
              tagName: option.tagName,
              className: option.className
            }
          })
        }
      );

      setManifest(payload.manifest);
      setRestorePoint(indices);
      setPendingPreviewRefresh(false);
      setReloadKey((value) => value + 1);
      setStatus(`Applied ${option.label} to ${selectedBlock.id}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const saveSelectedBlock = async () => {
    if (!selectedDeckId || !selectedBlock) return;
    try {
      await persistBlockText(selectedDeckId, selectedBlock.id, draftTextRef.current, {
        previousText: selectedBlockSourceTextRef.current,
        reloadPreview: true,
        statusVerb: "Saving"
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const applySlideMutation = useCallback(
    async (
      action: "duplicate" | "insert-after" | "visibility" | "move",
      options: { direction?: "up" | "down"; hidden?: boolean } = {}
    ) => {
      if (!selectedDeckId || !currentSlide) return;

      try {
        const method = action === "visibility" ? "PUT" : "POST";
        const body =
          action === "visibility"
            ? { hidden: options.hidden }
            : action === "move"
              ? { direction: options.direction }
              : {};

        setStatus(`Updating slide ${currentSlide.id}...`);
        const payload = await requestJson<{ manifest: DeckManifest; slideId?: string; moved?: boolean }>(
          `/api/decks/${selectedDeckId}/slides/${encodeURIComponent(currentSlide.id)}/${action}`,
          {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          }
        );

        setManifest(payload.manifest);
        const targetSlide =
          payload.slideId
            ? payload.manifest.slides.find((slide) => slide.id === payload.slideId)
            : payload.manifest.slides.find((slide) => slide.id === currentSlide.id);
        const nextSlideIndex = targetSlide?.index ?? currentSlide.index;
        currentSlideIndexRef.current = nextSlideIndex;
        setCurrentSlideIndex(nextSlideIndex);
        writeStoredSlideIndex(selectedDeckId, nextSlideIndex);
        setReloadKey((value) => value + 1);
        setStatus(`Updated slide ${targetSlide?.id ?? currentSlide.id}.`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [currentSlide, selectedDeckId]
  );

  const submitPrompt = async () => {
    if (!selectedDeckId || !promptText.trim()) return;
    try {
      setStatus("Starting Codex agent job...");
      const payload = await requestJson<{ job: AgentJob }>(`/api/decks/${selectedDeckId}/agent-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: promptText,
          scope: {
            blockId: selectedBlockId,
            slideId: selectedBlock?.slideId
          }
        })
      });
      setAgentJob(payload.job);
      setStatus("Agent job running...");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div
      className="app-shell"
      onKeyDownCapture={handlePersistedHistoryKeyDown}
      onMouseDownCapture={(event) => {
        const target = event.target as HTMLElement | null;
        if (!target || target.closest(".editor-card")) return;
        void autoApplyActiveEdit({ clearAfterSave: true });
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">RevealJS Local Editor</div>
          <div className="brand-subtitle">Local-only deck editing</div>
        </div>

        <section className="workspace-card" aria-label="Workspace">
          <div className="workspace-card-header">
            <span className="eyebrow">Workspace</span>
            <button className="secondary compact-button" onClick={pickWorkspace} disabled={workspaceBusy}>
              Browse
            </button>
          </div>
          <form
            className="workspace-form"
            onSubmit={(event) => {
              event.preventDefault();
              void openWorkspace(workspaceDraft);
            }}
          >
            <input
              value={workspaceDraft}
              onChange={(event) => setWorkspaceDraft(event.target.value)}
              placeholder="Path to folder containing deck folders"
              aria-label="Workspace path"
              disabled={workspaceBusy}
            />
            <button className="secondary compact-button" type="submit" disabled={workspaceBusy || !workspaceDraft.trim()}>
              Open
            </button>
          </form>
          {workspacePath && <code className="workspace-path">{workspacePath}</code>}
          {recentWorkspaces.length > 0 && (
            <div className="recent-workspaces">
              <span>Recent</span>
              {recentWorkspaces.map((recent) => (
                <button
                  className={recent.toLowerCase() === workspacePath.toLowerCase() ? "recent-workspace active" : "recent-workspace"}
                  key={recent}
                  onClick={() => void openWorkspace(recent)}
                  disabled={workspaceBusy}
                  title={recent}
                  type="button"
                >
                  {recent}
                </button>
              ))}
            </div>
          )}
        </section>

        <label className="field">
          <span>Deck</span>
          <select
            value={selectedDeckId}
            onChange={(event) => {
              setSelectedDeckId(event.target.value);
              setReloadKey((value) => value + 1);
            }}
            disabled={!decks.length}
          >
            {!decks.length && <option value="">No decks found</option>}
            {decks.map((deck) => (
              <option key={deck.id} value={deck.id}>
                {deck.name}
              </option>
            ))}
          </select>
        </label>

        <section className="controls-pane" aria-label="Editor controls">
          <div className="controls-pane-header">
            <span className="eyebrow">Controls</span>
            <span>No hotkeys</span>
          </div>
          <div className="control-grid">
            <button className={editMode ? "primary active" : "primary"} onClick={() => setEditMode((value) => !value)}>
              {editMode ? "Exit Edit Mode" : "Enter Edit Mode"}
            </button>

            <button className="secondary" onClick={() => setPromptOpen((value) => !value)}>
              {promptOpen ? "Close Codex Pane" : "Ask Codex"}
            </button>

            <button
              className="secondary"
              onClick={() => void autoApplyActiveEdit({ clearAfterSave: true })}
              disabled={!selectedBlockId}
            >
              Clear Selection
            </button>

            {pendingPreviewRefresh && (
              <button
                className="secondary pending-refresh"
                onClick={() => reloadPreviewPreservingState("Preview refreshed with latest deck changes.")}
                disabled={hasUnsavedDraft}
                title={hasUnsavedDraft ? "Save or clear the current edit before refreshing the preview." : undefined}
              >
                Refresh Preview
              </button>
            )}
          </div>
        </section>

        <div className="summary">
          <div>{manifest?.slides.length ?? 0} slides</div>
          <div>{manifest?.blocks.length ?? 0} editable blocks</div>
          <div>{hiddenSlideCount} hidden slides</div>
          <div>{manifest?.deck.hasCopyMd ? "copy.md enabled" : "HTML-only edits"}</div>
        </div>

        {currentSlide && (
          <section className="controls-pane" aria-label="Slide structure">
            <div className="controls-pane-header">
              <span className="eyebrow">Slide Structure</span>
              <span>{currentSlide.id}</span>
            </div>
            <div className="control-grid two-up">
              <button className="secondary" type="button" onClick={() => void applySlideMutation("duplicate")}>
                Duplicate
              </button>
              <button className="secondary" type="button" onClick={() => void applySlideMutation("insert-after")}>
                Insert After
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void applySlideMutation("visibility", { hidden: !currentSlide.hidden })}
              >
                {currentSlide.hidden ? "Show" : "Hide"}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void applySlideMutation("move", { direction: "up" })}
                disabled={currentSlide.index <= 1}
              >
                Move Up
              </button>
              <button
                className="secondary full-width"
                type="button"
                onClick={() => void applySlideMutation("move", { direction: "down" })}
                disabled={Boolean(manifest && currentSlide.index >= manifest.slides.length)}
              >
                Move Down
              </button>
            </div>
          </section>
        )}

        {manifest && (
          <section className="slide-list" aria-label="Slides">
            <div className="slide-list-header">
              <span className="eyebrow">Slides</span>
              <span>{manifest.slides.length}</span>
            </div>
            <div className="slide-list-items">
              {manifest.slides.map((slide) => (
                <button
                  key={slide.id}
                  className={
                    slide.index === currentSlideIndex
                      ? "slide-list-item active"
                      : "slide-list-item"
                  }
                  onClick={() => navigateToSlide(slide)}
                  type="button"
                >
                  <span className="slide-list-index">{slide.index}</span>
                  <span className="slide-list-copy">
                    <strong>{getSlideLabel(slide)}</strong>
                    <span>
                      {slide.id}
                      {slide.kind ? ` · ${slide.kind}` : ""}
                    </span>
                  </span>
                  {slide.hidden && <span className="slide-hidden-pill">Hidden</span>}
                </button>
              ))}
            </div>
          </section>
        )}

        {selectedBlock && (
          <div className="editor-card">
            <div className="editor-card-header">
              <div>
                <div className="eyebrow">Selected Block</div>
                <strong>{selectedBlock.id}</strong>
              </div>
              <button
                className="icon-button"
                onClick={() => void autoApplyActiveEdit({ clearAfterSave: true })}
                aria-label="Clear selection"
              >
                x
              </button>
            </div>
            <div className="block-meta">
              Slide {selectedSlide?.index}: {selectedBlock.slideId}
            </div>
            <label className="field compact-field">
              <span>Text Style</span>
              <select
                value={textStyleKey(selectedBlock.textStyle)}
                onChange={(event) => saveSelectedBlockStyle(event.target.value)}
              >
                {!selectedBlock.textStyle && <option value="">Current wrapper</option>}
                {textStyleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} - {option.detail}
                  </option>
                ))}
              </select>
            </label>
            <div className="format-panel" aria-label="Text formatting">
              <div className="format-buttons">
                <button className="secondary" type="button" onClick={() => applyInlineFormat("bold")}>
                  Bold
                </button>
                <button className="secondary" type="button" onClick={() => applyInlineFormat("italic")}>
                  Italic
                </button>
              </div>
              <div className="link-controls">
                <input
                  value={linkUrl}
                  onChange={(event) => setLinkUrl(event.target.value)}
                  placeholder="https://example.com"
                  aria-label="Link URL"
                />
                <button className="secondary" type="button" onClick={applyLink}>
                  Link
                </button>
              </div>
              <p className="muted">Inline formatting saves as markdown in copy.md.</p>
            </div>
            <textarea
              ref={textareaRef}
              value={draftText}
              onChange={(event) => updateDraftText(event.target.value)}
              onKeyDown={handleEditorKeyDown}
              rows={8}
              spellCheck
            />
            <button className="primary" onClick={saveSelectedBlock}>
              Save Text
            </button>
          </div>
        )}

        {promptOpen && (
          <div className="editor-card">
            <div className="eyebrow">Prompted Edit</div>
            <textarea
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
              placeholder="Make this slide sharper for a sponsor audience."
              rows={5}
            />
            <button className="primary" onClick={submitPrompt}>
              Launch Agent
            </button>
            <p className="muted">Runs locally with Codex CLI and reports validation plus git diff.</p>
            {agentJob && (
              <div className="job-panel">
                <div className="block-meta">
                  Job {agentJob.id.slice(0, 8)} · {agentJob.status}
                </div>
                {agentJob.validation && (
                  <div className={agentJob.validation.ok ? "validation ok" : "validation failed"}>
                    Validation {agentJob.validation.ok ? "passed" : "failed"}
                  </div>
                )}
                {agentJob.stdout && <pre>{agentJob.stdout.slice(-4000)}</pre>}
                {agentJob.stderr && <pre className="stderr">{agentJob.stderr.slice(-4000)}</pre>}
                {agentJob.diff && <pre className="diff">{agentJob.diff.slice(0, 8000)}</pre>}
              </div>
            )}
          </div>
        )}

        <div className="status">{error || status}</div>
        <div className="roots">
          {deckRoots.map((root) => (
            <code key={root}>{root}</code>
          ))}
        </div>
      </aside>

      <main className="deck-stage">
        {deckUrl ? (
          <>
            <iframe
              key={`${selectedDeckId}-${reloadKey}`}
              ref={iframeRef}
              title="RevealJS deck preview"
              src={deckUrl}
              onLoad={attachIframeEditor}
            />
          </>
        ) : (
          <div className="empty-state">No deck selected.</div>
        )}
      </main>
    </div>
  );
}
