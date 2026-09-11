import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { MigrationValidationError } from '../../../shared/profiles/errors'
import { isProfileId } from '../../../shared/profiles/ids'
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
  let parsed: Partial<MigrationJournal>
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MigrationJournal>
  } catch (error) {
    throw new MigrationValidationError('Migration journal is not valid JSON', {
      path,
      cause: error instanceof Error ? error.message : String(error)
    })
  }
  const knownSteps = new Set(MIGRATION_STEPS)
  const completed = parsed.completedSteps
  const completedIsPrefix = Array.isArray(completed) && completed.every(
    (step, index) => step === MIGRATION_STEPS[index]
  )
  const currentIndex = typeof parsed.currentStep === 'string'
    ? MIGRATION_STEPS.indexOf(parsed.currentStep as MigrationStepId)
    : -1
  const validCurrentPosition = Array.isArray(completed) && (
    (completed.length === 0 && currentIndex === 0) ||
    currentIndex === completed.length - 1 ||
    currentIndex === completed.length
  )
  if (
    parsed.version !== 1 ||
    !Array.isArray(completed) ||
    completed.some((step) => typeof step !== 'string' || !knownSteps.has(step as MigrationStepId)) ||
    new Set(completed).size !== completed.length ||
    !completedIsPrefix ||
    typeof parsed.currentStep !== 'string' ||
    !knownSteps.has(parsed.currentStep as MigrationStepId) ||
    !validCurrentPosition ||
    typeof parsed.dryRun !== 'boolean' ||
    typeof parsed.startedAt !== 'string' ||
    typeof parsed.updatedAt !== 'string' ||
    !Array.isArray(parsed.inventory) ||
    !Array.isArray(parsed.unknownConfigKeys) ||
    !Array.isArray(parsed.retainedLegacyRoots) ||
    !parsed.treeDigests ||
    typeof parsed.treeDigests !== 'object' ||
    Array.isArray(parsed.treeDigests) ||
    (parsed.defaultProfileId !== undefined && !isProfileId(parsed.defaultProfileId))
  ) {
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
