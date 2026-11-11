import { useSyncExternalStore } from "react";

// Mirrors Settings > Appearance > "Show replies a paragraph at a time" for the chat view. useTheme
// feeds it from the open profile's settings; until they load, the default (on) applies. While
// anything holds it (find in the thread is open), replies show whole.
let enabled = true;
let holds = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function setReplyPacing(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  notify();
}

/** Shows replies whole until the returned release is called (find needs the whole text on screen). */
export function holdReplyPacing(): () => void {
  holds += 1;
  if (holds === 1) notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): boolean {
  return enabled && holds === 0;
}

/** Whether a streaming reply is shown a paragraph at a time now. */
export function useReplyPacing(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
