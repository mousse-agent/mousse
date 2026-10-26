import { useSyncExternalStore } from "react";

// Mirrors Settings > Appearance > Render math so Markdown can choose its
// plugins synchronously while rendering. useTheme feeds it from the open
// profile's settings. Until they arrive (at startup and while switching
// profiles) the setting is unknown: math is parsed, as with the default, but
// shown as source, so a profile with math off never shows typeset formulas.
let enabled: boolean | undefined;
const listeners = new Set<() => void>();

/** `undefined` while the open profile's settings have not loaded. */
export function setRenderMath(next: boolean | undefined): void {
  if (next === enabled) return;
  enabled = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function parseSnapshot(): boolean {
  return enabled !== false;
}

function typesetSnapshot(): boolean {
  return enabled === true;
}

/** Whether to parse math: on unless the setting is known to be off. */
export function useRenderMath(): boolean {
  return useSyncExternalStore(subscribe, parseSnapshot, parseSnapshot);
}

/** Whether to typeset parsed math: only once the setting is known to be on. */
export function useTypesetMath(): boolean {
  return useSyncExternalStore(subscribe, typesetSnapshot, typesetSnapshot);
}
