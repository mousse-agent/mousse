import { useSyncExternalStore } from "react";

// Mirrors Settings > Appearance > Render math so Markdown can choose its
// plugins synchronously while rendering. useTheme feeds it from the settings
// the renderer already loads and listens to; until then math is on, the default.
let enabled = true;
const listeners = new Set<() => void>();

export function setRenderMath(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return enabled;
}

export function useRenderMath(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
