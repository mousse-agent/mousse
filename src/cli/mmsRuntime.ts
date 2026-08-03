/**
 * Structured MMS daemon runtime ownership record.
 * Written by the long-lived `service run` process after readiness — never by the launcher.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'fs'
import { dirname, join, resolve } from 'path'
import { randomBytes } from 'crypto'
import {
  getFileAgeMs,
  isOwnerLive,
  isProcessAlive,
  PROCESS_INSTANCE_ID
} from '../mms/queue/processLiveness'
import {
  isOwnerRecordLive,
  readOwnerRecord,
  resolveOwnerStatus
} from '../mms/ownership/MmsOwnerLease'

export const MMS_RUNTIME_FILENAME = 'mms.runtime.json'
export const MMS_STOP_REQUEST_FILENAME = 'mms.stop.request.json'
/** Legacy plain-pid file; still cleared when migrating. */
export const MMS_PID_FILENAME = 'mms.pid'

/** Recent empty/corrupt runtime files are held (publication race). */
export const RUNTIME_PUBLICATION_GRACE_MS = 2_000
/** Corrupt/unreadable runtime may be reclaimed only after this age. */
export const RUNTIME_CORRUPT_STALE_MS = 30_000

export const SERVICE_START_TIMEOUT_MS = 30_000
export const SERVICE_STOP_TIMEOUT_MS = 30_000
export const SERVICE_POLL_INTERVAL_MS = 100

export interface MmsRuntimeRecord {
  pid: number
  processInstanceId: string
  /**
   * Must match the authoritative MMS owner lease fencing token.
   * Runtime readiness never invents independent ownership.
   */
  token: string
  /** @deprecated Alias for token; kept for clarity in status output. */
  ownerToken?: string
  home: string
  startedAt: string
  readyAt: string
  version?: string
  protocolVersion?: number
  ownerKind?: string
}

export interface MmsStopRequest {
  token: string
  requestedAt: string
  requesterPid?: number
}

export type RuntimeFileInspection =
  | { kind: 'missing' }
  | { kind: 'valid'; record: MmsRuntimeRecord }
  | { kind: 'unreadable'; ageMs: number | null }

export class RuntimeOwnershipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeOwnershipError'
  }
}

/** Canonical absolute home path for ownership comparisons. */
export function canonicalizeHome(homeDir: string): string {
  try {
    return resolve(homeDir)
  } catch {
    return homeDir
  }
}

export function getMmsRuntimePath(homeDir: string): string {
  return join(canonicalizeHome(homeDir), MMS_RUNTIME_FILENAME)
}

export function getMmsStopRequestPath(homeDir: string): string {
  return join(canonicalizeHome(homeDir), MMS_STOP_REQUEST_FILENAME)
}

export function getMmsPidPath(homeDir: string): string {
  return join(canonicalizeHome(homeDir), MMS_PID_FILENAME)
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(temporary, filePath)
  // Runtime secret/token file — restrict permissions where supported.
  try {
    chmodSync(filePath, 0o600)
  } catch {
    /* Windows / unsupported */
  }
}

export function createRuntimeToken(): string {
  return randomBytes(16).toString('hex')
}

export function mayReclaimUnreadableRuntime(path: string, nowMs = Date.now()): boolean {
  const age = getFileAgeMs(path, nowMs)
  if (age == null) return false
  if (age < RUNTIME_PUBLICATION_GRACE_MS) return false
  return age >= RUNTIME_CORRUPT_STALE_MS
}

function parseRuntimeRecord(raw: unknown): MmsRuntimeRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<MmsRuntimeRecord>
  if (
    typeof r.pid !== 'number' ||
    !Number.isInteger(r.pid) ||
    typeof r.processInstanceId !== 'string' ||
    typeof r.token !== 'string' ||
    !r.token ||
    typeof r.home !== 'string' ||
    typeof r.startedAt !== 'string' ||
    typeof r.readyAt !== 'string'
  ) {
    return null
  }
  return {
    pid: r.pid,
    processInstanceId: r.processInstanceId,
    token: r.token,
    home: canonicalizeHome(r.home),
    startedAt: r.startedAt,
    readyAt: r.readyAt,
    version: typeof r.version === 'string' ? r.version : undefined
  }
}

export function inspectRuntimeFile(homeDir: string): RuntimeFileInspection {
  const path = getMmsRuntimePath(homeDir)
  if (!existsSync(path)) return { kind: 'missing' }
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    if (!raw) {
      return { kind: 'unreadable', ageMs: getFileAgeMs(path) }
    }
    const record = parseRuntimeRecord(JSON.parse(raw))
    if (!record) {
      return { kind: 'unreadable', ageMs: getFileAgeMs(path) }
    }
    return { kind: 'valid', record }
  } catch {
    return { kind: 'unreadable', ageMs: getFileAgeMs(path) }
  }
}

