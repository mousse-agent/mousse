import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalizeHome,
  getMmsRuntimePath,
  inspectRuntimeFile,
  mayReclaimUnreadableRuntime,
  pollUntilRuntimeReady,
  pollUntilRuntimeStopped,
  publishOwnRuntimeRecord,
  readRuntimeRecord,
  readStopRequest,
  removeOwnRuntimeRecord,
  resolveRuntimeStatus,
  RUNTIME_CORRUPT_STALE_MS,
  RUNTIME_PUBLICATION_GRACE_MS,
  RuntimeOwnershipError,
  writeStopRequest
} from '../src/cli/mmsRuntime'
import {
  acquireMmsOwnerLease,
  resolveOwnerStatus,
  type MmsOwnerHandle
} from '../src/mms/ownership/MmsOwnerLease'
import { PROCESS_INSTANCE_ID } from '../src/mms/queue/processLiveness'

describe('mmsRuntime readiness (secondary to owner lease)', () => {
  let home: string
  let lease: MmsOwnerHandle

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-runtime-'))
    lease = acquireMmsOwnerLease(home, { kind: 'daemon', version: '0.1.0-test' })
  })

  afterEach(() => {
    lease.release()
    rmSync(home, { recursive: true, force: true })
  })

  it('publishes readiness bound to owner fencing token', () => {
    const record = publishOwnRuntimeRecord(home, {
      ownerToken: lease.owner.token,
      version: '0.1.0-test'
    })
    expect(record.pid).toBe(process.pid)
    expect(record.processInstanceId).toBe(PROCESS_INSTANCE_ID)
    expect(record.token).toBe(lease.owner.token)
    expect(record.home).toBe(canonicalizeHome(home))
    expect(readRuntimeRecord(home)?.pid).toBe(process.pid)
  })

  it('refuses publish without live owner or with wrong token', () => {
    expect(() =>
      publishOwnRuntimeRecord(home, { ownerToken: 'not-the-owner-token' })
    ).toThrow(RuntimeOwnershipError)

    lease.release()
    expect(() =>
      publishOwnRuntimeRecord(home, { ownerToken: 'any' })
    ).toThrow(RuntimeOwnershipError)
    // re-acquire for afterEach
    lease = acquireMmsOwnerLease(home, { kind: 'daemon' })
  })

  it('recent corrupt runtime is fail-closed for publish', () => {
    const path = getMmsRuntimePath(home)
    writeFileSync(path, '{not-json', 'utf-8')
    const now = Date.now()
    utimesSync(
      path,
      new Date(now - RUNTIME_PUBLICATION_GRACE_MS - 50),
      new Date(now - RUNTIME_PUBLICATION_GRACE_MS - 50)
    )
    expect(mayReclaimUnreadableRuntime(path, now)).toBe(false)
    expect(() =>
      publishOwnRuntimeRecord(home, { ownerToken: lease.owner.token })
    ).toThrow(RuntimeOwnershipError)
  })

  it('old corrupt runtime may be reclaimed for publish', () => {
    const path = getMmsRuntimePath(home)
    writeFileSync(path, '%%%', 'utf-8')
    const old = Date.now() - RUNTIME_CORRUPT_STALE_MS - 5_000
    utimesSync(path, new Date(old), new Date(old))
    expect(mayReclaimUnreadableRuntime(path)).toBe(true)
    const record = publishOwnRuntimeRecord(home, {
      ownerToken: lease.owner.token
    })
    expect(record.token).toBe(lease.owner.token)
  })

  it('owner-token stop request is readable and clearable', () => {
    const rec = publishOwnRuntimeRecord(home, { ownerToken: lease.owner.token })
    writeStopRequest(home, rec.token)
    expect(readStopRequest(home)?.token).toBe(lease.owner.token)
    expect(removeOwnRuntimeRecord(home, rec.token)).toBe(true)
    expect(readRuntimeRecord(home)).toBeNull()
  })

  it('removeOwnRuntimeRecord never deletes a different token', () => {
    publishOwnRuntimeRecord(home, { ownerToken: lease.owner.token })
    expect(removeOwnRuntimeRecord(home, 'other')).toBe(false)
    expect(readRuntimeRecord(home)?.token).toBe(lease.owner.token)
  })

  it('pollUntilRuntimeReady resolves when readiness appears', async () => {
    let published = false
    const sleep = async () => {
      if (!published) {
        publishOwnRuntimeRecord(home, { ownerToken: lease.owner.token })
        published = true
      }
    }
    const record = await pollUntilRuntimeReady(home, {
      timeoutMs: 1000,
      intervalMs: 10,
      sleep
    })
    expect(record?.token).toBe(lease.owner.token)
  })

  it('pollUntilRuntimeStopped reports a replacement owner with a different token', async () => {
    const originalToken = lease.owner.token
    publishOwnRuntimeRecord(home, { ownerToken: originalToken })
    let clock = 0
    let n = 0
    const result = await pollUntilRuntimeStopped(home, originalToken, {
      timeoutMs: 500,
      intervalMs: 10,
      now: () => clock,
      sleep: async () => {
        clock += 10
        n += 1
        if (n === 1) {
          removeOwnRuntimeRecord(home, originalToken)
          lease.release()
          lease = acquireMmsOwnerLease(home, { kind: 'daemon' })
          publishOwnRuntimeRecord(home, { ownerToken: lease.owner.token })
        }
      }
    })
    expect(result.kind).toBe('replaced')
    if (result.kind === 'replaced') {
      expect(result.record.token).toBe(lease.owner.token)
      expect(result.record.token).not.toBe(originalToken)
    }
  })

  it('resolveRuntimeStatus strips a runtime with a foreign token and keeps the owner', () => {
    const runtime = publishOwnRuntimeRecord(home, { ownerToken: lease.owner.token })
    expect(resolveRuntimeStatus(home).running).toBe(true)
    expect(resolveRuntimeStatus(home).record?.token).toBe(lease.owner.token)

    writeFileSync(
      getMmsRuntimePath(home),
      JSON.stringify({ ...runtime, token: 'other-token' }),
      'utf-8'
    )
    expect(resolveRuntimeStatus(home).record).toBeNull()
    const owner = resolveOwnerStatus(home)
    expect(owner.owned).toBe(true)
    expect(owner.record?.token).toBe(lease.owner.token)
  })
})
