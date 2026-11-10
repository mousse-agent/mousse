/**
 * Render counts of the transcript's hot components, for tests and for measuring a stream in a
 * running app. Off unless `globalThis.__mousseRenderCounts` is an object: then each count is
 * added to it by name. Costs one property read per render otherwise.
 */
type Counts = Record<string, number>;

function sink(): Counts | undefined {
  const value = (globalThis as { __mousseRenderCounts?: unknown }).__mousseRenderCounts;
  return value && typeof value === "object" ? (value as Counts) : undefined;
}

export function countRender(name: string, by = 1): void {
  const counts = sink();
  if (counts) counts[name] = (counts[name] ?? 0) + by;
}

/** Starts counting from zero (tests). */
export function startRenderCounts(): Counts {
  const counts: Counts = {};
  (globalThis as { __mousseRenderCounts?: Counts }).__mousseRenderCounts = counts;
  return counts;
}

export function stopRenderCounts(): void {
  delete (globalThis as { __mousseRenderCounts?: Counts }).__mousseRenderCounts;
}
