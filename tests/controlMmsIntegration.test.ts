import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { MmsControlService } from '../src/mms/control/MmsControlService'
import { ControlStore } from '../src/mms/control/storage/controlStore'
import { MmsEventBus } from '../src/mms/events'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'
import { parsePairingQrUri } from '../src/mms/control/pairing/pairingQr'

describe('Control Protocol 2.0 - MMS Integration & Lifecycle', () => {
  let tempHome: string
  let store: ControlStore
  let eventBus: MmsEventBus
  let controlService: MmsControlService

  beforeEach(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'mousse-control-int-test-'))
    store = new ControlStore(tempHome)
    eventBus = new MmsEventBus()
    controlService = new MmsControlService({
      homeDir: tempHome,
      store,
      eventBus,
      executor: {
        execute: async () => ({ ok: true })
      }
    })
    await controlService.start()
  })

  afterEach(async () => {
    await controlService.stop()
    if (existsSync(tempHome)) {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it('reports initial control status with device identity and offline relay', async () => {
    const status = await controlService.getStatus()

    expect(status.mode).toBe('hosted')
    expect(status.enrolled).toBe(false)
    expect(status.mmsDeviceId).toBeDefined()
    expect(status.mmsDeviceId.startsWith('mms-')).toBe(true)
    expect(status.relayConnected).toBe(false)
    expect(status.activePairingsCount).toBe(0)
    expect(status.pairings).toEqual([])
  })

  it('switches control mode between hosted and self-hosted', async () => {
    await controlService.setMode('self-hosted')
    let status = await controlService.getStatus()
    expect(status.mode).toBe('self-hosted')

    await controlService.setMode('hosted')
    status = await controlService.getStatus()
    expect(status.mode).toBe('hosted')
  })

  it('creates QR v2 pairing attempt, enforces single-pending, and validates URI', async () => {
    const pairing1 = await controlService.createPairing({
      scopes: ['mousse:read', 'mousse:chat'],
      ttlMs: 60_000
    })

    expect(pairing1.pairingId).toBeDefined()
    expect(pairing1.qrUri.startsWith('mousse://pair?v=2&data=')).toBe(true)

    // Check status reflects pending pairing
    const status1 = await controlService.getStatus()
    expect(status1.pendingPairing).toBeDefined()
    expect(status1.pendingPairing?.pairingId).toBe(pairing1.pairingId)
    expect(status1.pendingPairing?.state).toBe('pending')

    // Creating a second pairing cancels the first (single pending rule)
    const pairing2 = await controlService.createPairing()
    expect(pairing2.pairingId).not.toBe(pairing1.pairingId)

    const status2 = await controlService.getStatus()
    expect(status2.pendingPairing?.pairingId).toBe(pairing2.pairingId)

    // Verify parsed payload matches requirements
    const parsed = parsePairingQrUri(pairing2.qrUri)
    expect(parsed.v).toBe(2)
    expect(parsed.pairingId).toBe(pairing2.pairingId)
    expect(parsed.pairingSecret).toBeDefined()
    expect(parsed.mmsDeviceId).toBe(status2.mmsDeviceId)
  })

  it('completes pairing approval lifecycle and immediate local revocation', async () => {
    const pairing = await controlService.createPairing({
      scopes: ['mousse:read', 'mousse:chat']
    })

    // Simulate mobile peer claiming the pending route
    const mobileStaticKey = randomBytes(32).toString('base64')
    const pairingMgr = controlService.getPairingManager()

    pairingMgr.recordClaim({
      mobileDeviceId: 'phone-alice-123',
      mobileDeviceName: 'iPhone 15 Pro',
      mobileStaticPublicKey: mobileStaticKey,
      fingerprint: 'A1B2-C3D4-E5F6-7890',
      requestedScopes: ['mousse:read', 'mousse:chat'],
      claimedAt: Date.now()
    })

    const statusClaimed = await controlService.getStatus()
    expect(statusClaimed.pendingPairing?.state).toBe('claimed')
    expect(statusClaimed.pendingPairing?.claimedBy?.mobileDeviceName).toBe('iPhone 15 Pro')

    // Approve the pairing
    const approveResult = await controlService.approvePairing(pairing.pairingId, ['mousse:read'])
    expect(approveResult.grant.pairingId).toBe(pairing.pairingId)
    expect(approveResult.grant.mobileDeviceId).toBe('phone-alice-123')
    expect(approveResult.grant.grantedScopes).toEqual(['mousse:read'])
    expect(approveResult.receipt).toBeDefined()
    expect(approveResult.receiptSignature).toBeDefined()

    // Status now has 1 active pairing
    const statusApproved = await controlService.getStatus()
    expect(statusApproved.activePairingsCount).toBe(1)
    expect(statusApproved.pairings.length).toBe(1)
    expect(statusApproved.pendingPairing).toBeUndefined()

    // Immediate local revocation
    const revokeResult = await controlService.revokePairing(pairing.pairingId)
    expect(revokeResult.ok).toBe(true)
    expect(revokeResult.revoked?.status).toBe('revoked')

    const statusRevoked = await controlService.getStatus()
    expect(statusRevoked.activePairingsCount).toBe(0)
  })

  it('rejects an unwanted pending pairing request cleanly', async () => {
    const pairing = await controlService.createPairing()

    const rejectResult = await controlService.rejectPairing(pairing.pairingId)
    expect(rejectResult.ok).toBe(true)

    const status = await controlService.getStatus()
    expect(status.pendingPairing).toBeUndefined()
  })

  it('verifies PROTOCOL_METHODS includes control and pairing methods without affecting offline IPC', () => {
    const methods = new Set(PROTOCOL_METHODS as readonly string[])

    // Control and pairing additions
    expect(methods.has('control.status')).toBe(true)
    expect(methods.has('control.login')).toBe(true)
    expect(methods.has('control.logout')).toBe(true)
    expect(methods.has('control.enroll')).toBe(true)
    expect(methods.has('control.disconnect')).toBe(true)
    expect(methods.has('control.setMode')).toBe(true)
    expect(methods.has('pairing.create')).toBe(true)
    expect(methods.has('pairing.list')).toBe(true)
    expect(methods.has('pairing.approve')).toBe(true)
    expect(methods.has('pairing.reject')).toBe(true)
    expect(methods.has('pairing.revoke')).toBe(true)

    // Existing core methods preserved
    expect(methods.has('health')).toBe(true)
    expect(methods.has('threads.list')).toBe(true)
    expect(methods.has('orchestrator.send')).toBe(true)
    expect(methods.has('pty.create')).toBe(true)
  })
})
