import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FollowMode } from "./follow-mode";
import {
  DEFAULT_VIEWPORT,
  INITIAL_SETTLE,
  ROW_GAP,
  anchorDelta,
  buildLayout,
  computeWindow,
  keyTargetScrollTop,
  nextScrollTop,
  pickReadingNode,
  reconcileWindow,
  stepSettle,
  windowSpacers,
  type AnchorEdge,
  type AnchorNode,
  type ScrollAlign,
  type TurnLayout,
} from "./turn-window";

export type TurnWindowOptions = {
  containerRef: { readonly current: HTMLDivElement | null };
  /** The flex column that holds the rows and the two spacers, nothing else. */
  rowsRef: { readonly current: HTMLDivElement | null };
  /** A fresh array each render; the layout is rebuilt only when it differs element-wise. */
  keys: readonly string[];
  estimate: (key: string, index: number) => number;
  enabled: boolean;
  modeRef: { readonly current: FollowMode };
  /** Called before every programmatic `scrollTop` write. */
  onProgrammaticScroll: () => void;
};

/** One in-flight landing. Beginning another one, or cancelling, invalidates it. */
export type Navigation = {
  token: number;
  isCurrent: () => boolean;
  end: () => void;
};

type WindowState = { start: number; end: number; n: number };

type HeldAnchor = {
  /** An element, or a one-character text range inside a tall leaf. */
  target: Element | Range;
  /** Position in scroll-content space when it was picked. */
  pos: number;
  key: string;
  /** The edge of the element that `pos` measures; a text range is always held by its top. */
  edge: AnchorEdge;
};

type DomNode = AnchorNode & { el: Element };

const ANCHOR_SKIP = "svg, [aria-hidden], [data-find-ignore]";

function isScroller(el: Element): boolean {
  const style = getComputedStyle(el);
  return (
    style.overflowY === "auto" ||
    style.overflowY === "scroll" ||
    style.overflowX === "auto" ||
    style.overflowX === "scroll"
  );
}

/**
 * The element tree as `pickAnchor` walks it, read lazily so a search that stops
 * at the first visible child never measures the rest. A nested scroller is a
 * leaf: scrolling inside it moves its content without any layout shift.
 */
function domNode(el: Element, rect: DOMRect, isRoot: boolean): DomNode {
  return {
    el,
    top: rect.top,
    bottom: rect.bottom,
    children: {
      *[Symbol.iterator]() {
        if (!isRoot && isScroller(el)) return;
        for (const child of Array.from(el.children)) {
          if (child.matches(ANCHOR_SKIP)) continue;
          const childRect = child.getBoundingClientRect();
          if (childRect.height === 0) continue;
          yield domNode(child, childRect, false);
        }
      },
    },
  };
}

/**
 * A text range one character wide at the reading line inside a tall leaf. A
 * collapsed range reports an all-zero rect, so it is widened inside the same
 * text node (backwards when the caret sits at its end).
 */
