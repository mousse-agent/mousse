/**
 * Noise Protocol framework implementation for Control Protocol 2.0.
 * Implements:
 * - Noise_XXpsk0_25519_ChaChaPoly_SHA256 (Initial pairing with QR one-time secret)
 * - Noise_IK_25519_ChaChaPoly_SHA256 (Reconnect using pinned peer static key)
 *
 * All state is cryptographic, strictly validates tags and monotonic nonces,
 * and binds context via prologue.
 */

import { createHash } from 'node:crypto'
import {
  computeSharedSecret,
  generateX25519KeyPair,
  rawX25519PublicToKeyObject,
  type RawKeyPair
} from './keys'
import {
  decryptChaCha20Poly1305,
  deriveKeysHkdf,
  encryptChaCha20Poly1305,
  formatNoiseNonce
} from './aead'
import { PUBLIC_KEY_BYTES } from '../constants'

export const SUITE_XX_PSK0 = 'Noise_XXpsk0_25519_ChaChaPoly_SHA256'
export const SUITE_IK = 'Noise_IK_25519_ChaChaPoly_SHA256'

const HASH_LEN = 32
const MAX_NONCE = BigInt('18446744073709551615') // 2^64 - 1

export class CipherState {
  private key: Buffer | null = null
  private nonce: bigint = 0n

  constructor(key?: Buffer | null) {
    if (key && key.length === 32) {
      this.key = Buffer.from(key)
    }
  }

  hasKey(): boolean {
    return this.key !== null
  }

  setKey(key: Buffer | null): void {
    this.key = key ? Buffer.from(key) : null
    this.nonce = 0n
  }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.key) return Buffer.from(plaintext)
    if (this.nonce >= MAX_NONCE) {
      throw new Error('CipherState nonce exhaustion')
    }
    const iv = formatNoiseNonce(this.nonce)
    const ct = encryptChaCha20Poly1305(this.key, iv, plaintext, ad)
    this.nonce++
    return ct
  }

  decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.key) return Buffer.from(ciphertext)
    if (this.nonce >= MAX_NONCE) {
      throw new Error('CipherState nonce exhaustion')
    }
    const iv = formatNoiseNonce(this.nonce)
    const pt = decryptChaCha20Poly1305(this.key, iv, ciphertext, ad)
    this.nonce++
    return pt
  }

  rekey(): void {
    if (!this.key) return
    const zeros = Buffer.alloc(32)
    const iv = formatNoiseNonce(MAX_NONCE)
    this.key = encryptChaCha20Poly1305(this.key, iv, zeros).subarray(0, 32)
  }
}

export class SymmetricState {
  h: Buffer = Buffer.alloc(HASH_LEN)
  ck: Buffer = Buffer.alloc(HASH_LEN)
  cipher: CipherState = new CipherState()

  constructor(protocolName: string) {
    const nameBuf = Buffer.from(protocolName, 'utf-8')
    if (nameBuf.length <= HASH_LEN) {
      this.h.fill(0)
      nameBuf.copy(this.h)
    } else {
      this.h = createHash('sha256').update(nameBuf).digest()
    }
    this.ck = Buffer.from(this.h)
  }

  mixKey(inputKeyMaterial: Buffer): void {
    const derived = deriveKeysHkdf(inputKeyMaterial, this.ck, '', 64)
    this.ck = derived.subarray(0, 32)
    const tempK = derived.subarray(32, 64)
    this.cipher.setKey(tempK)
  }

  mixHash(data: Buffer): void {
    this.h = createHash('sha256').update(Buffer.concat([this.h, data])).digest()
  }

  mixKeyAndHash(inputKeyMaterial: Buffer): void {
    const derived = deriveKeysHkdf(inputKeyMaterial, this.ck, '', 96)
    this.ck = derived.subarray(0, 32)
    const tempH = derived.subarray(32, 64)
    const tempK = derived.subarray(64, 96)
    this.mixHash(tempH)
    this.cipher.setKey(tempK)
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const ct = this.cipher.encryptWithAd(this.h, plaintext)
    this.mixHash(ct)
    return ct
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return pt
  }

  split(): [CipherState, CipherState] {
    const derived = deriveKeysHkdf(Buffer.alloc(0), this.ck, '', 64)
    const c1 = new CipherState(derived.subarray(0, 32))
    const c2 = new CipherState(derived.subarray(32, 64))
    return [c1, c2]
  }
}

export interface HandshakeContext {
  protocolMajor: number
  installationId: string
  controlOrigin: string
  mode: string
  accountId?: string
  mmsDeviceId: string
  pairingId: string
  role: 'initiator' | 'responder'
}

