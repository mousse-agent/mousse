import { findOccurrences, normalizeForSearch, cleanQuery } from "./find-index";

/** The elements whose text find reads: a prompt, or one text part of a reply. */
export const FIND_SCOPE_SELECTOR = "[data-find-text]";

/** What the page does not show as prose: icons, toolbars, code-block chrome, and anything marked. */
const SKIP_SELECTOR =
  'svg, [data-find-ignore], [role="toolbar"], [data-streamdown="code-block-header"], [data-streamdown="code-block-actions"]';

/** A block boundary: text on either side of one never forms a match. */
const BLOCK_TAGS = new Set([
  "P", "LI", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY",
  "TR", "TD", "TH", "UL", "OL", "DIV", "BR", "HR", "DETAILS", "SUMMARY", "SECTION",
]);

export const HIGHLIGHT_NAME = "mousse-find";
export const ACTIVE_HIGHLIGHT_NAME = "mousse-find-active";

/** The part of the thread an occurrence belongs to, and its place among that part's occurrences. */
export type ScopeOccurrence = { messageId: string; partIndex: number; ordinal: number };

export type DomOccurrence = ScopeOccurrence & { range: Range };

type Segment = { node: Text; start: number; length: number };

/**
 * Collects the occurrences of `query` inside one scope as ranges. Text is
 * joined the way the index joins it: line breaks read as spaces in prose and
 * stay line breaks inside `pre`, where each rendered line also ends one. A
 * match that spans several inline elements (syntax-highlighted tokens, bold
 * words) is one range.
 */
function collectScope(scope: Element, needle: string, out: DomOccurrence[]): void {
  const messageId = (scope as HTMLElement).dataset.messageId ?? "";
  const partIndex = Number((scope as HTMLElement).dataset.partIndex ?? "0");
  let ordinal = 0;
  let text = "";
  let segments: Segment[] = [];

  const flush = () => {
    if (text !== "") {
      const normalized = normalizeForSearch(text);
      let cursor = 0;
      for (const start of findOccurrences(normalized, needle)) {
        const end = start + needle.length - 1;
        while (cursor < segments.length && segments[cursor]!.start + segments[cursor]!.length <= start) cursor += 1;
        let last = cursor;
        while (last < segments.length && segments[last]!.start + segments[last]!.length <= end) last += 1;
        const first = segments[cursor];
        const tail = segments[last];
        if (!first || !tail || first.start > start || tail.start > end) continue;
        const range = document.createRange();
        range.setStart(first.node, start - first.start);
        range.setEnd(tail.node, end - tail.start + 1);
        out.push({ messageId, partIndex, ordinal, range });
        ordinal += 1;
      }
    }
    text = "";
    segments = [];
  };

  const visit = (node: Node, inPre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = (node as Text).data;
      const value = inPre ? raw : raw.replace(/[\r\n]/g, " ");
      if (value === "") return;
      segments.push({ node: node as Text, start: text.length, length: value.length });
      text += value;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.matches(SKIP_SELECTOR)) return;
    if (element !== scope && element.matches(FIND_SCOPE_SELECTOR)) return;
    const block = BLOCK_TAGS.has(element.tagName);
    if (block) flush();
    const pre = inPre || element.tagName === "PRE";
    // Rendered code lines are block-level spans without a newline between them.
    if (inPre && element.classList.contains("block") && text !== "" && !text.endsWith("\n")) text += "\n";
    for (const child of Array.from(element.childNodes)) visit(child, pre);
    if (block) flush();
  };

  visit(scope, false);
  flush();
}

/**
 * Every occurrence of `query` in the scopes inside `row`, in reading order.
 * Occurrences are numbered per `(messageId, partIndex)` scope, which is the
 * order the index numbers them in.
 */
export function collectFindRanges(row: Element, query: string): DomOccurrence[] {
  const needle = normalizeForSearch(cleanQuery(query));
  const out: DomOccurrence[] = [];
  if (needle === "") return out;
  for (const scope of Array.from(row.querySelectorAll(FIND_SCOPE_SELECTOR))) collectScope(scope, needle, out);
  return out;
}

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