export function readRuntimeRecord(homeDir: string): MmsRuntimeRecord | null {
  const inspection = inspectRuntimeFile(homeDir)
  return inspection.kind === 'valid' ? inspection.record : null
}

/**
 * True when the runtime record refers to a live process.
 * Foreign live pids fail closed as live; same-pid different instance is not live.
 */
export function isRuntimeRecordLive(record: MmsRuntimeRecord): boolean {
  return isOwnerLive({
    pid: record.pid,
    processInstanceId: record.processInstanceId
  })
}

/**
 * Publish daemon readiness metadata. Requires a live matching owner lease token —
 * never invents independent ownership. Runtime is secondary to mms.owner.json.
 */
export function publishOwnRuntimeRecord(
  homeDir: string,
  opts: {
    /** Must equal the authoritative MMS owner fencing token. */
    ownerToken: string
    version?: string
    startedAt?: string
    protocolVersion?: number
    ownerKind?: string
  }
): MmsRuntimeRecord {
  const home = canonicalizeHome(homeDir)
  const path = getMmsRuntimePath(home)
  mkdirSync(dirname(path), { recursive: true })

  const owner = readOwnerRecord(home)
  if (!owner || !isOwnerRecordLive(owner)) {
    throw new RuntimeOwnershipError(
      'Cannot publish readiness without a live matching MMS owner lease'
    )
  }
  if (owner.token !== opts.ownerToken) {
    throw new RuntimeOwnershipError(
      'Runtime readiness token does not match the live MMS owner lease'
    )
  }
  if (owner.pid !== process.pid || owner.processInstanceId !== PROCESS_INSTANCE_ID) {
    throw new RuntimeOwnershipError(
      'Cannot publish readiness for an owner lease held by another process'
    )
  }

  const now = new Date().toISOString()
  const record: MmsRuntimeRecord = {
    pid: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    token: opts.ownerToken,
    ownerToken: opts.ownerToken,
    home,
    startedAt: opts.startedAt ?? owner.acquiredAt,
    readyAt: now,
    version: opts.version ?? owner.version,
    protocolVersion: opts.protocolVersion ?? owner.protocolVersion,
    ownerKind: opts.ownerKind ?? owner.kind
  }

  // Readiness is not the ownership primitive — atomic overwrite of our own readiness is OK
  // when owner token matches (same process re-publish).
  const inspection = inspectRuntimeFile(home)
  if (inspection.kind === 'valid' && isRuntimeRecordLive(inspection.record)) {
    if (inspection.record.token !== opts.ownerToken) {
      throw new RuntimeOwnershipError(
        `MMS runtime already published under a different owner token`
      )
    }
  } else if (inspection.kind === 'unreadable' && !mayReclaimUnreadableRuntime(path)) {
    throw new RuntimeOwnershipError(
      'MMS runtime file is unreadable/partial and still within publication grace'
    )
  }

  writeJsonAtomic(path, record)
  clearLegacyPid(home)
  return record
}

/** @deprecated Use publishOwnRuntimeRecord with ownerToken */
export function writeOwnRuntimeRecord(
  homeDir: string,
  opts: { ownerToken: string; version?: string; startedAt?: string }
): MmsRuntimeRecord {
  return publishOwnRuntimeRecord(homeDir, opts)
}

function clearLegacyPid(homeDir: string): void {
  try {
    if (existsSync(getMmsPidPath(homeDir))) unlinkSync(getMmsPidPath(homeDir))
  } catch {
    /* ignore */
  }
}

/**
 * Remove runtime record only if it still belongs to the given owner token.
 * Never deletes a different live instance's record.
 */
export function removeOwnRuntimeRecord(homeDir: string, token: string): boolean {
  const home = canonicalizeHome(homeDir)
  const inspection = inspectRuntimeFile(home)
  if (inspection.kind === 'missing') {
    clearLegacyPid(home)
    return true
  }
  if (inspection.kind === 'unreadable') {
    // Do not delete unreadable without ownership proof.
    return false
  }
  if (inspection.record.token !== token) return false
  try {
    unlinkSync(getMmsRuntimePath(home))
  } catch {
    return false
  }
  clearLegacyPid(home)
  return true
}

/**
 * Readiness status. Stale runtime metadata that does not match the live owner lease
 * is ignored/removed without touching the owner lease.
 * Authoritative ownership is mms.owner.json (see resolveOwnerStatus).
 */
