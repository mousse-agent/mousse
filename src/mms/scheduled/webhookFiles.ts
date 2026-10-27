import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ScheduledWebhookDelivery, ScheduledWebhookDeliveryOutcome } from '../../shared/types'
import { atomicWriteJsonSync } from '../data/AtomicFs'

/**
 * Files a job's webhook leaves under `<home>/scheduled/triggers/<jobId>/`: one payload file per accepted
 * delivery (`<occurrenceId>.json`, private to the owner) and the delivery log (`deliveries.json`).
 * Callers hold the jobs lock; every path is built from an id that passed `assertSafeSegment`.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/
const DELIVERY_LOG = 'deliveries.json'

/** Delivery rows kept per job: accepted deliveries and refused requests are separate buckets, so a flood of refusals never evicts the history of real runs. */
export const MAX_ACCEPTED_DELIVERY_ROWS = 50
export const MAX_REFUSED_DELIVERY_ROWS = 20

/** A payload file nothing references is removed after this long. */
export const TRIGGER_PAYLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function assertSafeSegment(value: string, what: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`Unsafe ${what}`)
  return value
}

function triggersRoot(homeDir: string): string {
  return join(homeDir, 'scheduled', 'triggers')
}

export function jobTriggerDir(homeDir: string, jobId: string): string {
  return join(triggersRoot(homeDir), assertSafeSegment(jobId, 'job id'))
}

function payloadPath(homeDir: string, jobId: string, occurrenceId: string): string {
  return join(jobTriggerDir(homeDir, jobId), `${assertSafeSegment(occurrenceId, 'occurrence id')}.json`)
}

/** What a delivery stored for its run. The body is untrusted data; nothing here reaches a prompt in this version. */
export interface StoredTriggerPayload {
  occurrenceId: string
  jobId: string
  receivedAt: string
  bodyBytes: number
  /** The request body decoded as UTF-8 (the signature was verified over the raw bytes before this). */
  body: string
}

export function writeTriggerPayload(homeDir: string, payload: StoredTriggerPayload): void {
  const directory = jobTriggerDir(homeDir, payload.jobId)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  atomicWriteJsonSync(payloadPath(homeDir, payload.jobId, payload.occurrenceId), payload, { mode: 0o600 })
}

export function readTriggerPayload(homeDir: string, jobId: string, occurrenceId: string): StoredTriggerPayload | undefined {
  try {
    const parsed = JSON.parse(readFileSync(payloadPath(homeDir, jobId, occurrenceId), 'utf-8')) as StoredTriggerPayload
    return typeof parsed?.body === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

export function removeTriggerPayload(homeDir: string, jobId: string, occurrenceId: string): void {
  try {
    unlinkSync(payloadPath(homeDir, jobId, occurrenceId))
  } catch {
    /* already gone */
  }
}

/** Deletes everything a job's webhook stored (its job was removed). */
export function removeJobTriggerFiles(homeDir: string, jobId: string): void {
  try {
    rmSync(jobTriggerDir(homeDir, jobId), { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Removes payload files older than `maxAgeMs` that no pending trigger, claim or pending occurrence names, and
 * the folders of jobs that no longer exist. Returns how many files were removed.
 */
export function sweepTriggerPayloads(
  homeDir: string,
  options: {
    jobIds: ReadonlySet<string>
    isReferenced: (jobId: string, occurrenceId: string) => boolean
    now?: number
    maxAgeMs?: number
  }
): number {
  const root = triggersRoot(homeDir)
  if (!existsSync(root)) return 0
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? TRIGGER_PAYLOAD_MAX_AGE_MS
  let removed = 0
  for (const jobId of readdirSync(root)) {
    if (!SAFE_SEGMENT.test(jobId)) continue
    if (!options.jobIds.has(jobId)) {
      removeJobTriggerFiles(homeDir, jobId)
      continue
    }
    const directory = join(root, jobId)
    let names: string[]
    try { names = readdirSync(directory) } catch { continue }
    for (const name of names) {
      if (name === DELIVERY_LOG || !name.endsWith('.json')) continue
      const occurrenceId = name.slice(0, -'.json'.length)
      if (!SAFE_SEGMENT.test(occurrenceId) || options.isReferenced(jobId, occurrenceId)) continue
      try {
        if (now - statSync(join(directory, name)).mtimeMs < maxAgeMs) continue
        unlinkSync(join(directory, name))
        removed += 1
      } catch {
        /* gone or busy: the next sweep retries */
      }
    }
  }
  return removed
}

// ── Delivery log ─────────────────────────────────────────────────────────

const REFUSED_OUTCOMES: ReadonlySet<ScheduledWebhookDeliveryOutcome> = new Set([
  'running',
  'pending',
  'paused',
  'replay',
  'rejected_signature',
  'rate_limited',
  'too_large'
])

interface DeliveryLog {
  accepted: ScheduledWebhookDelivery[]
  refused: ScheduledWebhookDelivery[]
}

function deliveryLogPath(homeDir: string, jobId: string): string {
  return join(jobTriggerDir(homeDir, jobId), DELIVERY_LOG)
}

function readLog(homeDir: string, jobId: string): DeliveryLog {
  try {
    const parsed = JSON.parse(readFileSync(deliveryLogPath(homeDir, jobId), 'utf-8')) as Partial<DeliveryLog>
    return {
      accepted: Array.isArray(parsed.accepted) ? parsed.accepted : [],
      refused: Array.isArray(parsed.refused) ? parsed.refused : []
    }
  } catch {
    return { accepted: [], refused: [] }
  }
}

function writeLog(homeDir: string, jobId: string, log: DeliveryLog): void {
  mkdirSync(jobTriggerDir(homeDir, jobId), { recursive: true, mode: 0o700 })
  atomicWriteJsonSync(
    deliveryLogPath(homeDir, jobId),
    {
      accepted: log.accepted.slice(-MAX_ACCEPTED_DELIVERY_ROWS),
      refused: log.refused.slice(-MAX_REFUSED_DELIVERY_ROWS)
    },
    { mode: 0o600 }
  )
}

/** The job's delivery log, newest first. */
export function readDeliveries(homeDir: string, jobId: string): ScheduledWebhookDelivery[] {
  const log = readLog(homeDir, jobId)
  return [...log.accepted, ...log.refused].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
}

export function appendDelivery(homeDir: string, jobId: string, row: ScheduledWebhookDelivery): void {
  const log = readLog(homeDir, jobId)
  if (REFUSED_OUTCOMES.has(row.outcome)) log.refused.push(row)
  else log.accepted.push(row)
  writeLog(homeDir, jobId, log)
}

/**
 * Moves an accepted delivery to its next outcome. A delivery whose row is missing (the daemon stopped
 * between accepting it and logging it) gets one now: the log never loses a run.
 */
export function updateDelivery(
  homeDir: string,
  jobId: string,
  occurrenceId: string,
  patch: Pick<ScheduledWebhookDelivery, 'outcome'> & Partial<Pick<ScheduledWebhookDelivery, 'error' | 'missingPlaceholders'>>,
  now = new Date().toISOString()
): void {
  const log = readLog(homeDir, jobId)
  const index = log.accepted.findIndex((row) => row.occurrenceId === occurrenceId)
  if (index >= 0) {
    const row: ScheduledWebhookDelivery = { ...log.accepted[index], ...patch }
    if (patch.error === undefined) delete row.error
    log.accepted[index] = row
  } else {
    log.accepted.push({ occurrenceId, receivedAt: now, bodyBytes: 0, ...patch })
  }
  writeLog(homeDir, jobId, log)
}
