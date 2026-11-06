import { useSyncExternalStore } from "react";
import type { TurnChangedFilesMode } from "../../shared/settings";

// Mirrors Settings > General > "Changed files after each turn" for the chat
// view. useTheme feeds it from the open profile's settings; until they load,
// the default (one summary line) applies.
let mode: TurnChangedFilesMode = "summary";
const listeners = new Set<() => void>();

export function setTurnChangedFiles(next: TurnChangedFilesMode): void {
  if (next === mode) return;
  mode = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): TurnChangedFilesMode {
  return mode;
}

export function useTurnChangedFiles(): TurnChangedFilesMode {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
