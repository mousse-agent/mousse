/**
 * Single authoritative MMS owner lease under canonical MOUSSE_HOME.
 * Exclusive create (O_EXCL / wx) is the ownership primitive.
 * Separate from readiness/runtime metadata (mms.runtime.json).
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync
} from 'fs'
import { dirname, join, resolve } from 'path'
import { randomBytes } from 'crypto'
import {
  getFileAgeMs,
  isOwnerLive,
  PROCESS_INSTANCE_ID
} from '../queue/processLiveness'

export const MMS_OWNER_FILENAME = 'mms.owner.json'
/** Placeholder protocol version for future RPC (Phase 2+). */
export const MMS_OWNER_PROTOCOL_VERSION = 1

/** Recent empty/corrupt owner files are held (publication race). */
export const OWNER_PUBLICATION_GRACE_MS = 2_000
/** Corrupt/unreadable owner may be reclaimed only after this age. */
export const OWNER_CORRUPT_STALE_MS = 30_000

export type MmsOwnerKind = 'daemon' | 'gui' | 'cli' | 'test'

export interface MmsOwnerRecord {
  pid: number
  processInstanceId: string
  token: string
  home: string
  acquiredAt: string
  heartbeatAt: string
  kind: MmsOwnerKind
  version?: string
  build?: string
  protocolVersion: number
  /** Future RPC endpoint placeholder. */
  endpoint?: string
}

export interface MmsOwnerHandle {
  home: string
  lockPath: string
  owner: MmsOwnerRecord
  release: () => boolean
  heartbeat: () => boolean
  /** Exact-token in-place endpoint publish after listen succeeds. */
  setEndpoint: (endpoint: string) => boolean
}

export class MmsOwnerBusyError extends Error {
  readonly owner: MmsOwnerRecord | null
  readonly heldUnreadable: boolean
  constructor(
    message: string,
    owner: MmsOwnerRecord | null = null,
    heldUnreadable = false
  ) {
    super(message)
    this.name = 'MmsOwnerBusyError'
    this.owner = owner
    this.heldUnreadable = heldUnreadable
  }
}

export function canonicalizeHome(homeDir: string): string {
  try {
    return resolve(homeDir)
  } catch {
    return homeDir
  }
}

export function getMmsOwnerPath(homeDir: string): string {
  return join(canonicalizeHome(homeDir), MMS_OWNER_FILENAME)
}

export function createOwnerToken(): string {
  return randomBytes(16).toString('hex')
}

export function mayReclaimUnreadableOwner(path: string, nowMs = Date.now()): boolean {
  const age = getFileAgeMs(path, nowMs)
  if (age == null) return false
  if (age < OWNER_PUBLICATION_GRACE_MS) return false
  return age >= OWNER_CORRUPT_STALE_MS
}

function parseOwnerRecord(raw: unknown): MmsOwnerRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<MmsOwnerRecord>
  if (
    typeof r.pid !== 'number' ||
    !Number.isInteger(r.pid) ||
    typeof r.processInstanceId !== 'string' ||
    typeof r.token !== 'string' ||
    !r.token ||
    typeof r.home !== 'string' ||
    typeof r.acquiredAt !== 'string' ||
    typeof r.heartbeatAt !== 'string' ||
    (r.kind !== 'daemon' &&
      r.kind !== 'gui' &&
      r.kind !== 'cli' &&
      r.kind !== 'test') ||
    typeof r.protocolVersion !== 'number'
  ) {
    return null
  }
  return {
    pid: r.pid,
    processInstanceId: r.processInstanceId,
    token: r.token,
    home: canonicalizeHome(r.home),
    acquiredAt: r.acquiredAt,
    heartbeatAt: r.heartbeatAt,
    kind: r.kind,
    version: typeof r.version === 'string' ? r.version : undefined,
    build: typeof r.build === 'string' ? r.build : undefined,
    protocolVersion: r.protocolVersion,
    endpoint: typeof r.endpoint === 'string' ? r.endpoint : undefined
  }
}

export type OwnerFileInspection =
  | { kind: 'missing' }
  | { kind: 'valid'; record: MmsOwnerRecord }
  | { kind: 'unreadable'; ageMs: number | null }

