/**
 * Persistent control storage for MMS:
 * - Device identity keys (X25519 transport + Ed25519 signing)
 * - Encrypted Plus credentials (AES-256-GCM at rest, fail-closed)
 * - Atomic pairing grants store
 * - Control configuration (mode, origin, dashboard URL)
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { hostname, userInfo } from 'node:os'
import type { ControlMode, PairingGrant, RemoteScope } from '../../../shared/controlTypes'
import {
  generateDeviceKeyBundle,
  generateEd25519KeyPair,
  type DeviceKeyBundle,
  type RawKeyPair
} from '../crypto/keys'
import {
  DEFAULT_HOSTED_CONTROL_ORIGIN,
  DEFAULT_HOSTED_DASHBOARD_URL
} from '../constants'

export interface PersistentDeviceIdentity {
  mmsDeviceId: string
  installationId: string
  installationPublicKey: string // base64
  installationPrivateKey: string // base64
  transportPublicKey: string // base64
  transportPrivateKey: string // base64
  signingPublicKey: string // base64
  signingPrivateKey: string // base64
}

export interface PlusAccountCredentials {
  accountId: string
  accountEmail?: string
  accountName?: string
  accessToken?: string
  refreshToken?: string
  deviceEnrollmentToken?: string
  expiresAt?: number
  updatedAt: string
}

export interface ControlConfig {
  mode: ControlMode
  controlOrigin: string
  dashboardUrl: string
  autoconnect: boolean
}

export class ControlStore {
  private readonly controlDir: string
  private readonly identityPath: string
  private readonly credentialsPath: string
  private readonly pairingsPath: string
  private readonly configPath: string

  private cachedIdentity: PersistentDeviceIdentity | null = null
  private cachedCredentials: PlusAccountCredentials | null = null
  private cachedPairings: PairingGrant[] | null = null
  private cachedConfig: ControlConfig | null = null

  constructor(homeDir: string) {
    this.controlDir = join(homeDir, 'control')
    this.identityPath = join(this.controlDir, 'identity.json')
    this.credentialsPath = join(this.controlDir, 'credentials.enc')
    this.pairingsPath = join(this.controlDir, 'pairings.json')
    this.configPath = join(this.controlDir, 'config.json')

    this.ensureDir()
  }

  private ensureDir(): void {
    if (!existsSync(this.controlDir)) {
      mkdirSync(this.controlDir, { recursive: true, mode: 0o700 })
    }
  }

  // --- Device Identity ---

  getDeviceIdentity(): PersistentDeviceIdentity {
    if (this.cachedIdentity) return this.cachedIdentity

    if (existsSync(this.identityPath)) {
      try {
        const raw = readFileSync(this.identityPath, 'utf-8')
        const data = JSON.parse(raw) as PersistentDeviceIdentity
        if (
          data.mmsDeviceId &&
          data.transportPublicKey &&
          data.transportPrivateKey &&
          data.signingPublicKey &&
          data.signingPrivateKey
        ) {
          this.cachedIdentity = data
          return data
        }
      } catch {
        // Corrupted file, regenerate cleanly
      }
    }

    const bundle = generateDeviceKeyBundle()
    const instKeyPair = generateEd25519KeyPair()
    const identity: PersistentDeviceIdentity = {
      mmsDeviceId: `mms-${randomUUID()}`,
      installationId: `inst-${randomUUID()}`,
      installationPublicKey: instKeyPair.publicKey.toString('base64'),
      installationPrivateKey: instKeyPair.privateKey.toString('base64'),
      transportPublicKey: bundle.transport.publicKey.toString('base64'),
      transportPrivateKey: bundle.transport.privateKey.toString('base64'),
      signingPublicKey: bundle.signing.publicKey.toString('base64'),
      signingPrivateKey: bundle.signing.privateKey.toString('base64')
    }

    this.atomicWriteFile(this.identityPath, JSON.stringify(identity, null, 2))
    this.cachedIdentity = identity
    return identity
  }

  getTransportKeyPair(): RawKeyPair {
    const id = this.getDeviceIdentity()
    return {
      publicKey: Buffer.from(id.transportPublicKey, 'base64'),
      privateKey: Buffer.from(id.transportPrivateKey, 'base64')
    }
  }

  getSigningKeyPair(): RawKeyPair {
    const id = this.getDeviceIdentity()
    return {
      publicKey: Buffer.from(id.signingPublicKey, 'base64'),
      privateKey: Buffer.from(id.signingPrivateKey, 'base64')
    }
  }

  getInstallationKeyPair(): RawKeyPair {
    const id = this.getDeviceIdentity()
    return {
      publicKey: Buffer.from(id.installationPublicKey, 'base64'),
      privateKey: Buffer.from(id.installationPrivateKey, 'base64')
    }
  }

  // --- Credentials (Encrypted at rest) ---

  private deriveStorageKey(salt: Buffer): Buffer {
    let machineInfo = 'mousse-plus-storage'
    try {
      const u = userInfo().username
      const h = hostname()
      machineInfo = `${u}@${h}:${this.controlDir}`
    } catch {
      // Fallback machineInfo
    }
    return createHash('sha256')
      .update(machineInfo)
      .update(salt)
      .digest()
  }

  getCredentials(): PlusAccountCredentials | null {
    if (this.cachedCredentials) return this.cachedCredentials
    if (!existsSync(this.credentialsPath)) return null

    try {
      const encryptedData = readFileSync(this.credentialsPath)
      // Wire format: salt (16 bytes) || iv (12 bytes) || tag (16 bytes) || ciphertext
      if (encryptedData.length < 44) return null

      const salt = encryptedData.subarray(0, 16)
      const iv = encryptedData.subarray(16, 28)
      const tag = encryptedData.subarray(28, 44)
      const ciphertext = encryptedData.subarray(44)

      const key = this.deriveStorageKey(salt)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      const parsed = JSON.parse(decrypted.toString('utf-8')) as PlusAccountCredentials
      this.cachedCredentials = parsed
      return parsed
    } catch {
      return null
    }
  }

  saveCredentials(creds: PlusAccountCredentials): void {
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const key = this.deriveStorageKey(salt)

    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const plaintext = Buffer.from(JSON.stringify(creds), 'utf-8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()

    const encrypted = Buffer.concat([salt, iv, tag, ciphertext])
    this.atomicWriteFile(this.credentialsPath, encrypted)
    this.cachedCredentials = creds
  }

  clearCredentials(): void {
    if (existsSync(this.credentialsPath)) {
      try {
        unlinkSync(this.credentialsPath)
      } catch {
        // Ignore unlink error
      }
    }
    this.cachedCredentials = null
  }

  // --- Pairings Store ---

  listPairings(): PairingGrant[] {
    if (this.cachedPairings) return [...this.cachedPairings]
    if (!existsSync(this.pairingsPath)) {
      this.cachedPairings = []
      return []
    }

    try {
      const raw = readFileSync(this.pairingsPath, 'utf-8')
      const items = JSON.parse(raw) as PairingGrant[]
      if (Array.isArray(items)) {
        this.cachedPairings = items
        return [...items]
      }
    } catch {
      // Corrupted, reset
    }

    this.cachedPairings = []
    return []
  }

  getPairing(pairingId: string): PairingGrant | null {
    const list = this.listPairings()
    return list.find((p) => p.pairingId === pairingId) ?? null
  }

  getActivePairingByMobileKey(mobileStaticPublicKeyBase64: string): PairingGrant | null {
    const list = this.listPairings()
    return (
      list.find(
        (p) => p.mobileStaticPublicKey === mobileStaticPublicKeyBase64 && p.status === 'active'
      ) ?? null
    )
  }

  savePairing(grant: PairingGrant): void {
    const list = this.listPairings()
    const idx = list.findIndex((p) => p.pairingId === grant.pairingId)
    if (idx >= 0) {
      list[idx] = grant
    } else {
      list.push(grant)
    }
    this.atomicWriteFile(this.pairingsPath, JSON.stringify(list, null, 2))
    this.cachedPairings = list
  }

  revokePairing(pairingIdOrDeviceId: string): PairingGrant | null {
    const list = this.listPairings()
    const target = list.find(
      (p) => p.pairingId === pairingIdOrDeviceId || p.mobileDeviceId === pairingIdOrDeviceId
    )
    if (!target) return null

    target.status = 'revoked'
    target.revokedAt = new Date().toISOString()
    this.savePairing(target)
    return target
  }

  // --- Config Store ---

  getConfig(): ControlConfig {
    if (this.cachedConfig) return this.cachedConfig
    const defaults: ControlConfig = {
      mode: 'hosted',
      controlOrigin: DEFAULT_HOSTED_CONTROL_ORIGIN,
      dashboardUrl: DEFAULT_HOSTED_DASHBOARD_URL,
      autoconnect: true
    }

    if (!existsSync(this.configPath)) {
      this.cachedConfig = defaults
      return defaults
    }

    try {
      const raw = readFileSync(this.configPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<ControlConfig>
      this.cachedConfig = {
        mode: parsed.mode === 'self-hosted' ? 'self-hosted' : 'hosted',
        controlOrigin: parsed.controlOrigin?.trim() || defaults.controlOrigin,
        dashboardUrl: parsed.dashboardUrl?.trim() || defaults.dashboardUrl,
        autoconnect: parsed.autoconnect !== false
      }
      return this.cachedConfig
    } catch {
      this.cachedConfig = defaults
      return defaults
    }
  }

  saveConfig(partial: Partial<ControlConfig>): ControlConfig {
    const current = this.getConfig()
    const updated: ControlConfig = {
      ...current,
      ...partial
    }
    this.atomicWriteFile(this.configPath, JSON.stringify(updated, null, 2))
    this.cachedConfig = updated
    return updated
  }

  private atomicWriteFile(filePath: string, data: string | Buffer): void {
    this.ensureDir()
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
    writeFileSync(tempPath, data, { mode: 0o600 })
    renameSync(tempPath, filePath)
  }
}
