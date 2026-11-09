import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { invokeCommand, isCommandRegistered } from "../../../../commands/commandRegistry";
import { useRenderMath } from "../../../../markdown/math/renderMathSetting";
import type { TurnWindowApi } from "../virtual/use-turn-window";
import { createFindPainter, type FindPainter } from "./dom-highlight";
import {
  FindIndex,
  formatFindCount,
  identityOf,
  initialMatch,
  reselect,
  stepMatch,
  type FindMatch,
  type FindTurn,
  type MatchIdentity,
} from "./find-index";
import type { FindInThreadBarProps } from "./FindInThreadBar";
import { revealMatch } from "./reveal";
import { useFindShortcut } from "./use-find-shortcut";

/** While a reply streams, the index is brought up to date at most this often. */
export const STREAMING_REINDEX_MS = 300;
/** Time one slice of the index build may take before it yields to the page. */
export const INDEX_SLICE_MS = 8;
/** While the index is being built, the results catch up at most this often. */
export const INDEX_PROGRESS_MS = 120;
/** At most this many unread messages are read during a search instead of waiting for the build. */
const READ_ON_THE_SPOT = 4;

type ActiveMatch = MatchIdentity & { turnKey: string };

type Options = {
  enabled: boolean;
  turns: readonly FindTurn[];
  isStreaming: boolean;
  containerRef: { readonly current: HTMLDivElement | null };
  rowsRef: { readonly current: HTMLDivElement | null };
  virtualization: Pick<TurnWindowApi, "beginNavigation" | "cancelNavigation" | "scrollToKey">;
  /** Called when a match is about to be shown: the reader no longer follows the end. */
  onNavigate: () => void;
  onProgrammaticScroll: () => void;
};

const NO_MATCHES: FindMatch[] = [];

/** `value`, but at most every `delayMs` while `delayMs` is above zero. */
function useThrottled<T>(value: T, delayMs: number): T {
  const [held, setHeld] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (delayMs === 0) {
      setHeld((current) => (current === latest.current ? current : latest.current));
      return;
    }
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHeld(latest.current);
    }, delayMs);
  }, [value, delayMs]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return delayMs === 0 ? value : held;
}

function focusComposer(): void {
  if (isCommandRegistered("composer.focus")) invokeCommand("composer.focus");
}

type Idle = { cancel: () => void };

/** Runs `run` when the page is idle (on a timer where there is no idle callback). */
function whenIdle(run: () => void): Idle {
  const host = globalThis as {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof host.requestIdleCallback === "function") {
    const handle = host.requestIdleCallback(run, { timeout: 100 });
    return { cancel: () => host.cancelIdleCallback?.(handle) };
  }
  const handle = setTimeout(run, 0);
  return { cancel: () => clearTimeout(handle) };
}

/** The turn at the top of the view: the first mounted row whose bottom is below the container's top. */
function viewportAnchorTurnKey(container: HTMLElement | null, rows: HTMLElement | null): string | null {
  const top = container?.getBoundingClientRect().top ?? 0;
  for (const child of Array.from(rows?.children ?? [])) {
    const key = (child as HTMLElement).dataset?.turnKey;
    if (key !== undefined && child.getBoundingClientRect().bottom > top) return key;
  }
  return null;
}

function messagesOf(turn: FindTurn): UIMessage[] {
  return turn.userMsg ? [turn.userMsg, ...turn.assistantMsgs] : turn.assistantMsgs;
}

/**
 * The thread's messages in the order the index reads them: from the turn at the
 * top of the view to the end, then back from it to the start. A new search
 * starts at or below the view, so those matches are ready first.
 */
export function* indexOrder(turns: readonly FindTurn[], anchor: number): Generator<UIMessage> {
  const from = Math.min(Math.max(anchor, 0), Math.max(turns.length - 1, 0));
  for (let i = from; i < turns.length; i += 1) yield* messagesOf(turns[i]!);
  for (let i = from - 1; i >= 0; i -= 1) yield* messagesOf(turns[i]!);
}

