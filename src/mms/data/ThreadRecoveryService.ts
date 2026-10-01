import { ThreadGenerationStore } from './ThreadGenerationStore'
import { ThreadJournal, type ThreadJournalRecord } from './ThreadJournal'

export interface ThreadRecoveryResult {
  repairedGeneration?: string
  cancelledOperations: string[]
  recoveryRequired: string[]
}

// recovery_required is terminal for automatic reconciliation. It represents a
// durable request for an operator decision, not work that should be appended on
// every startup.
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'recovery_required'])

function intentSequence(record: ThreadJournalRecord): number {
  const details = record.details
  if (details && typeof details === 'object' && 'intentSequence' in details) {
    const value = (details as { intentSequence?: unknown }).intentSequence
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  }
  return record.sequence
}

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
    let current = this.generations.getManifest()
    for (const record of this.journal.latestByOperation().values()) {
      if (TERMINAL.has(record.state)) continue
      // Git/context operation services own these phases; never overwrite their recovery payload.
      if (['prepared', 'git_applied', 'context_pending'].includes(record.state)) {
        result.recoveryRequired.push(record.operationId)
        continue
      }
      const recoveredGenerationId =
        record.resultGenerationId && this.generations.hasGeneration(record.resultGenerationId)
          ? record.resultGenerationId
          : this.generations.findGenerationByJournalSequence(intentSequence(record))
      if (recoveredGenerationId) {
        const generation = this.generations.loadGeneration(recoveredGenerationId).descriptor
        if (!current || generation.counter > current.generationCounter) {
          current = this.generations.selectExistingGeneration(recoveredGenerationId)
          result.repairedGeneration = recoveredGenerationId
        } else if (
          generation.counter === current.generationCounter &&
          current.currentGenerationId !== recoveredGenerationId
        ) {
          this.appendTerminal(record, 'recovery_required', {
            reason: 'Competing generation has the current counter',
            generationId: recoveredGenerationId
          })
          result.recoveryRequired.push(record.operationId)
          continue
        }
        this.appendTerminal(record, 'completed', {
          recoveredAfterManifestGap: current.currentGenerationId === recoveredGenerationId,
          generationId: recoveredGenerationId
        })
        continue
      }
      if (current?.journalSequence === intentSequence(record)) {
        this.appendTerminal(record, 'completed', {
          recoveredAfterCompletionRecordGap: true,
          generationId: current.currentGenerationId
        })
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
