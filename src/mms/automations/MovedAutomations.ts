import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { withFileLock } from '../scheduled/fileLock'
import type { JobSchedule, ScheduledJobRunRecord } from '../../shared/types'

/**
 * Automations that moved to another of the person's computers (Move to computer). The automation is stored and run
 * there from then on; here only its run history stays, read-only, so the runs it made on this computer and their
 * threads are still in Recent.
 */
export interface MovedAutomation {
  /** Its id here, before it moved. */
  id: string
  name: string
  schedule: JobSchedule
  projectId?: string
  movedAt: string
  /** The computer it moved to, and its id there. */
  movedTo: { node: string; name: string; jobId: string }
  runHistory: ScheduledJobRunRecord[]
}

/**
 * A move that started and is not finished: the automation is held paused here until the other computer confirms its
 * copy. It says whether the automation was on before, so the move that finishes it (a retry, after a lost answer or a
 * restart) turns the copy on only then. It holds while the automation is still paused by that move (`pausedAt`).
 */
export interface MoveTransfer {
  id: string
  node: string
  /** The other computer's name, for "Check <computer>". */
  name: string
  wasEnabled: boolean
  pausedAt?: string
  startedAt: string
}

interface MovedFile {
  version: 1
  moved: MovedAutomation[]
  transfers?: MoveTransfer[]
}

/** Moved automations kept for their history, newest last. */
const KEPT = 200

export class MovedAutomationStore {
  private readonly dir: string
  private readonly path: string

  constructor(homeDir: string) {
    this.dir = join(homeDir, 'scheduled')
    this.path = join(this.dir, 'moved.json')
  }

  list(): MovedAutomation[] {
    const parsed = this.read()
    return Array.isArray(parsed.moved) ? parsed.moved.filter((entry) => entry && typeof entry.id === 'string' && Array.isArray(entry.runHistory)) : []
  }

  /** The move of automation `id` that is not finished, if any. */
  transfer(id: string): MoveTransfer | undefined {
    const parsed = this.read()
    return Array.isArray(parsed.transfers) ? parsed.transfers.find((entry) => entry && entry.id === id) : undefined
  }

  /** Records (or replaces) the unfinished move of `entry.id`, before the other computer is asked. */
  begin(entry: MoveTransfer): void {
    this.write((file) => ({ ...file, transfers: [...(file.transfers ?? []).filter((known) => known.id !== entry.id), entry] }))
  }

  /** The move of `id` is over: done, or refused there so nothing was made. */
  end(id: string): void {
    this.write((file) => ({ ...file, transfers: (file.transfers ?? []).filter((known) => known.id !== id) }))
  }

  /** The move is confirmed: its history is kept. */
  add(entry: MovedAutomation): void {
    this.write((file) => ({ ...file, moved: [...file.moved.filter((known) => known.id !== entry.id), entry].slice(-KEPT) }))
  }

  private read(): Partial<MovedFile> {
    if (!existsSync(this.path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<MovedFile>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  private write(change: (file: MovedFile) => MovedFile): void {
    mkdirSync(this.dir, { recursive: true })
    withFileLock(join(this.dir, '.moved.lock'), () => {
      const current = this.read()
      const next = change({ version: 1, moved: this.list(), ...(Array.isArray(current.transfers) ? { transfers: current.transfers } : {}) })
      atomicWriteJsonSync(this.path, { version: 1, moved: next.moved, ...(next.transfers?.length ? { transfers: next.transfers } : {}) } satisfies MovedFile)
    })
  }
}