export type FindPainter = {
  setQuery(query: string): void;
  /** The occurrence to paint as the current one, or none. */
  setActive(active: (ScopeOccurrence & { turnKey: string }) | null): void;
  /** The range of an occurrence, from the mounted row; `null` while its row is not mounted. */
  locate(target: ScopeOccurrence & { turnKey: string }): Range | null;
  /** The first range of a part, for when the exact occurrence is missing. */
  locateFirstInPart(target: { turnKey: string; messageId: string; partIndex: number }): Range | null;
  row(turnKey: string): HTMLElement | null;
  repaint(): void;
  dispose(): void;
};

let paintOwner: object | null = null;

/**
 * Paints the occurrences in the mounted rows with the CSS Custom Highlight API
 * (nothing in the DOM changes, so nothing reflows) and keeps them current as
 * rows mount, unmount and stream. Ranges are cached per row and dropped when
 * something inside the row changes. Without the API it only locates ranges.
 */
export function createFindPainter(rowsRoot: HTMLElement): FindPainter {
  const owner = {};
  const cache = new Map<Element, { query: string; occurrences: DomOccurrence[] }>();
  let query = "";
  let active: (ScopeOccurrence & { turnKey: string }) | null = null;
  let frame = 0;

  const rows = (): HTMLElement[] =>
    Array.from(rowsRoot.children).filter((child): child is HTMLElement => child instanceof HTMLElement && "turnKey" in child.dataset);

  const occurrencesOf = (row: Element): DomOccurrence[] => {
    const cached = cache.get(row);
    if (cached && cached.query === query) return cached.occurrences;
    const occurrences = collectFindRanges(row, query);
    cache.set(row, { query, occurrences });
    return occurrences;
  };

  const rowFor = (turnKey: string): HTMLElement | null => rows().find((row) => row.dataset.turnKey === turnKey) ?? null;

  const clear = () => {
    if (!highlightsSupported() || paintOwner !== owner) return;
    CSS.highlights.delete(HIGHLIGHT_NAME);
    CSS.highlights.delete(ACTIVE_HIGHLIGHT_NAME);
    paintOwner = null;
  };

  const paint = () => {
    frame = 0;
    if (!highlightsSupported()) return;
    if (query === "") {
      clear();
      return;
    }
    const all: Range[] = [];
    let current: Range | null = null;
    for (const row of rows()) {
      for (const occurrence of occurrencesOf(row)) {
        all.push(occurrence.range);
        if (
          active &&
          row.dataset.turnKey === active.turnKey &&
          occurrence.messageId === active.messageId &&
          occurrence.partIndex === active.partIndex &&
          occurrence.ordinal === active.ordinal
        ) {
          current = occurrence.range;
        }
      }
    }
    paintOwner = owner;
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...all));
    const activeHighlight = new Highlight(...(current ? [current] : []));
    activeHighlight.priority = 1;
    CSS.highlights.set(ACTIVE_HIGHLIGHT_NAME, activeHighlight);
  };

  const schedule = () => {
    if (frame || !highlightsSupported()) return;
    frame = requestAnimationFrame(paint);
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target) continue;
      // The clock in a turn's status line ticks every second; it is not text find reads.
      if (target.closest("[data-find-ignore]")) continue;
      const row = target.closest("[data-turn-key]");
      if (row) cache.delete(row);
    }
    schedule();
  });
  observer.observe(rowsRoot, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-turn-key", "data-find-text", "data-find-ignore"],
  });

  return {
    setQuery(next) {
      if (next === query) return;
      query = next;
      cache.clear();
      schedule();
    },
    setActive(next) {
      active = next;
      schedule();
    },
    locate(target) {
      const row = rowFor(target.turnKey);
      if (!row) return null;
      const found = occurrencesOf(row).find(
        (occurrence) =>
          occurrence.messageId === target.messageId &&
          occurrence.partIndex === target.partIndex &&
          occurrence.ordinal === target.ordinal,
      );
      return found?.range ?? null;
    },
    locateFirstInPart(target) {
      const row = rowFor(target.turnKey);
      if (!row) return null;
      const found = occurrencesOf(row).find(
        (occurrence) => occurrence.messageId === target.messageId && occurrence.partIndex === target.partIndex,
      );
      return found?.range ?? null;
    },
    row: rowFor,
    repaint: schedule,
    dispose() {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      cache.clear();
      clear();
    },
  };
}