function readingRange(leaf: Element, rect: DOMRect, topEdge: number): Range | null {
  if (typeof document.caretRangeFromPoint !== "function") return null;
  const y = Math.min(Math.max(topEdge + 1, rect.top), rect.bottom - 1);
  const caret = document.caretRangeFromPoint(rect.left + 8, y);
  const node = caret?.startContainer;
  if (!caret || !node || node.nodeType !== Node.TEXT_NODE) return null;
  if (!leaf.contains(node)) return null;
  const length = node.textContent?.length ?? 0;
  if (length === 0) return null;
  const range = document.createRange();
  if (caret.startOffset < length) {
    range.setStart(node, caret.startOffset);
    range.setEnd(node, caret.startOffset + 1);
  } else {
    range.setStart(node, length - 1);
    range.setEnd(node, length);
  }
  return range.getBoundingClientRect().height > 0 ? range : null;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function initialWindow(options: TurnWindowOptions): WindowState {
  const n = options.keys.length;
  if (!options.enabled || n <= 2) {
    return { start: Math.min(1, n), end: Math.max(Math.min(1, n), n - 1), n };
  }
  // Before any measurement: the last rows mount first when the thread opens at
  // the bottom.
  const layout = buildLayout(options.keys, new Map(), options.estimate);
  const top =
    options.modeRef.current === "following-end"
      ? Math.max(0, layout.total - DEFAULT_VIEWPORT)
      : 0;
  const { start, end } = computeWindow(layout, top, DEFAULT_VIEWPORT);
  return { start, end, n };
}

type Engine = ReturnType<typeof createEngine>;

function createEngine(
  getOptions: () => TurnWindowOptions,
  setWindowState: (update: (prev: WindowState) => WindowState) => void,
) {
  const measured = new Map<string, number>();
  const estimates = new Map<string, number>();
  const rowEls = new Map<string, Element>();
  const keyOfEl = new WeakMap<Element, string>();
  const refCallbacks = new Map<string, (el: HTMLElement | null) => void>();
  const listeners = new Set<() => void>();
  const topSpacerRef: { current: HTMLDivElement | null } = { current: null };
  const bottomSpacerRef: { current: HTMLDivElement | null } = { current: null };

  let layout: TurnLayout = buildLayout([], measured, () => 0);
  let keyIndex = new Map<string, number>();
  let committed = { start: 1, end: 1 };
  let anchor: HeldAnchor | null = null;
  let observer: ResizeObserver | null = null;
  let scrollFrame = 0;
  let originCache: number | null = null;
  const navigation = { id: 0, active: false };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const estimateFor = (key: string, index: number) => {
    let value = estimates.get(key);
    if (value === undefined) {
      value = getOptions().estimate(key, index);
      estimates.set(key, value);
    }
    return value;
  };

  /**
   * The rows wrapper's `gap` as laid out. It is a rem value (`gap-6`), so the
   * pixels depend on the root font size and are read, not assumed.
   */
  const rowGap = (): number => {
    const rows = getOptions().rowsRef.current;
    const parsed = rows ? Number.parseFloat(getComputedStyle(rows).rowGap) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : ROW_GAP;
  };

  const rebuildLayout = () => {
    layout = buildLayout(getOptions().keys, measured, estimateFor, rowGap());
    keyIndex = new Map(layout.keys.map((key, index) => [key, index]));
  };

  /** Forget everything about keys that left the thread. */
  const prune = () => {
    const stores: Map<string, unknown>[] = [measured, estimates, refCallbacks];
    for (const store of stores) {
      for (const key of store.keys()) if (!keyIndex.has(key)) store.delete(key);
    }
  };

  const writeSpacers = () => {
    const { topSpacer, bottomSpacer } = windowSpacers(
      layout,
      committed.start,
      committed.end,
    );
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${topSpacer}px`;
    if (bottomSpacerRef.current) {
      bottomSpacerRef.current.style.height = `${bottomSpacer}px`;
    }
  };

  /** The rows wrapper's offset inside the scroll content: layout space to scroll space. */
  const computeOrigin = (): number => {
    const { containerRef, rowsRef } = getOptions();
    const container = containerRef.current;
    const rows = rowsRef.current;
    if (!container || !rows) return 0;
    return (
      rows.getBoundingClientRect().top -
      (container.getBoundingClientRect().top + container.clientTop) +
      container.scrollTop
    );
  };

  const syncWindow = () => {
    const options = getOptions();
    const container = options.containerRef.current;
    const n = layout.keys.length;
    if (!options.enabled || !container || n <= 2) return;
    const next = computeWindow(
      layout,
      container.scrollTop - computeOrigin(),
      container.clientHeight || DEFAULT_VIEWPORT,
    );
    setWindowState((prev) =>
      prev.start === next.start && prev.end === next.end && prev.n === n
        ? prev
        : { start: next.start, end: next.end, n },
    );
  };

  const scrollSpace = (container: HTMLElement, containerTop: number, y: number) =>
    y - (containerTop + container.clientTop) + container.scrollTop;

  /** How far the held anchor moved because the layout changed since it was picked. */
  const shiftOf = (
    held: HeldAnchor,
    container: HTMLElement,
    containerTop: number,
    prevLayout: TurnLayout,
  ): number => {
    const target = held.target;
    const usable =
      target instanceof Range
        ? target.startContainer.isConnected && !target.collapsed
        : target.isConnected;
    if (usable) {
      const rect = target.getBoundingClientRect();
      if (rect.width !== 0 || rect.height !== 0) {
        return anchorDelta({
          posBefore: held.pos,
          posAfter: scrollSpace(
            container,
            containerTop,
            held.edge === "bottom" ? rect.bottom : rect.top,
          ),
        });
      }
    }
    return anchorDelta({
      fallback: { prev: prevLayout, next: layout, anchorKey: held.key },
    });
  };

  const pickReadingPoint = (
    container: HTMLElement,
    rows: HTMLElement,
    containerTop: number,
  ): HeldAnchor | null => {
    const topEdge = containerTop + container.clientTop;
    let rowEl: Element | null = null;
    let lastRow: Element | null = null;
    for (const child of Array.from(rows.children)) {
      if (!keyOfEl.has(child)) continue;
      lastRow = child;
      if (child.getBoundingClientRect().bottom > topEdge) {
        rowEl = child;
        break;
      }
    }
    rowEl ??= lastRow;
    if (!rowEl) return null;
    const key = keyOfEl.get(rowEl)!;
    const root = domNode(rowEl, rowEl.getBoundingClientRect(), true);
    const { node: picked, edge } = pickReadingNode(root, topEdge);
    const rect = picked.el.getBoundingClientRect();
    if (rect.top < topEdge) {
      // A tall leaf straddles the edge: hold the text at the edge, so a reflow
      // inside the leaf moves the reading point and not just the leaf's top.
      const range = readingRange(picked.el, rect, topEdge);
      if (range) {
        return {
          target: range,
          pos: scrollSpace(container, containerTop, range.getBoundingClientRect().top),
          key,
          edge: "top",
        };
      }
    }
    // No text to hold. A node that straddles the edge is held by its bottom, so
    // growth inside it above the edge (an unrendered block that expands, the
    // content above a row's toolbar) moves the held position and is corrected.
    return {
      target: picked.el,
      pos: scrollSpace(container, containerTop, edge === "bottom" ? rect.bottom : rect.top),
      key,
      edge,
    };
  };

  /**
   * First correct the held anchor for whatever moved it, then re-pick the
   * reading point. The previous layout is what the disconnected-target
   * fallback compares against.
   */
  const captureAnchor = (prevLayout: TurnLayout) => {
    const options = getOptions();
    const container = options.containerRef.current;
    const rows = options.rowsRef.current;
    if (!options.enabled || !container || !rows) return;
    const containerTop = container.getBoundingClientRect().top;
    // A landing in progress re-aims at its target every frame; correcting
    // under it would only add a second writer. Following the end still has to
    // hold within the frame, so it is never skipped.
    if (anchor && (!navigation.active || options.modeRef.current === "following-end")) {
      const scrollTop = container.scrollTop;
      const next = nextScrollTop({
        mode: options.modeRef.current,
        scrollTop,
        delta: shiftOf(anchor, container, containerTop, prevLayout),
        end: container.scrollHeight - container.clientHeight,
      });
      if (Math.abs(next - scrollTop) >= 1) {
        options.onProgrammaticScroll();
        container.scrollTop = next;
      }
    }
    anchor = pickReadingPoint(container, rows, containerTop);
  };

  /**
   * One transaction, in this order: rebuild the layout, write the spacer
   * heights, correct the held anchor, re-pick. The spacers are part of the
   * layout change being corrected, so they land before the anchor is measured
   * and `end` is read after them.
   */
  const transact = (openAtEnd = false) => {
    const prevLayout = layout;
    rebuildLayout();
    writeSpacers();
    const options = getOptions();
    const container = options.containerRef.current;
    if (openAtEnd && container && options.modeRef.current === "following-end") {
      options.onProgrammaticScroll();
      container.scrollTop = container.scrollHeight - container.clientHeight;
    }
    captureAnchor(prevLayout);
    syncWindow();
    notify();
  };

  const onRowsResized = (entries: ResizeObserverEntry[]) => {
    const { containerRef } = getOptions();
    let rowResized = false;
    for (const entry of entries) {
      const key = keyOfEl.get(entry.target);
      if (key === undefined) continue;
      measured.set(key, entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      rowResized = true;
    }
    if (rowResized) transact();
    else if (entries.some((entry) => entry.target === containerRef.current)) syncWindow();
  };

  const getObserver = () => (observer ??= new ResizeObserver(onRowsResized));

  const rowRef = (key: string) => {
    let callback = refCallbacks.get(key);
    if (!callback) {
      callback = (el) => {
        if (el) {
          // Not measured here: this runs while React is still committing, with
          // the spacers of the previous window in place, and reading a size
          // would lay out that half-way state (a jump to the end, where the
          // bottom spacer is dropped, clamps `scrollTop` back to the old
          // content). `commit` measures once the spacers are written.
          rowEls.set(key, el);
          keyOfEl.set(el, key);
          getObserver().observe(el);
        } else {
          const previous = rowEls.get(key);
          if (previous) {
            observer?.unobserve(previous);
            rowEls.delete(key);
          }
        }
      };
      refCallbacks.set(key, callback);
    }
    return callback;
  };

  const onScroll = () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      syncWindow();
      captureAnchor(layout);
    });
  };

  // Writing spacer heights and `scrollTop` inside the observer callback can
  // leave the content-wrapper observer's notification for the next frame; the
  // browser reports that as an error event that is not one.
  const onError = (event: ErrorEvent) => {
    if (event.message?.startsWith("ResizeObserver loop")) {
      event.stopImmediatePropagation();
      console.debug(`[turn-window] ${event.message}`);
    }
  };

  const beginNavigation = (): Navigation => {
    navigation.id += 1;
    navigation.active = true;
    const id = navigation.id;
    return {
      token: id,
      isCurrent: () => navigation.id === id,
      end: () => {
        if (navigation.id === id) navigation.active = false;
      },
    };
  };

  const cancelNavigation = () => {
    navigation.id += 1;
    navigation.active = false;
  };

  /** Every frame: read the target, write when away from it; stop once it holds. */
  const settle = (
    computeTarget: () => number | null,
    handle: Navigation,
    owned: boolean,
  ) =>
    new Promise<boolean>((resolve) => {
      let state = INITIAL_SETTLE;
      const finish = (settled: boolean) => {
        if (owned) handle.end();
        resolve(settled);
      };
      const frame = () => {
        const options = getOptions();
        const container = options.containerRef.current;
        if (!handle.isCurrent() || !container) {
          resolve(false);
          return;
        }
        const target = computeTarget();
        if (target === null) {
          finish(false);
          return;
        }
        const step = stepSettle(state, { target, scrollTop: container.scrollTop });
        state = step.state;
        if (step.write !== null) {
          options.onProgrammaticScroll();
          container.scrollTop = step.write;
          syncWindow();
        }
        if (step.done) finish(step.stable);
        else requestAnimationFrame(frame);
      };
      frame();
    });

  const scrollToKey = (
    key: string,
    target: { align: ScrollAlign; offset?: number },
    handle?: Navigation,
  ) =>
    settle(
      () => {
        const container = getOptions().containerRef.current;
        if (!container) return null;
        const wanted = keyTargetScrollTop(
          layout,
          computeOrigin(),
          key,
          target.align,
          container.clientHeight,
          target.offset ?? 0,
        );
        if (wanted === null) return null;
        return Math.min(wanted, Math.max(0, container.scrollHeight - container.clientHeight));
      },
      handle ?? beginNavigation(),
      !handle,
    );

  /** The end is the DOM end, read after the spacer writes; the last row is always mounted. */
  const settleToEnd = () =>
    settle(
      () => {
        const container = getOptions().containerRef.current;
        return container ? Math.max(0, container.scrollHeight - container.clientHeight) : null;
      },
      beginNavigation(),
      true,
    );

  const offsetOf = (key: string): number | undefined => {
    const index = keyIndex.get(key);
    if (index === undefined || !getOptions().enabled) return undefined;
    if (originCache === null) {
      originCache = computeOrigin();
      queueMicrotask(() => {
        originCache = null;
      });
    }
    return originCache + layout.offsets[index]!;
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  /** After a commit that changed the keys or the window. */
  const commit = (
    window: { start: number; end: number },
    opening: boolean,
    keysChanged: boolean,
  ) => {
    committed = window;
    // Spacers for the new window first, from the heights known so far, so the
    // content is whole again before any row is measured (see `rowRef`).
    rebuildLayout();
    writeSpacers();
    for (const [key, el] of rowEls) {
      if (!measured.has(key)) measured.set(key, el.getBoundingClientRect().height);
    }
    transact(opening);
    if (keysChanged) prune();
    if (opening && getOptions().modeRef.current === "following-end") void settleToEnd();
  };

  const attach = () => {
    const container = getOptions().containerRef.current;
    if (!container) return () => {};
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("error", onError);
    getObserver().observe(container);
    return () => {
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("error", onError);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      observer?.disconnect();
      observer = null;
      anchor = null;
      cancelNavigation();
    };
  };

  return {
    topSpacerRef,
    bottomSpacerRef,
    rowRef,
    scrollToKey,
    settleToEnd,
    beginNavigation,
    cancelNavigation,
    isNavigating: () => navigation.active,
    offsetOf,
    subscribe,
    commit,
    attach,
  };
}

export type TurnWindowApi = Pick<
  Engine,
  | "topSpacerRef"
  | "bottomSpacerRef"
  | "rowRef"
  | "scrollToKey"
  | "settleToEnd"
  | "beginNavigation"
  | "cancelNavigation"
  | "isNavigating"
  | "offsetOf"
  | "subscribe"
> & {
  /** The middle rows to mount, `[start, end)`; row 0 and the last row are always mounted. */
  window: { start: number; end: number };
};

/**
 * Mounts only the turns near the viewport. Heights come from measurement
 * (estimates until a row has been mounted once); the spacers stand in for the
 * rest. While reading, the element at the top of the viewport is held still
 * through every layout change, including inside the same turn.
 */
export function useTurnWindow(options: TurnWindowOptions): TurnWindowApi {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [stored, setStored] = useState(() => initialWindow(options));
  const engineRef = useRef<Engine | null>(null);
  engineRef.current ??= createEngine(() => optionsRef.current, setStored);
  const engine = engineRef.current;

  const keysRef = useRef(options.keys);
  const versionRef = useRef(0);
  if (!sameKeys(keysRef.current, options.keys)) {
    keysRef.current = options.keys;
    versionRef.current += 1;
  }
  const keysVersion = versionRef.current;

  const n = options.keys.length;
  const range = options.enabled
    ? reconcileWindow(stored, n)
    : { start: Math.min(1, n), end: Math.max(Math.min(1, n), n - 1) };

  const openedRef = useRef(false);
  const seenVersionRef = useRef(keysVersion);
  const { enabled } = options;
  useLayoutEffect(() => {
    if (!enabled) {
      openedRef.current = false;
      return;
    }
    const opening = !openedRef.current;
    openedRef.current = true;
    const keysChanged = seenVersionRef.current !== keysVersion;
    seenVersionRef.current = keysVersion;
    engine.commit({ start: range.start, end: range.end }, opening, keysChanged || opening);
  }, [engine, enabled, range.start, range.end, keysVersion]);

  useLayoutEffect(() => {
    if (!enabled) return;
    return engine.attach();
  }, [engine, enabled]);

  useEffect(() => () => engine.cancelNavigation(), [engine]);

  return {
    window: range,
    topSpacerRef: engine.topSpacerRef,
    bottomSpacerRef: engine.bottomSpacerRef,
    rowRef: engine.rowRef,
    scrollToKey: engine.scrollToKey,
    settleToEnd: engine.settleToEnd,
    beginNavigation: engine.beginNavigation,
    cancelNavigation: engine.cancelNavigation,
    isNavigating: engine.isNavigating,
    offsetOf: engine.offsetOf,
    subscribe: engine.subscribe,
  };
}
