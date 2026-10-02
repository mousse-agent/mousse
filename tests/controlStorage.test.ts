import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { ControlStore } from '../src/mms/control/storage/controlStore'
import { IdempotencyStore, IdempotencyConflictError } from '../src/mms/control/storage/idempotencyStore'
import type { PairingGrant } from '../src/shared/controlTypes'

describe('Control Protocol 2.0 - Storage Layer', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'mousse-control-storage-test-'))
  })

  afterEach(() => {
    if (existsSync(tempHome)) {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  describe('ControlStore', () => {
    it('generates persistent device identity and reloads it cleanly', () => {
      const store1 = new ControlStore(tempHome)
      const identity1 = store1.getDeviceIdentity()

      expect(identity1.mmsDeviceId).toBeDefined()
      expect(identity1.mmsDeviceId.startsWith('mms-')).toBe(true)
      expect(identity1.installationId.startsWith('inst-')).toBe(true)

      const transportKeys = store1.getTransportKeyPair()
      const signingKeys = store1.getSigningKeyPair()
      expect(transportKeys.publicKey.length).toBe(32)
      expect(signingKeys.publicKey.length).toBe(32)

      // Instantiate a new store on the same directory
      const store2 = new ControlStore(tempHome)
      const identity2 = store2.getDeviceIdentity()

      expect(identity2.mmsDeviceId).toBe(identity1.mmsDeviceId)
      expect(identity2.transportPublicKey).toBe(identity1.transportPublicKey)
      expect(identity2.signingPublicKey).toBe(identity1.signingPublicKey)
    })

    it('encrypts Plus account credentials at rest and fails closed on tampering', () => {
      const store = new ControlStore(tempHome)

      expect(store.getCredentials()).toBeNull()

      const creds = {
        accountId: 'usr-12345',
        accountEmail: 'user@example.com',
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
        expiresAt: Date.now() + 3600_000,
        updatedAt: new Date().toISOString()
      }

      store.saveCredentials(creds)
      const loaded = store.getCredentials()

      expect(loaded).not.toBeNull()
      expect(loaded!.accountId).toBe(creds.accountId)
      expect(loaded!.accessToken).toBe(creds.accessToken)

      // Tamper with the encrypted file on disk
      const credFile = join(tempHome, 'control', 'credentials.enc')
      expect(existsSync(credFile)).toBe(true)
      const rawEnc = readFileSync(credFile)
      rawEnc[10] ^= 0xff // Flip a byte in ciphertext
      writeFileSync(credFile, rawEnc)

      // New store reading tampered disk file should fail closed (return null)
      const storeAfterTamper = new ControlStore(tempHome)
      expect(storeAfterTamper.getCredentials()).toBeNull()

      // Clear credentials
      store.clearCredentials()
      expect(existsSync(credFile)).toBe(false)
    })

    it('manages pairing grants atomically: save, list, get, revoke', () => {
      const store = new ControlStore(tempHome)

      const grant: PairingGrant = {
        pairingId: 'pair-abc-123',
        mobileDeviceId: 'dev-phone-456',
        mobileDeviceName: 'Pixel 8 Pro',
        mobileStaticPublicKey: randomBytes(32).toString('base64'),
        grantedScopes: ['mousse:read', 'mousse:chat'],
        createdAt: new Date().toISOString(),
        status: 'active',
        receiptSignature: randomBytes(64).toString('base64')
      }

      store.savePairing(grant)

      const list1 = store.listPairings()
      expect(list1.length).toBe(1)
      expect(list1[0].pairingId).toBe('pair-abc-123')
      expect(list1[0].mobileDeviceName).toBe('Pixel 8 Pro')

      const found = store.getPairing('pair-abc-123')
      expect(found).not.toBeNull()
      expect(found!.mobileDeviceId).toBe('dev-phone-456')

      // Revoke pairing
      const revoked = store.revokePairing('pair-abc-123')
      expect(revoked).not.toBeNull()
      expect(revoked!.status).toBe('revoked')

      const foundRevoked = store.getPairing('pair-abc-123')
      expect(foundRevoked!.status).toBe('revoked')
    })

    it('persists and updates control configuration', () => {
      const store = new ControlStore(tempHome)
      const cfg = store.getConfig()

      expect(cfg.mode).toBe('hosted')

      store.saveConfig({ mode: 'self-hosted', controlOrigin: 'https://custom.server.org' })
      const updated = store.getConfig()

      expect(updated.mode).toBe('self-hosted')
      expect(updated.controlOrigin).toBe('https://custom.server.org')
    })
  })

  describe('IdempotencyStore', () => {
    it('hashes nested params canonically', () => {
      const hash = (params: unknown) => IdempotencyStore.hashPayload('m', params)
      expect(hash({ partial: { x: 1 } })).not.toBe(hash({ partial: { y: 2 } }))
      expect(hash({ a: [{ x: 1 }] })).not.toBe(hash({ a: [{ x: 2 }] }))
      expect(hash({ a: 1, b: { c: 1, d: [1, { e: 2, f: 3 }] } })).toBe(hash({ b: { d: [1, { f: 3, e: 2 }], c: 1 }, a: 1 }))
      expect(hash({ a: [1, 2] })).not.toBe(hash({ a: [2, 1] }))
      expect(hash(undefined)).toBe(hash(null))
    })

    it('records and returns idempotent results for identical requests', () => {
      const store = new IdempotencyStore(24 * 3600_000)
      const pairingId = 'pair-test-1'
      const key = 'idem-key-1'
      const method = 'orchestrator.chat'
      const params = { threadId: 'thread-1', message: 'Hello!' }
      const hash = IdempotencyStore.hashPayload(method, params)

      // 1. Initial check: not seen
      const existing = store.get(pairingId, key, hash)
      expect(existing).toBeNull()

      // 2. Save result
      const resultObj = { turnId: 'turn-999', ok: true }
      store.save(pairingId, key, method, hash, resultObj)

      // 3. Check again: returns cached result
      const completed = store.get(pairingId, key, hash)
      expect(completed).toEqual(resultObj)
    })

    it('throws IdempotencyConflictError when identical key is reused with different params', () => {
      const store = new IdempotencyStore()
      const pairingId = 'pair-test-1'
      const key = 'idem-key-conflict'

      const hashA = IdempotencyStore.hashPayload('thread.create', { name: 'Thread A' })
      store.save(pairingId, key, 'thread.create', hashA, { done: true })

      const hashB = IdempotencyStore.hashPayload('thread.create', { name: 'Thread B (Different!)' })
      expect(() => {
        store.get(pairingId, key, hashB)
      }).toThrow(IdempotencyConflictError)
    })

    it('expires operations older than retention period', () => {
      // 10ms retention for test
      const store = new IdempotencyStore(10)
      const pairingId = 'pair-test-1'
      const key = 'idem-key-expire'
      const hash = IdempotencyStore.hashPayload('test.method', {})

      store.save(pairingId, key, 'test.method', hash, { done: true })

      // Wait 25ms
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const res = store.get(pairingId, key, hash)
          expect(res).toBeNull()
          resolve()
        }, 25)
      })
    })
  })
})
