import { deletedThreadIds, useAppStore } from "../../../stores/appStore";
import { createToolOpenStore, type ToolOpenStore } from "./tools/tool-open-state";

/**
 * What the person opened in a thread's transcript: finished turns' folds (by turn key and part) and tool rows and
 * groups (by their stable keys, `tools/tool-open-state.ts`). Kept in memory per thread for the app session, so
 * switching to another thread and back finds them as they were; nothing is saved to disk. A deleted thread's
 * entry goes with it.
 *
 * `turnKeys` holds the list's turn-key aliases (message-list.tsx): a prompt sent from the composer shows first under
 * a temporary id, and its turn keeps that id as its key once the saved prompt takes its place. The aliases live here,
 * not in the list, so a turn has the same key after the list remounts, and the folds opened under it are found.
 * `sentAt` holds when each such prompt was sent (ms), by that temporary id: the turn's Working time counts from the
 * click, not from the later moment the service saved the prompt.
 */
export type ThreadOpenMemory = {
  folds: Set<string>;
  tools: ToolOpenStore;
  turnKeys: Map<string, string>;
  sentAt: Map<string, number>;
};

const memory = new Map<string, ThreadOpenMemory>();

const fresh = (): ThreadOpenMemory => ({ folds: new Set(), tools: createToolOpenStore(), turnKeys: new Map(), sentAt: new Map() });

/** The thread's memory, made on first use. Without a thread id, a fresh one that nothing else shares. */
export function threadOpenMemory(threadId: string | null | undefined): ThreadOpenMemory {
  if (!threadId) return fresh();
  let entry = memory.get(threadId);
  if (!entry) memory.set(threadId, (entry = fresh()));
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