export function buildPrologue(ctx: HandshakeContext): Buffer {
  const parts = [
    `v=${ctx.protocolMajor}`,
    `inst=${ctx.installationId}`,
    `orig=${ctx.controlOrigin}`,
    `mode=${ctx.mode}`,
    `mms=${ctx.mmsDeviceId}`,
    `pair=${ctx.pairingId}`,
    `role=${ctx.role}`
  ]
  if (ctx.accountId) {
    parts.push(`acc=${ctx.accountId}`)
  }
  return Buffer.from(parts.join('|'), 'utf-8')
}

export interface HandshakeResult {
  sendCipher: CipherState
  recvCipher: CipherState
  remoteStaticKey: Buffer
  handshakeHash: Buffer
}

/**
 * Noise_XXpsk0 responder state machine for MMS daemon during initial pairing.
 *
 * Flow:
 * Message 1: Mobile (Initiator) -> MMS (Responder): e
 * Message 2: MMS (Responder) -> Mobile (Initiator): e, ee, s, es, payload
 * Message 3: Mobile (Initiator) -> MMS (Responder): s, se, payload
 */
export class NoiseXxPsk0Responder {
  private sym: SymmetricState
  private staticKeyPair: RawKeyPair
  private ephemeralKeyPair: RawKeyPair
  private remoteEphemeralKey: Buffer | null = null
  private remoteStaticKey: Buffer | null = null
  private step = 0

  constructor(
    staticKeyPair: RawKeyPair,
    pairingSecret: Buffer | Uint8Array,
    prologue: Buffer
  ) {
    this.staticKeyPair = staticKeyPair
    this.ephemeralKeyPair = generateX25519KeyPair()
    this.sym = new SymmetricState(SUITE_XX_PSK0)
    this.sym.mixHash(prologue)
    this.sym.mixKeyAndHash(Buffer.from(pairingSecret))
  }

  /**
   * Process Message 1 from Mobile: receives Mobile ephemeral public key `e` (32 bytes).
   */
  processMessage1(msg1: Buffer): void {
    if (this.step !== 0) throw new Error(`Invalid handshake step: ${this.step}`)
    if (msg1.length < PUBLIC_KEY_BYTES) {
      throw new Error(`Message 1 too short: expected at least ${PUBLIC_KEY_BYTES} bytes`)
    }
    this.remoteEphemeralKey = msg1.subarray(0, PUBLIC_KEY_BYTES)
    this.sym.mixHash(this.remoteEphemeralKey)
    this.step = 1
  }

  /**
   * Create Message 2 for Mobile: writes MMS ephemeral key `e`, performs `ee`,
   * writes encrypted static key `s`, performs `es`, and encrypts optional payload.
   */
  createMessage2(payload: Buffer = Buffer.alloc(0)): Buffer {
    if (this.step !== 1 || !this.remoteEphemeralKey) {
      throw new Error(`Invalid handshake step: ${this.step}`)
    }
    const out: Buffer[] = []

    // 1. Write e (ephemeral public key)
    out.push(this.ephemeralKeyPair.publicKey)
    this.sym.mixHash(this.ephemeralKeyPair.publicKey)

    // 2. ee = DH(e, re)
    const ee = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteEphemeralKey)
    this.sym.mixKey(ee)

    // 3. s = encryptAndHash(s.publicKey)
    const encryptedStatic = this.sym.encryptAndHash(this.staticKeyPair.publicKey)
    out.push(encryptedStatic)

    // 4. es = DH(s, re)
    const es = computeSharedSecret(this.staticKeyPair.privateKey, this.remoteEphemeralKey)
    this.sym.mixKey(es)

    // 5. Encrypt payload
    const encryptedPayload = this.sym.encryptAndHash(payload)
    out.push(encryptedPayload)

    this.step = 2
    return Buffer.concat(out)
  }

  /**
   * Process Message 3 from Mobile: decrypts Mobile static key `s`, performs `se`,
   * and decrypts optional payload. Returns decrypted payload and final HandshakeResult.
   */
  processMessage3(msg3: Buffer): { payload: Buffer; result: HandshakeResult } {
    if (this.step !== 2 || !this.remoteEphemeralKey) {
      throw new Error(`Invalid handshake step: ${this.step}`)
    }
    // Encrypted static key: 32 bytes + 16 bytes tag = 48 bytes
    if (msg3.length < PUBLIC_KEY_BYTES + 16) {
      throw new Error(`Message 3 too short: expected at least 48 bytes`)
    }

    const encryptedStatic = msg3.subarray(0, PUBLIC_KEY_BYTES + 16)
    const encryptedPayload = msg3.subarray(PUBLIC_KEY_BYTES + 16)

    // 1. s = decryptAndHash(encryptedStatic)
    this.remoteStaticKey = this.sym.decryptAndHash(encryptedStatic)

    // 2. se = DH(e, rs)
    const se = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(se)

    // 3. Decrypt payload
    const payload = this.sym.decryptAndHash(encryptedPayload)

    // 4. Split into transport ciphers
    // For responder: recvCipher is c1 (initiator->responder), sendCipher is c2 (responder->initiator)
    const [c1, c2] = this.sym.split()

    this.step = 3
    return {
      payload,
      result: {
        recvCipher: c1,
        sendCipher: c2,
        remoteStaticKey: this.remoteStaticKey,
        handshakeHash: this.sym.h
      }
    }
  }
}

