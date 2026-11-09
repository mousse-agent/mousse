// A Merge asked for from outside the PR panel (the Automations inbox's run strip): the panel opens and asks its own
// Merge question for that pull request, with its own merge rules, so the merge path stays the panel's.

let pending: { threadId: string; number: number; at: number } | null = null

/** How long an asked Merge waits for the panel to show that pull request. */
const WAIT_MS = 30_000

export function requestPanelMerge(threadId: string, number: number): void {
  pending = { threadId, number, at: Date.now() }
}

/** The panel shows this thread's pull request: whether a Merge was asked for it (and it is taken). */
export function takePanelMerge(threadId: string | null, number: number | null): boolean {
  if (!pending || !threadId || number === null) return false
  if (Date.now() - pending.at > WAIT_MS) {
    pending = null
    return false
  }
  if (pending.threadId !== threadId || pending.number !== number) return false
  pending = null
  return true
}
