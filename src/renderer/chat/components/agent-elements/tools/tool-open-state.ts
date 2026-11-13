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