/**
 * Noise_IK responder state machine for MMS daemon during reconnect with known peer static key.
 *
 * Flow:
 * Message 1: Mobile (Initiator) -> MMS (Responder): e, es, s, ss, payload
 * Message 2: MMS (Responder) -> Mobile (Initiator): e, ee, se, payload
 */
export class NoiseIkResponder {
  private sym: SymmetricState
  private staticKeyPair: RawKeyPair
  private expectedPeerStaticKey: Buffer
  private ephemeralKeyPair: RawKeyPair
  private remoteEphemeralKey: Buffer | null = null
  private remoteStaticKey: Buffer | null = null
  private step = 0

  constructor(
    staticKeyPair: RawKeyPair,
    expectedPeerStaticKey: Buffer,
    prologue: Buffer
  ) {
    this.staticKeyPair = staticKeyPair
    this.expectedPeerStaticKey = expectedPeerStaticKey
    this.ephemeralKeyPair = generateX25519KeyPair()
    this.sym = new SymmetricState(SUITE_IK)
    this.sym.mixHash(prologue)
    // Pre-message: responder static key known to initiator
    this.sym.mixHash(this.staticKeyPair.publicKey)
  }

  /**
   * Process Message 1 from Mobile: receives `e`, performs `es`, decrypts `s`,
   * performs `ss`, decrypts payload.
   */
  processMessage1(msg1: Buffer): { payload: Buffer } {
    if (this.step !== 0) throw new Error(`Invalid handshake step: ${this.step}`)
    // e (32) + encrypted static (32 + 16 = 48) = at least 80 bytes
    if (msg1.length < 80) {
      throw new Error(`Message 1 too short: expected at least 80 bytes`)
    }

    const e = msg1.subarray(0, 32)
    this.remoteEphemeralKey = e
    this.sym.mixHash(e)

    // es = DH(s, re)
    const es = computeSharedSecret(this.staticKeyPair.privateKey, e)
    this.sym.mixKey(es)

    const encryptedStatic = msg1.subarray(32, 80)
    this.remoteStaticKey = this.sym.decryptAndHash(encryptedStatic)

    if (!this.remoteStaticKey.equals(this.expectedPeerStaticKey)) {
      throw new Error('Peer static key does not match expected paired static key')
    }

    // ss = DH(s, rs)
    const ss = computeSharedSecret(this.staticKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(ss)

    const encryptedPayload = msg1.subarray(80)
    const payload = this.sym.decryptAndHash(encryptedPayload)

    this.step = 1
    return { payload }
  }

  /**
   * Create Message 2 for Mobile: writes `e`, performs `ee`, performs `se`,
   * encrypts payload, splits into transport ciphers.
   */
  createMessage2(payload: Buffer = Buffer.alloc(0)): { message: Buffer; result: HandshakeResult } {
    if (this.step !== 1 || !this.remoteEphemeralKey || !this.remoteStaticKey) {
      throw new Error(`Invalid handshake step: ${this.step}`)
    }
    const out: Buffer[] = []

    out.push(this.ephemeralKeyPair.publicKey)
    this.sym.mixHash(this.ephemeralKeyPair.publicKey)

    // ee = DH(e, re)
    const ee = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteEphemeralKey)
    this.sym.mixKey(ee)

    // se = DH(e, rs)
    const se = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(se)

    const encryptedPayload = this.sym.encryptAndHash(payload)
    out.push(encryptedPayload)

    const [c1, c2] = this.sym.split()
    this.step = 2

    return {
      message: Buffer.concat(out),
      result: {
        recvCipher: c1,
        sendCipher: c2,
        remoteStaticKey: this.remoteStaticKey,
        handshakeHash: this.sym.h
      }
    }
  }
}

/**
 * Noise_XXpsk0 initiator state machine (used by tests & mobile simulation).
 */
export class NoiseXxPsk0Initiator {
  private sym: SymmetricState
  private staticKeyPair: RawKeyPair
  private ephemeralKeyPair: RawKeyPair
  private remoteEphemeralKey: Buffer | null = null
  private remoteStaticKey: Buffer | null = null
  private step = 0

