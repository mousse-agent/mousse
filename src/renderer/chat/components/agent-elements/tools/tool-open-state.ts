import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import { useToolRowInfo } from "./tool-icon";

/**
 * Which tool rows and groups a person opened in one chat list, by the call's id (or the group's key), kept outside the
 * rows: the list rebuilds a row when the steps around it change (a thought starts or ends beside it, a second call
 * turns one row into a group), and a row that kept its own state then came back closed. The list provides one store
 * (`ToolOpenContext`); a row drawn outside a list keeps its own state.
 */
export type ToolOpenStore = {
  get: (key: string) => boolean | undefined;
  set: (key: string, open: boolean) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createToolOpenStore(): ToolOpenStore {
  const opened = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  return {
    get: (key) => opened.get(key),
    set: (key, open) => {
      if (opened.get(key) === open) return;
      opened.set(key, open);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const ToolOpenContext = createContext<ToolOpenStore | null>(null);

const NO_SUBSCRIBE = () => () => {};

/** Whether the person opened or closed the row or group under `key`; undefined when they never toggled it. */
export function useToolOpenOf(): (key: string) => boolean | undefined {
  const store = useContext(ToolOpenContext);
  return useCallback((key: string) => store?.get(key), [store]);
}

/**
 * A row's or group's open state under `key`, starting at `initial` until the person toggles it. Without a key or a
 * list's store, null: the caller keeps its own state.
 */
export function useToolOpen(key: string | undefined, initial: boolean): [boolean, (open: boolean) => void] | null {
  const store = useContext(ToolOpenContext);
  const active = store && key ? store : null;
  const value = useSyncExternalStore(active?.subscribe ?? NO_SUBSCRIBE, () => (active && key ? active.get(key) : undefined), () => undefined);
  const set = useCallback((open: boolean) => { if (active && key) active.set(key, open); }, [active, key]);
  return active ? [value ?? initial, set] : null;
}

/**
 * A row's own open state, for a row that keeps it itself (a command, an edit): under its call's id in the list's
 * store, so it survives the list rebuilding the row; its own state otherwise.
 */
export function useRowOpenState(initial: boolean): [boolean, (update: boolean | ((open: boolean) => boolean)) => void] {
  const { openKey } = useToolRowInfo();
  const [own, setOwn] = useState(initial);
  const kept = useToolOpen(openKey, initial);
  if (kept) return [kept[0], (update) => kept[1](typeof update === "function" ? update(kept[0]) : update)];
  return [own, setOwn];
}

/**
 * The open key of the live row whose chevron has keyboard focus. When the run ends, its group line replaces the live
 * row under the same key and takes the focus (`takeLiveRunFocus`), or, when the finished turn folds the run away, the
 * turn's "Worked for" line does; so focus does not drop to the page. Whatever takes it does so as it mounts, in the
 * commit that removes the chevron; the live row then drops the hand-off (`dropLiveRunFocus`), so nothing that mounts
 * later (a fold opened afterwards) takes focus.
 */
let focusedLiveRun: string | null = null;

/** The live row's chevron for `key` took focus, or lost it to something else while it stays on the page. */
export function liveRunToggleFocus(key: string | undefined, focused: boolean, toggle: HTMLElement): void {
  if (!key) return;
  if (focused) {
    focusedLiveRun = key;
    return;
  }
  // A chevron taken off the page may still report a blur: only one still on the page lost focus to something else.
  queueMicrotask(() => {
    if (toggle.isConnected && focusedLiveRun === key) focusedLiveRun = null;
  });
}

/**
 * The chevron for `key` is gone and the commit that removed it is over: run from a passive effect's cleanup, which
 * follows every layout effect of that commit, so a destination that mounted has already taken the focus.
 */
export function dropLiveRunFocus(key: string | undefined): void {
  if (key && focusedLiveRun === key) focusedLiveRun = null;
}

/** Whether the line for `key` should take focus from the live row it replaced (focus is on nothing now). */
export function takeLiveRunFocus(key: string | undefined): boolean {
  if (!key || focusedLiveRun !== key) return false;
  focusedLiveRun = null;
  const active = typeof document === "undefined" ? null : document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/** Set inside an opened live row (the turn's current run): the thought still being written there shows open. */
export const LiveRunBodyContext = createContext(false);
