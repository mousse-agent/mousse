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

interface MovedFile {
  version: 1
  moved: MovedAutomation[]
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
    if (!existsSync(this.path)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<MovedFile>
      return Array.isArray(parsed.moved) ? parsed.moved.filter((entry) => entry && typeof entry.id === 'string' && Array.isArray(entry.runHistory)) : []
    } catch {
      return []
    }
  }

  add(entry: MovedAutomation): void {
    mkdirSync(this.dir, { recursive: true })
    withFileLock(join(this.dir, '.moved.lock'), () => {
      const moved = [...this.list().filter((known) => known.id !== entry.id), entry].slice(-KEPT)
      atomicWriteJsonSync(this.path, { version: 1, moved } satisfies MovedFile)
    })
  }
}