export function resolveRuntimeStatus(homeDir: string): {
  running: boolean
  record: MmsRuntimeRecord | null
  staleRemoved: boolean
  heldUnreadable?: boolean
  owner?: ReturnType<typeof resolveOwnerStatus>
} {
  const home = canonicalizeHome(homeDir)
  const owner = resolveOwnerStatus(home)
  const inspection = inspectRuntimeFile(home)

  if (inspection.kind === 'missing') {
    clearLegacyPid(home)
    return {
      running: owner.owned,
      record: null,
      staleRemoved: false,
      owner
    }
  }

  if (inspection.kind === 'unreadable') {
    if (mayReclaimUnreadableRuntime(getMmsRuntimePath(home))) {
      try {
        unlinkSync(getMmsRuntimePath(home))
        clearLegacyPid(home)
        return { running: owner.owned, record: null, staleRemoved: true, owner }
      } catch {
        return {
          running: owner.owned,
          record: null,
          staleRemoved: false,
          heldUnreadable: true,
          owner
        }
      }
    }
    return {
      running: owner.owned,
      record: null,
      staleRemoved: false,
      heldUnreadable: true,
      owner
    }
  }

  const record = inspection.record
  // Runtime must match live owner token; otherwise strip readiness without touching owner.
  if (!owner.record || !owner.owned || record.token !== owner.record.token) {
    try {
      unlinkSync(getMmsRuntimePath(home))
    } catch {
      /* ignore */
    }
    clearLegacyPid(home)
    return {
      running: owner.owned,
      record: null,
      staleRemoved: true,
      owner
    }
  }

  if (!isRuntimeRecordLive(record)) {
    try {
      unlinkSync(getMmsRuntimePath(home))
    } catch {
      /* ignore */
    }
    clearLegacyPid(home)
    return { running: owner.owned, record: null, staleRemoved: true, owner }
  }

  return { running: true, record, staleRemoved: false, owner }
}

export function writeStopRequest(homeDir: string, token: string): MmsStopRequest {
  const request: MmsStopRequest = {
    token,
    requestedAt: new Date().toISOString(),
    requesterPid: process.pid
  }
  writeJsonAtomic(getMmsStopRequestPath(homeDir), request)
  return request
}

export function readStopRequest(homeDir: string): MmsStopRequest | null {
  const path = getMmsStopRequestPath(homeDir)
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<MmsStopRequest>
    if (typeof raw.token !== 'string' || !raw.token) return null
    return {
      token: raw.token,
      requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : new Date().toISOString(),
      requesterPid: typeof raw.requesterPid === 'number' ? raw.requesterPid : undefined
    }
  } catch {
    return null
  }
}

export function clearStopRequest(homeDir: string): void {
  try {
    const path = getMmsStopRequestPath(homeDir)
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* ignore */
  }
}

export function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Pure poll helper for readiness (testable without spawning the app).
 * Returns the first live runtime record or null on timeout.
 */
export async function pollUntilRuntimeReady(
  homeDir: string,
  opts?: {
    timeoutMs?: number
    intervalMs?: number
    isAborted?: () => boolean
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  }
): Promise<MmsRuntimeRecord | null> {
  const timeoutMs = opts?.timeoutMs ?? SERVICE_START_TIMEOUT_MS
  const intervalMs = opts?.intervalMs ?? SERVICE_POLL_INTERVAL_MS
  const now = opts?.now ?? Date.now
  const sleep = opts?.sleep ?? sleepAsync
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (opts?.isAborted?.()) return null
    const status = resolveRuntimeStatus(homeDir)
    if (status.running && status.record) return status.record
    await sleep(intervalMs)
  }
  return null
}

/**
 * Pure poll helper for stop confirmation.
 * - stopped: original owner gone and no live replacement (or replacement noted separately)
 */
export async function pollUntilRuntimeStopped(
  homeDir: string,
  expectedToken: string,
  opts?: {
    timeoutMs?: number
    intervalMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  }
): Promise<
  | { kind: 'stopped' }
  | { kind: 'replaced'; record: MmsRuntimeRecord }
  | { kind: 'timeout'; record: MmsRuntimeRecord | null }
> {
  const timeoutMs = opts?.timeoutMs ?? SERVICE_STOP_TIMEOUT_MS
  const intervalMs = opts?.intervalMs ?? SERVICE_POLL_INTERVAL_MS
  const now = opts?.now ?? Date.now
  const sleep = opts?.sleep ?? sleepAsync
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    const status = resolveRuntimeStatus(homeDir)
    if (!status.running) return { kind: 'stopped' }
    if (status.record && status.record.token !== expectedToken) {
      return { kind: 'replaced', record: status.record }
    }
    await sleep(intervalMs)
  }
  const final = resolveRuntimeStatus(homeDir)
  return { kind: 'timeout', record: final.record }
}
