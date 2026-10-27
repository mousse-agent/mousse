import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeCommand, isCommandRegistered } from "../../../../commands/commandRegistry";
import { useRenderMath } from "../../../../markdown/math/renderMathSetting";
import type { TurnWindowApi } from "../virtual/use-turn-window";
import { createFindPainter, type FindPainter } from "./dom-highlight";
import {
  buildFindIndex,
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

/** While a reply streams, the index is rebuilt at most this often. */
export const STREAMING_REINDEX_MS = 300;

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

const NO_MATCHES: readonly FindMatch[] = [];

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

/**
 * Find in the open thread: the bar's state, the index over the message data (so
 * turns that are not mounted are searched too), the highlight painter, and the
 * landing on a match through the turn window.
 */
export function useThreadFind(options: Options): { open: boolean; barProps: FindInThreadBarProps | null } {
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

  const searchedTurns = useThrottled(turns, searching && isStreaming ? STREAMING_REINDEX_MS : 0);
  const matches = useMemo(
    () => (searching && query !== "" ? buildFindIndex(searchedTurns, query, { math }) : NO_MATCHES),
    [searching, query, searchedTurns, math],
  );
  const activeIndex = useMemo(() => reselect(matches, active), [matches, active]);

  // What callbacks that outlive a render read.
  const latest = useRef({ options, matches, activeIndex, open, query });
  latest.current = { options, matches, activeIndex, open, query };

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

  // A new query starts from where the reader is: in or below the viewport, else the first match.
  useEffect(() => {
    if (!searching) return;
    const { options: current, matches: found } = latest.current;
    if (query === "" || found.length === 0) {
      current.virtualization.cancelNavigation();
      setActive(null);
      return;
    }
    const container = current.containerRef.current;
    const rows = current.rowsRef.current;
    const painter = painterRef.current;
    const top = container?.getBoundingClientRect().top ?? 0;
    let anchorTurnKey: string | null = null;
    for (const child of Array.from(rows?.children ?? [])) {
      const key = (child as HTMLElement).dataset?.turnKey;
      if (key !== undefined && child.getBoundingClientRect().bottom > top) {
        anchorTurnKey = key;
        break;
      }
    }
    const start = initialMatch(found, current.turns.map((turn) => turn.key), {
      anchorTurnKey,
      isAboveViewport: (match) => {
        const range = painter?.locate(match);
        return range ? range.getBoundingClientRect().bottom <= top + 1 : false;
      },
    });
    if (start !== null) goTo(found[start]!);
    // Only a new query (or reopening the bar) moves the reader; the index changing under a stream does not.
  }, [searching, query, goTo]);

  const step = useCallback(
    (delta: 1 | -1) => {
      const { matches: found, activeIndex: index } = latest.current;
      const next = stepMatch(found.length, index, delta);
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

  if (!enabled || !open) return { open: false, barProps: null };
  return {
    open,
    barProps: {
      inputRef,
      query,
      onQueryChange: setQuery,
      countLabel: formatFindCount(activeIndex, matches.length, query),
      hasMatches: matches.length > 0,
      onNext: () => step(1),
      onPrevious: () => step(-1),
      onClose: close,
    },
  };
}