export function inspectOwnerFile(homeDir: string): OwnerFileInspection {
  const path = getMmsOwnerPath(homeDir)
  if (!existsSync(path)) return { kind: 'missing' }
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    if (!raw) return { kind: 'unreadable', ageMs: getFileAgeMs(path) }
    const record = parseOwnerRecord(JSON.parse(raw))
    if (!record) return { kind: 'unreadable', ageMs: getFileAgeMs(path) }
    return { kind: 'valid', record }
  } catch {
    return { kind: 'unreadable', ageMs: getFileAgeMs(path) }
  }
}

export function readOwnerRecord(homeDir: string): MmsOwnerRecord | null {
  const inspection = inspectOwnerFile(homeDir)
  return inspection.kind === 'valid' ? inspection.record : null
}

export function isOwnerRecordLive(record: MmsOwnerRecord): boolean {
  return isOwnerLive({
    pid: record.pid,
    processInstanceId: record.processInstanceId
  })
}

function tryReclaimStaleOwner(path: string): boolean {
  if (!existsSync(path)) return true
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    if (!raw) {
      if (!mayReclaimUnreadableOwner(path)) return false
      unlinkSync(path)
      return true
    }
    const record = parseOwnerRecord(JSON.parse(raw))
    if (!record) {
      if (!mayReclaimUnreadableOwner(path)) return false
      unlinkSync(path)
      return true
    }
    if (isOwnerRecordLive(record)) return false
    const still = parseOwnerRecord(JSON.parse(readFileSync(path, 'utf-8')))
    if (!still || still.token !== record.token) return false
    if (isOwnerRecordLive(still)) return false
    unlinkSync(path)
    return true
  } catch {
    if (mayReclaimUnreadableOwner(path)) {
      try {
        unlinkSync(path)
        return true
      } catch {
        return false
      }
    }
    return false
  }
}

/**
 * Acquire exclusive MMS owner lease for this process.
 * Must be called before writable MousseMainService initialization.
 */
export function tryAcquireMmsOwnerLease(
  homeDir: string,
  opts: {
    kind: MmsOwnerKind
    version?: string
    build?: string
    token?: string
    endpoint?: string
  }
): MmsOwnerHandle | null {
  const home = canonicalizeHome(homeDir)
  const lockPath = getMmsOwnerPath(home)
  mkdirSync(dirname(lockPath), { recursive: true })

  const now = new Date().toISOString()
  const owner: MmsOwnerRecord = {
    pid: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    token: opts.token ?? createOwnerToken(),
    home,
    acquiredAt: now,
    heartbeatAt: now,
    kind: opts.kind,
    version: opts.version,
    build: opts.build,
    protocolVersion: MMS_OWNER_PROTOCOL_VERSION,
    endpoint: opts.endpoint
  }

  const attempt = (): MmsOwnerHandle | null => {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, JSON.stringify(owner, null, 2))
      } catch (err) {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(lockPath)
        } catch {
          /* ignore */
        }
        throw err
      }
      closeSync(fd)
      // Owner fencing token file — restrict permissions where supported.
      try {
        chmodSync(lockPath, 0o600)
      } catch {
        /* Windows / unsupported */
      }
      return makeHandle(home, lockPath, owner)
    } catch {
      return null
    }
  }

  let handle = attempt()
  if (handle) return handle

  // One stale reclaim retry only (no busy-spin).
  if (tryReclaimStaleOwner(lockPath)) {
    handle = attempt()
    if (handle) return handle
  }
  return null
}

export function acquireMmsOwnerLease(
  homeDir: string,
  opts: {
    kind: MmsOwnerKind
    version?: string
    build?: string
    token?: string
    endpoint?: string
  }
): MmsOwnerHandle {
  const handle = tryAcquireMmsOwnerLease(homeDir, opts)
  if (handle) return handle

  const inspection = inspectOwnerFile(homeDir)
  if (inspection.kind === 'unreadable' && !mayReclaimUnreadableOwner(getMmsOwnerPath(homeDir))) {
    throw new MmsOwnerBusyError(
      'MMS owner file is unreadable/partial (publication grace); refusing acquisition',
      null,
      true
    )
  }
  const live = inspection.kind === 'valid' ? inspection.record : null
  const kind = live?.kind ?? 'unknown'
  throw new MmsOwnerBusyError(
    live
      ? `MMS home already owned by live ${kind} process (pid ${live.pid})`
      : 'MMS home owner lease is busy',
    live,
    inspection.kind === 'unreadable'
  )
}

