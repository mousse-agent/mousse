import { deletedThreadIds, useAppStore } from "../../../stores/appStore";
import { createToolOpenStore, type ToolOpenStore } from "./tools/tool-open-state";

/**
 * What the person opened in a thread's transcript: finished turns' folds (by turn key and part) and tool rows and
 * groups (by their stable keys, `tools/tool-open-state.ts`). Kept in memory per thread for the app session, so
 * switching to another thread and back finds them as they were; nothing is saved to disk. A deleted thread's
 * entry goes with it.
 */
export type ThreadOpenMemory = {
  folds: Set<string>;
  tools: ToolOpenStore;
};

const memory = new Map<string, ThreadOpenMemory>();

/** The thread's memory, made on first use. Without a thread id, a fresh one that nothing else shares. */
export function threadOpenMemory(threadId: string | null | undefined): ThreadOpenMemory {
  if (!threadId) return { folds: new Set(), tools: createToolOpenStore() };
  let entry = memory.get(threadId);
  if (!entry) memory.set(threadId, (entry = { folds: new Set(), tools: createToolOpenStore() }));
  return entry;
}

export function forgetThreadOpenMemory(threadIds: readonly string[]): void {
  for (const id of threadIds) memory.delete(id);
}

/** Whether a thread has memory, for tests. */
export function hasThreadOpenMemory(threadId: string): boolean {
  return memory.has(threadId);
}

useAppStore.subscribe((state, previous) => {
  const gone = deletedThreadIds(previous, state);
  if (gone.length) forgetThreadOpenMemory(gone);
});
