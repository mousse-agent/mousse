/**
 * The trash is a step of a delete, and like a delete it refuses a thread that is not archived. Tests that exercise
 * the trash itself archive the thread first with this, straight in the store, so no Stop runs as part of it.
 */
export function archived(threads: { getThread(id: string): { settledAt?: string } | undefined; setThreadSettled(id: string, settled: boolean): unknown }, threadId: string): string {
  const thread = threads.getThread(threadId)
  if (thread && !thread.settledAt) threads.setThreadSettled(threadId, true)
  return threadId
}
