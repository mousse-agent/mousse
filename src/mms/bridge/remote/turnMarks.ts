import type { Thread, ThreadActivityState, TurnState } from '../../../shared/types'

/**
 * What the computer running a thread says about the thread's state, for the person's other computers. They are the
 * marks its own `activity` events carry (`protocol/server.ts`), so another computer announces the thread's status as
 * this one does:
 * - `scheduled`: the thread's last turn was a scheduled occurrence's. Its end is the automation's to announce.
 * - `stoppedByPerson`: a person stopped the thread (stopped, idle). It is not announced as stopped.
 * - `supervised`: the thread waits on the bot that started it (awaiting input). No one is pinged.
 */
export interface ListsMarks {
  scheduled?: true
  stoppedByPerson?: true
  supervised?: true
}

/** What the marks read of the profile. */
export interface TurnMarksServices {
  orchestrator: {
    isScheduledTurn(threadId: string): boolean
    stoppedByPerson(threadId: string): boolean
    waitSupervised(threadId: string, secretWaiting?: boolean): boolean
  }
  secretRequests?: { waiting(threadId: string): boolean } | null
}

function read(check: () => boolean): boolean {
  try {
    return check() === true
  } catch {
    // A profile that cannot say leaves the thread unmarked: its status is announced as an older computer's is.
    return false
  }
}

/** The marks of the threads of one lists source. */
export class TurnMarks {
  /** Threads whose last turn was a scheduled occurrence's. */
  private readonly scheduled = new Set<string>()

  /**
   * At each `activity` event of the profile's runtimes. Whether a turn is a scheduled occurrence's is known only while
   * it runs, and the lists are read a moment after its end, so it is noted here. A turn that is not one clears it.
   */
  note(services: TurnMarksServices, payload: unknown): void {
    const { threadId, state } = (payload ?? {}) as { threadId?: unknown; state?: unknown }
    if (typeof threadId !== 'string') return
    if (read(() => services.orchestrator.isScheduledTurn(threadId))) this.scheduled.add(threadId)
    else if (state === 'processing') this.scheduled.delete(threadId)
  }

  /** The marks of `threads` in the states the lists give them, by thread id; threads without any are left out. */
  of(
    services: TurnMarksServices,
    threads: readonly Pick<Thread, 'id'>[],
    activity: Record<string, ThreadActivityState>,
    turns: Record<string, TurnState>
  ): Record<string, ListsMarks> {
    const out: Record<string, ListsMarks> = {}
    for (const { id } of threads) {
      const state = activity[id] ?? 'idle'
      const marks: ListsMarks = {
        ...(this.scheduled.has(id) ? { scheduled: true as const } : {}),
        ...(state === 'idle' &&
        turns[id]?.phase === 'stopped' &&
        read(() => services.orchestrator.stoppedByPerson(id))
          ? { stoppedByPerson: true as const }
          : {}),
        ...(state === 'awaiting_input' &&
        read(() =>
          services.orchestrator.waitSupervised(
            id,
            read(() => services.secretRequests?.waiting(id) === true)
          )
        )
          ? { supervised: true as const }
          : {})
      }
      if (marks.scheduled || marks.stoppedByPerson || marks.supervised) out[id] = marks
    }
    return out
  }
}

/** The marks a lists snapshot carries (`ListsSnapshot.marks`), only the known ones; none from an older computer. */
export function marksOf(value: unknown): Map<string, ListsMarks> {
  const out = new Map<string, ListsMarks>()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const given = raw as Record<string, unknown>
    const marks: ListsMarks = {
      ...(given.scheduled === true ? { scheduled: true as const } : {}),
      ...(given.stoppedByPerson === true ? { stoppedByPerson: true as const } : {}),
      ...(given.supervised === true ? { supervised: true as const } : {})
    }
    if (marks.scheduled || marks.stoppedByPerson || marks.supervised) out.set(id, marks)
  }
  return out
}
