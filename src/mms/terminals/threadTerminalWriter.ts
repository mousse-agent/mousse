import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'

/**
 * One writer hold for all the terminals one caller has open on a thread.
 *
 * A thread's terminals together are one writer: the first takes the thread's execution lease and starts one terminal
 * action turn, the next ones join that hold, and the last one to end checkpoints the turn and gives the lease back.
 * Nothing else that takes the lease (an agent turn, cleanup, a trash or delete) can start while any of them runs, and
 * a terminal still cannot start while one of those holds the lease. Holds are kept per caller (`key`): this computer's
 * windows share one, and each other computer has its own, which the lease keeps apart.
 */

/** How the turn of a hold ends: `completed` when one of its shells ran, `failed` when none ever started. */
export type TerminalTurnEnd = 'completed' | 'failed'

export interface TerminalWriterStart {
  /** Takes the thread's execution lease, or null when another writer holds it. */
  acquire(): ThreadLeaseHandle | null
  /** The refusal when the lease is held by another writer. */
  busy(): Error
  /** Starts the hold's terminal turn under the lease; resolves to how that turn is checkpointed. Never releases the lease. */
  begin(lease: ThreadLeaseHandle): Promise<(end: TerminalTurnEnd) => Promise<void>>
  /** Gives the lease back. */
  release(lease: ThreadLeaseHandle): void
  /** Throws unless the lease still owns the thread and the thread still admits a writer (not being trashed or deleted). */
  admit(lease: ThreadLeaseHandle): void
}

/** One terminal's part in a hold. */
export interface TerminalWriterMember {
  readonly lease: ThreadLeaseHandle
  /** The terminal's shell started. */
  started(): void
  /** The terminal ended (or never started); the last member to leave ends the turn and gives the lease back. */
  leave(): Promise<void>
}

interface Hold {
  lease: ThreadLeaseHandle
  start: TerminalWriterStart
  members: number
  anyStarted: boolean
  state: 'beginning' | 'open' | 'closing'
  begun: Promise<void>
  checkpoint?: (end: TerminalTurnEnd) => Promise<void>
  closed?: Promise<void>
}

/** How long a new terminal waits for a hold that is ending (its turn is being checkpointed) before it is refused. */
export const CLOSING_WAIT_MS = 5_000

export class ThreadTerminalWriters {
  private readonly holds = new Map<string, Hold>()

  constructor(private readonly closingWaitMs = CLOSING_WAIT_MS) {}

  /** The hold for `key` (a thread folder and caller), joined, or started with `start` when there is none. */
  async join(key: string, start: TerminalWriterStart): Promise<TerminalWriterMember> {
    let hold = this.holds.get(key)
    if (hold?.state === 'closing') {
      // The last terminal just ended and its turn is being checkpointed: start a new hold once that is done.
      await waitAtMost(hold.closed!, this.closingWaitMs)
      hold = this.holds.get(key)
      if (hold?.state === 'closing') throw start.busy()
    }
    if (!hold) return this.begin(key, start)

    const joined = hold
    // Counted before waiting, so the hold cannot end under a terminal that is still joining.
    joined.members += 1
    // When the first terminal cannot start the hold, this rejects; that terminal has already let the lease go.
    await joined.begun
    try {
      joined.start.admit(joined.lease)
    } catch (error) {
      await this.leave(key, joined)
      throw error
    }
    return this.member(key, joined)
  }

  /** How many terminals hold `key` now (tests and diagnostics). */
  members(key: string): number {
    return this.holds.get(key)?.members ?? 0
  }

  private async begin(key: string, start: TerminalWriterStart): Promise<TerminalWriterMember> {
    const lease = start.acquire()
    if (!lease) throw start.busy()
    let markBegun!: () => void
    let failBegun!: (error: unknown) => void
    const begun = new Promise<void>((resolve, reject) => { markBegun = resolve; failBegun = reject })
    // Joiners must not see an unhandled rejection when they are not there to catch it.
    begun.catch(() => undefined)
    const hold: Hold = { lease, start, members: 1, anyStarted: false, state: 'beginning', begun }
    // In the map before the first wait, so a terminal opened at the same moment joins instead of finding its own lease busy.
    this.holds.set(key, hold)
    try {
      hold.checkpoint = await start.begin(lease)
    } catch (error) {
      if (this.holds.get(key) === hold) this.holds.delete(key)
      hold.state = 'closing'
      hold.closed = Promise.resolve()
      start.release(lease)
      failBegun(error)
      throw error
    }
    hold.state = 'open'
    markBegun()
    return this.member(key, hold)
  }

  private member(key: string, hold: Hold): TerminalWriterMember {
    let left = false
    return {
      lease: hold.lease,
      started: () => { hold.anyStarted = true },
      leave: async () => {
        if (left) return
        left = true
        await this.leave(key, hold)
      }
    }
  }

  private async leave(key: string, hold: Hold): Promise<void> {
    hold.members -= 1
    if (hold.members > 0) return
    hold.state = 'closing'
    hold.closed = (async () => {
      try {
        await hold.checkpoint?.(hold.anyStarted ? 'completed' : 'failed')
      } finally {
        if (this.holds.get(key) === hold) this.holds.delete(key)
        hold.start.release(hold.lease)
      }
    })()
    await hold.closed
  }
}

async function waitAtMost(done: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([done.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
