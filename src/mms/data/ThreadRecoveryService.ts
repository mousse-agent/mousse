import { ThreadGenerationStore } from './ThreadGenerationStore'
import { ThreadJournal, type ThreadJournalRecord } from './ThreadJournal'

export interface ThreadRecoveryResult {
  repairedGeneration?: string
  cancelledOperations: string[]
  recoveryRequired: string[]
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/**
 * Reconcile durable intent with immutable generations before accepting another turn.
 * Git-specific sequencer reconciliation is supplied by higher-level operation services;
 * this layer never guesses or mutates unrelated Git state.
 */
export class ThreadRecoveryService {
  constructor(
    private readonly generations: ThreadGenerationStore,
    private readonly journal = new ThreadJournal(generations.threadDirectory)
  ) {}

  reconcile(): ThreadRecoveryResult {
    const result: ThreadRecoveryResult = { cancelledOperations: [], recoveryRequired: [] }
    const current = this.generations.getManifest()
    for (const record of this.journal.latestByOperation().values()) {
      if (TERMINAL.has(record.state)) continue
      if (record.resultGenerationId && this.generations.hasGeneration(record.resultGenerationId)) {
        const generation = this.generations.loadGeneration(record.resultGenerationId).descriptor
        if (!current || generation.counter >= current.generationCounter) {
          this.generations.selectExistingGeneration(record.resultGenerationId)
          result.repairedGeneration = record.resultGenerationId
        }
        this.appendTerminal(record, 'completed', { recoveredAfterManifestGap: true })
        continue
      }
      if (record.state === 'planned') {
        this.appendTerminal(record, 'cancelled', { recoveredBeforeExecution: true })
        result.cancelledOperations.push(record.operationId)
        continue
      }
      this.appendTerminal(record, 'recovery_required', {
        reason: 'Operation began without a reconciled result generation'
      })
      result.recoveryRequired.push(record.operationId)
    }
    return result
  }

  private appendTerminal(
    record: ThreadJournalRecord,
    state: 'completed' | 'cancelled' | 'recovery_required',
    details: unknown
  ): void {
    this.journal.append({
      operationId: record.operationId,
      operationType: record.operationType,
      state,
      resultGenerationId: record.resultGenerationId,
      details
    })
  }
}