function makeHandle(home: string, lockPath: string, owner: MmsOwnerRecord): MmsOwnerHandle {
  let released = false
  const state = { owner }
  return {
    home,
    lockPath,
    get owner() {
      return state.owner
    },
    release: () => {
      if (released) return true
      const ok = releaseMmsOwnerLease(home, state.owner.token)
      if (ok) released = true
      return ok
    },
    heartbeat: () => {
      if (released) return false
      const next: MmsOwnerRecord = {
        ...state.owner,
        heartbeatAt: new Date().toISOString()
      }
      const ok = writeOwnerInPlace(lockPath, state.owner.token, next)
      if (ok) state.owner = next
      return ok
    },
    setEndpoint: (endpoint: string) => {
      if (released) return false
      const next: MmsOwnerRecord = {
        ...state.owner,
        endpoint,
        heartbeatAt: new Date().toISOString()
      }
      const ok = writeOwnerInPlace(lockPath, state.owner.token, next)
      if (ok) state.owner = next
      return ok
    }
  }
}

/** In-place inode write — never rename-over a replacement owner. */
function writeOwnerInPlace(
  lockPath: string,
  expectedToken: string,
  owner: MmsOwnerRecord
): boolean {
  let fd: number | null = null
  try {
    fd = openSync(lockPath, 'r+')
    const buf = Buffer.alloc(64 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const raw = buf.subarray(0, n).toString('utf-8').trim()
    if (!raw) return false
    let parsed: Partial<MmsOwnerRecord>
    try {
      parsed = JSON.parse(raw) as Partial<MmsOwnerRecord>
    } catch {
      return false
    }
    if (typeof parsed.token !== 'string' || parsed.token !== expectedToken) {
      return false
    }
    const payload = Buffer.from(JSON.stringify(owner, null, 2), 'utf-8')
    ftruncateSync(fd, 0)
    writeSync(fd, payload, 0, payload.length, 0)
    fsyncSync(fd)
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Ownership-checked release. Exact token match required.
 * Missing/unreadable: do nothing (never unlink new partial publication).
 */
export function releaseMmsOwnerLease(homeDir: string, token: string): boolean {
  const lockPath = getMmsOwnerPath(homeDir)
  const inspection = inspectOwnerFile(homeDir)
  if (inspection.kind !== 'valid') return false
  if (inspection.record.token !== token) return false
  try {
    const still = readOwnerRecord(homeDir)
    if (!still || still.token !== token) return false
    unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

/**
 * Discovery status for GUI/CLI without constructing MMS.
 */
export function resolveOwnerStatus(homeDir: string): {
  owned: boolean
  record: MmsOwnerRecord | null
  heldUnreadable: boolean
  staleRemoved: boolean
} {
  const home = canonicalizeHome(homeDir)
  const path = getMmsOwnerPath(home)
  const inspection = inspectOwnerFile(home)

  if (inspection.kind === 'missing') {
    return { owned: false, record: null, heldUnreadable: false, staleRemoved: false }
  }

  if (inspection.kind === 'unreadable') {
    if (mayReclaimUnreadableOwner(path)) {
      try {
        unlinkSync(path)
        return { owned: false, record: null, heldUnreadable: false, staleRemoved: true }
      } catch {
        return { owned: true, record: null, heldUnreadable: true, staleRemoved: false }
      }
    }
    return { owned: true, record: null, heldUnreadable: true, staleRemoved: false }
  }

  if (isOwnerRecordLive(inspection.record)) {
    return {
      owned: true,
      record: inspection.record,
      heldUnreadable: false,
      staleRemoved: false
    }
  }

  try {
    unlinkSync(path)
  } catch {
    /* ignore */
  }
  return { owned: false, record: null, heldUnreadable: false, staleRemoved: true }
}

/** Format a clear conflict message for CLI/GUI. */
export function formatOwnerBusyMessage(owner: MmsOwnerRecord | null, heldUnreadable = false): string {
  if (heldUnreadable) {
    return 'MMS home owner lease is unreadable/partial (another process may be starting).'
  }
  if (!owner) {
    return 'MMS home is already owned by another live process.'
  }
  return (
    `MMS home is already owned by a live ${owner.kind} process ` +
    `(pid ${owner.pid}, protocol v${owner.protocolVersion}` +
    (owner.version ? `, version ${owner.version}` : '') +
    '). Stop that instance before starting another writable MMS.'
  )
}
