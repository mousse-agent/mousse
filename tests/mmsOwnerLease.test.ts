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
  acquireMmsOwnerLease,
  getMmsOwnerPath,
  mayReclaimUnreadableOwner,
  MmsOwnerBusyError,
  OWNER_CORRUPT_STALE_MS,
  OWNER_PUBLICATION_GRACE_MS,
  releaseMmsOwnerLease,
  resolveOwnerStatus,
  tryAcquireMmsOwnerLease
} from '../src/mms/ownership/MmsOwnerLease'
import { PROCESS_INSTANCE_ID } from '../src/mms/queue/processLiveness'
import { MousseMainService } from '../src/mms/MousseMainService'
import { resolveDaemonHostInvocation } from '../src/cli/daemonHost'

describe('MmsOwnerLease', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-owner-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('acquires exclusive owner with fencing token and kind', () => {
    const handle = tryAcquireMmsOwnerLease(home, { kind: 'daemon', version: '1.0' })
    expect(handle).not.toBeNull()
    expect(handle!.owner.pid).toBe(process.pid)
    expect(handle!.owner.processInstanceId).toBe(PROCESS_INSTANCE_ID)
    expect(handle!.owner.token).toBeTruthy()
    expect(handle!.owner.kind).toBe('daemon')
    expect(handle!.owner.protocolVersion).toBe(1)
    handle!.release()
    expect(existsSync(getMmsOwnerPath(home))).toBe(false)
  })

  it('refuses concurrent live owner acquisition', () => {
    const a = acquireMmsOwnerLease(home, { kind: 'gui' })
    expect(tryAcquireMmsOwnerLease(home, { kind: 'daemon' })).toBeNull()
    expect(() => acquireMmsOwnerLease(home, { kind: 'cli' })).toThrow(MmsOwnerBusyError)
    a.release()
  })

  it('reclaims dead owner', () => {
    writeFileSync(
      getMmsOwnerPath(home),
      JSON.stringify({
        pid: 2_147_000_111,
        processInstanceId: 'dead',
        token: 'dead-tok',
        home,
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        kind: 'daemon',
        protocolVersion: 1
      }),
      'utf-8'
    )
    const handle = tryAcquireMmsOwnerLease(home, { kind: 'cli' })
    expect(handle).not.toBeNull()
    handle!.release()
  })

  it('recent corrupt owner is fail-closed', () => {
    const path = getMmsOwnerPath(home)
    writeFileSync(path, '{broken', 'utf-8')
    const now = Date.now()
    utimesSync(
      path,
      new Date(now - OWNER_PUBLICATION_GRACE_MS - 50),
      new Date(now - OWNER_PUBLICATION_GRACE_MS - 50)
    )
    expect(mayReclaimUnreadableOwner(path, now)).toBe(false)
    expect(tryAcquireMmsOwnerLease(home, { kind: 'test' })).toBeNull()
    expect(() => acquireMmsOwnerLease(home, { kind: 'test' })).toThrow(MmsOwnerBusyError)
  })

  it('old corrupt owner can be reclaimed', () => {
    const path = getMmsOwnerPath(home)
    writeFileSync(path, '%%%', 'utf-8')
    const old = Date.now() - OWNER_CORRUPT_STALE_MS - 5_000
    utimesSync(path, new Date(old), new Date(old))
    expect(mayReclaimUnreadableOwner(path)).toBe(true)
    const handle = tryAcquireMmsOwnerLease(home, { kind: 'test' })
    expect(handle).not.toBeNull()
    handle!.release()
  })

  it('exact-token heartbeat and release; release refuses wrong token', () => {
    const handle = acquireMmsOwnerLease(home, { kind: 'daemon' })
    expect(handle.heartbeat()).toBe(true)
    expect(releaseMmsOwnerLease(home, 'wrong')).toBe(false)
    expect(existsSync(getMmsOwnerPath(home))).toBe(true)
    expect(handle.release()).toBe(true)
    expect(handle.release()).toBe(true) // idempotent via handle flag
  })

  it('release does not unlink empty publication', () => {
    const handle = acquireMmsOwnerLease(home, { kind: 'cli' })
    const token = handle.owner.token
    handle.release()
    const path = getMmsOwnerPath(home)
    const fd = openSync(path, 'wx')
    closeSync(fd)
    expect(releaseMmsOwnerLease(home, token)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  it('MousseMainService create holds lease; stop releases once; failure cleans up', async () => {
    const mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'test',
      requireOwnership: true
    })
    expect(mms.getOwnerRecord()?.kind).toBe('test')
    expect(resolveOwnerStatus(home).owned).toBe(true)

    // Concurrent create fails
    await expect(
      MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'cli' })
    ).rejects.toThrow(MmsOwnerBusyError)

    await mms.stop()
    await mms.stop() // idempotent
    expect(resolveOwnerStatus(home).owned).toBe(false)
  })

  it('daemon host resolver picks system node outside Electron and reports the node-pty probe', () => {
    const loadable = resolveDaemonHostInvocation(undefined, { nodePtyOk: true })
    expect(loadable.mode).toBe('system-node')
    expect(loadable.nodePtyOk).toBe(true)
    const broken = resolveDaemonHostInvocation(undefined, { nodePtyOk: false })
    expect(broken.mode).toBe('system-node')
    expect(broken.nodePtyOk).toBe(false)
  })
})