/**
 * Whether a search can start at `match` before the index is complete: it is at
 * or below the anchor turn, and every message from the anchor to it has been
 * read, so no earlier match below the view can still turn up.
 */
export function startIsSettled(index: FindIndex, turns: readonly FindTurn[], anchor: number, match: FindMatch): boolean {
  const from = Math.max(anchor, 0);
  const at = turns.findIndex((turn) => turn.key === match.turnKey);
  if (at < from) return false;
  for (let i = from; i <= at; i += 1) {
    if (!messagesOf(turns[i]!).every((message) => index.isIndexed(message))) return false;
  }
  return true;
}

/**
 * Find in the open thread: the bar's state, the index over the message data (so
 * turns that are not mounted are searched too), the highlight painter, and the
 * landing on a match through the turn window.
 *
 * The index is built when the bar opens, in idle slices starting at the view,
 * and kept while the transcript is mounted; after that only messages that change
 * (a streaming reply) are read again. The bar sends its query when typing
 * pauses, so a keystroke runs no search and renders nothing here.
 */
export type ThreadFind = {
  open: boolean;
  barProps: FindInThreadBarProps | null;
  /** Opens the bar and focuses its field, as Ctrl/Cmd+F does; null while find is off. */
  openFind: (() => void) | null;
};

export function useThreadFind(options: Options): ThreadFind {
  const { enabled, turns, isStreaming } = options;
  const math = useRenderMath();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<ActiveMatch | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const painterRef = useRef<FindPainter | null>(null);
  const searching = enabled && open;

  const index = useMemo(() => new FindIndex(math), [math]);
  // Follows index.revision, so the results catch up as the build reads more of the thread.
  const [indexRevision, setIndexRevision] = useState(0);
  const searchedTurns = useThrottled(turns, searching && isStreaming ? STREAMING_REINDEX_MS : 0);

  const result = useMemo(
    () =>
      searching && query !== ""
        ? index.search(searchedTurns, query, {
            // A few changed messages (a streaming reply) are read on the spot; a thread
            // still being read is searched as far as it goes.
            readMissing: index.missing(searchedTurns, READ_ON_THE_SPOT + 1) <= READ_ON_THE_SPOT,
          })
        : { matches: NO_MATCHES, complete: true },
    // indexRevision: the same turns, with more of them read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searching, query, searchedTurns, index, indexRevision],
  );
  const matches = result.matches;
  const activeIndex = useMemo(() => reselect(matches, active), [matches, active]);

  // What callbacks that outlive a render read.
  const latest = useRef({ options, matches, activeIndex, open, query });
  latest.current = { options, matches, activeIndex, open, query };

  // While the bar is open, bring the index up to date: one slice at once (a streaming
  // reply, or the turns around the view), the rest when the page is idle.
  useEffect(() => {
    if (!searching) return;
    const current = latest.current.options;
    const anchorKey = viewportAnchorTurnKey(current.containerRef.current, current.rowsRef.current);
    const found = anchorKey === null ? -1 : searchedTurns.findIndex((turn) => turn.key === anchorKey);
    const anchor = found === -1 ? searchedTurns.length - 1 : found;
    let idle: Idle | null = null;
    let reported = index.revision;
    let reportedAt = performance.now();
    const report = (done: boolean) => {
      const now = performance.now();
      if (index.revision !== reported && (done || now - reportedAt >= INDEX_PROGRESS_MS)) {
        reported = index.revision;
        reportedAt = now;
        setIndexRevision(reported);
      }
    };
    const step = () => {
      const done = index.indexSome(indexOrder(searchedTurns, anchor), INDEX_SLICE_MS);
      report(done);
      idle = done ? null : whenIdle(step);
    };
    const done = index.indexSome(indexOrder(searchedTurns, anchor), INDEX_SLICE_MS);
    reportedAt = 0;
    report(done);
    if (!done) idle = whenIdle(step);
    return () => idle?.cancel();
  }, [searching, searchedTurns, index]);

  // Messages that left the thread are forgotten when the bar closes.
  useEffect(() => {
    if (searching) return;
    index.retain(new Set(turns.flatMap((turn) => messagesOf(turn).map((message) => message.id))));
  }, [searching, turns, index]);

  const openBar = useCallback(() => {
    // Escape gives focus back to whatever had it before the bar took it.
    const focused = document.activeElement;
    const bar = inputRef.current?.closest("[role='search']");
    if (focused && focused !== document.body && !bar?.contains(focused)) returnFocusRef.current = focused;
    setOpen(true);
    setFocusRequest((count) => count + 1);
  }, []);

  useFindShortcut({ container: () => options.containerRef.current, open: openBar }, enabled);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open, focusRequest]);

  useEffect(() => {
    const rows = options.rowsRef.current;
    if (!searching || !rows) return;
    const painter = createFindPainter(rows);
    painterRef.current = painter;
    return () => {
      painter.dispose();
      if (painterRef.current === painter) painterRef.current = null;
    };
  }, [searching, options.rowsRef]);

  useEffect(() => {
    painterRef.current?.setQuery(searching ? query : "");
  }, [searching, query]);

  useEffect(() => {
    painterRef.current?.setActive(active);
  }, [active, searching]);

  const goTo = useCallback((match: FindMatch) => {
    const { options: current } = latest.current;
    const painter = painterRef.current;
    const container = current.containerRef.current;
    if (!painter || !container) return;
    setActive({ ...identityOf(match), turnKey: match.turnKey });
    current.onNavigate();
    const navigation = current.virtualization.beginNavigation();
    void revealMatch(match, navigation, {
      container,
      painter,
      scrollToKey: (key, target) => current.virtualization.scrollToKey(key, target, navigation),
      onProgrammaticScroll: current.onProgrammaticScroll,
    });
  }, []);

  // A new query (or reopening the bar) starts from where the reader is: in or below
  // the viewport, else the first match. While the index is still being read it waits
  // until that start is certain. After that, the index changing under a stream does
  // not move the reader.
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!searching) {
      startedFor.current = null;
      return;
    }
    if (startedFor.current === query) return;
    const { options: current } = latest.current;
    const found = result.matches;
    if (query === "" || (found.length === 0 && result.complete)) {
      startedFor.current = query;
      current.virtualization.cancelNavigation();
      setActive(null);
      return;
    }
    if (found.length === 0) return;
    const container = current.containerRef.current;
    const painter = painterRef.current;
    const top = container?.getBoundingClientRect().top ?? 0;
    const anchorTurnKey = viewportAnchorTurnKey(container, current.rowsRef.current);
    const start = initialMatch(found, current.turns.map((turn) => turn.key), {
      anchorTurnKey,
      isAboveViewport: (match) => {
        const range = painter?.locate(match);
        return range ? range.getBoundingClientRect().bottom <= top + 1 : false;
      },
    });
    if (start === null) return;
    if (!result.complete) {
      const anchor = anchorTurnKey === null ? 0 : current.turns.findIndex((turn) => turn.key === anchorTurnKey);
      if (!startIsSettled(index, current.turns, anchor, found[start]!)) return;
    }
    startedFor.current = query;
    goTo(found[start]!);
  }, [searching, query, result, index, goTo]);

  const step = useCallback(
    (delta: 1 | -1) => {
      const { matches: found, activeIndex: at } = latest.current;
      const next = stepMatch(found.length, at, delta);
      if (next !== null) goTo(found[next]!);
    },
    [goTo],
  );

  const close = useCallback(() => {
    latest.current.options.virtualization.cancelNavigation();
    setOpen(false);
    setActive(null);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
    else focusComposer();
  }, []);

  // The thread closing under an open bar must not leave a landing running.
  useEffect(() => () => latest.current.options.virtualization.cancelNavigation(), []);

  const openFind = enabled ? openBar : null;
  if (!enabled || !open) return { open: false, barProps: null, openFind };
  return {
    open,
    openFind,
    barProps: {
      inputRef,
      query,
      onQueryChange: setQuery,
      countLabel: formatFindCount(activeIndex, matches.length, query, !result.complete),
      hasMatches: matches.length > 0,
      onNext: () => step(1),
      onPrevious: () => step(-1),
      onClose: close,
    },
  };
}