  constructor(
    staticKeyPair: RawKeyPair,
    pairingSecret: Buffer | Uint8Array,
    prologue: Buffer
  ) {
    this.staticKeyPair = staticKeyPair
    this.ephemeralKeyPair = generateX25519KeyPair()
    this.sym = new SymmetricState(SUITE_XX_PSK0)
    this.sym.mixHash(prologue)
    this.sym.mixKeyAndHash(Buffer.from(pairingSecret))
  }

  createMessage1(): Buffer {
    if (this.step !== 0) throw new Error(`Invalid step ${this.step}`)
    this.sym.mixHash(this.ephemeralKeyPair.publicKey)
    this.step = 1
    return this.ephemeralKeyPair.publicKey
  }

  processMessage2(msg2: Buffer): { payload: Buffer } {
    if (this.step !== 1) throw new Error(`Invalid step ${this.step}`)
    if (msg2.length < 32 + 48) throw new Error('Message 2 too short')

    const re = msg2.subarray(0, 32)
    this.remoteEphemeralKey = re
    this.sym.mixHash(re)

    const ee = computeSharedSecret(this.ephemeralKeyPair.privateKey, re)
    this.sym.mixKey(ee)

    const encryptedStatic = msg2.subarray(32, 80)
    this.remoteStaticKey = this.sym.decryptAndHash(encryptedStatic)

    const es = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(es)

    const encryptedPayload = msg2.subarray(80)
    const payload = this.sym.decryptAndHash(encryptedPayload)

    this.step = 2
    return { payload }
  }

  createMessage3(payload: Buffer = Buffer.alloc(0)): { message: Buffer; result: HandshakeResult } {
    if (this.step !== 2 || !this.remoteStaticKey || !this.remoteEphemeralKey) {
      throw new Error(`Invalid step ${this.step}`)
    }
    const out: Buffer[] = []

    const encryptedStatic = this.sym.encryptAndHash(this.staticKeyPair.publicKey)
    out.push(encryptedStatic)

    const se = computeSharedSecret(this.staticKeyPair.privateKey, this.remoteEphemeralKey)
    this.sym.mixKey(se)

    const encryptedPayload = this.sym.encryptAndHash(payload)
    out.push(encryptedPayload)

    const [c1, c2] = this.sym.split()
    this.step = 3

    return {
      message: Buffer.concat(out),
      result: {
        sendCipher: c1,
        recvCipher: c2,
        remoteStaticKey: this.remoteStaticKey,
        handshakeHash: this.sym.h
      }
    }
  }
}

/**
 * Noise_IK initiator state machine (used by tests & mobile simulation).
 */
export class NoiseIkInitiator {
  private sym: SymmetricState
  private staticKeyPair: RawKeyPair
  private remoteStaticKey: Buffer
  private ephemeralKeyPair: RawKeyPair
  private step = 0

  constructor(
    staticKeyPair: RawKeyPair,
    remoteStaticKey: Buffer,
    prologue: Buffer
  ) {
    this.staticKeyPair = staticKeyPair
    this.remoteStaticKey = remoteStaticKey
    this.ephemeralKeyPair = generateX25519KeyPair()
    this.sym = new SymmetricState(SUITE_IK)
    this.sym.mixHash(prologue)
    this.sym.mixHash(remoteStaticKey)
  }

  createMessage1(payload: Buffer = Buffer.alloc(0)): Buffer {
    if (this.step !== 0) throw new Error(`Invalid step ${this.step}`)
    const out: Buffer[] = []

    out.push(this.ephemeralKeyPair.publicKey)
    this.sym.mixHash(this.ephemeralKeyPair.publicKey)

    const es = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(es)

    const encryptedStatic = this.sym.encryptAndHash(this.staticKeyPair.publicKey)
    out.push(encryptedStatic)

    const ss = computeSharedSecret(this.staticKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(ss)

    const encryptedPayload = this.sym.encryptAndHash(payload)
    out.push(encryptedPayload)

    this.step = 1
    return Buffer.concat(out)
  }

  processMessage2(msg2: Buffer): { payload: Buffer; result: HandshakeResult } {
    if (this.step !== 1) throw new Error(`Invalid step ${this.step}`)
    if (msg2.length < 32) throw new Error('Message 2 too short')

    const re = msg2.subarray(0, 32)
    this.sym.mixHash(re)

    const ee = computeSharedSecret(this.ephemeralKeyPair.privateKey, re)
    this.sym.mixKey(ee)

    const se = computeSharedSecret(this.staticKeyPair.privateKey, re)
    this.sym.mixKey(se)

    const encryptedPayload = msg2.subarray(32)
    const payload = this.sym.decryptAndHash(encryptedPayload)

    const [c1, c2] = this.sym.split()
    this.step = 2

    return {
      payload,
      result: {
        sendCipher: c1,
        recvCipher: c2,
        remoteStaticKey: this.remoteStaticKey,
        handshakeHash: this.sym.h
      }
    }
  }
}
