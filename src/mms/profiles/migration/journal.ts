import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { MigrationValidationError } from '../../../shared/profiles/errors'
import type { MigrationJournal, MigrationStepId } from './types'
import { MIGRATION_STEPS } from './types'

export function emptyJournal(now: string, dryRun: boolean): MigrationJournal {
  return {
    version: 1,
    dryRun,
    startedAt: now,
    updatedAt: now,
    currentStep: 'acquire-lease',
    completedSteps: [],
    inventory: [],
    unknownConfigKeys: [],
    retainedLegacyRoots: [],
    treeDigests: {}
  }
}

export function readJournal(path: string): MigrationJournal | null {
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MigrationJournal>
  if (parsed.version !== 1 || !Array.isArray(parsed.completedSteps)) {
    throw new MigrationValidationError('Migration journal is unreadable or the wrong version', { path })
  }
  return parsed as MigrationJournal
}

export function writeJournal(path: string, journal: MigrationJournal): void {
  atomicWriteJsonSync(path, journal, { mode: 0o600 })
}

export function markStep(journal: MigrationJournal, step: MigrationStepId, now: string): MigrationJournal {
  const completed = journal.completedSteps.includes(step)
    ? journal.completedSteps
    : [...journal.completedSteps, step]
  return {
    ...journal,
    currentStep: step,
    completedSteps: completed,
    updatedAt: now
  }
}

export function isStepComplete(journal: MigrationJournal, step: MigrationStepId): boolean {
  return journal.completedSteps.includes(step)
}

export function nextIncompleteStep(journal: MigrationJournal): MigrationStepId | null {
  return MIGRATION_STEPS.find((step) => !journal.completedSteps.includes(step)) ?? null
}
