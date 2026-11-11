import { useSyncExternalStore } from "react";

// Mirrors Settings > Appearance > "Show replies a paragraph at a time" for the chat view. useTheme
// feeds it from the open profile's settings; until they load, the default (on) applies.
let enabled = true;
const listeners = new Set<() => void>();

export function setReplyPacing(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): boolean {
  return enabled;
}

export function useReplyPacing(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
