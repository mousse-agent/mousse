import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserActionOutcome } from '../../shared/browser/types'
import { journalPath } from '../lifecycle/paths'

export type JournalPhase = 'intent' | 'dispatched' | 'outcome'

export interface ActionJournalRecord {
  at: string
  profileId: string
  sessionId: string
  requestId: string
  generation: number
  phase: JournalPhase
  actionType: string
  dispatched?: boolean
  outcome?: BrowserActionOutcome
}

export class ScopedActionJournal {
  constructor(private readonly browserRoot: string) {}

  append(record: ActionJournalRecord): void {
    const path = journalPath(this.browserRoot, record.profileId, record.sessionId)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(record) + '\n')
  }
}
