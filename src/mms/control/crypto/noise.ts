/**
 * Noise Protocol Framework implementation for Control Protocol 2.0.
 * Aligned with docs/WIRE_PROTOCOL.md §3-§4.
 *
 * Implements:
 * - Noise_XXpsk0_25519_ChaChaPoly_SHA256 (Initial pairing with QR one-time secret)
 * - Noise_IK_25519_ChaChaPoly_SHA256 (Reconnect using pinned peer static key)
 */

import { createCipheriv, createDecipheriv } from 'node:crypto'
import {
  PAIRING_SECRET_BYTES,
  PUBLIC_KEY_BYTES,
  FRAME_FLAG_CONTROL,
  FRAME_FLAG_FIN
} from '../constants'
import {
  computeSharedSecret,
  dh,
  generateX25519KeyPair,
  publicKeyFromPrivate,
  timingSafeEqual,
  cloneBytes,
  type RawKeyPair,
  type X25519KeyPair
} from './keys'
import {
  formatNoiseNonce,
  hkdf,
  sha256
} from './aead'
import { encodeFrame, decodeFrame } from './framing'
import { encodePrologue, type PrologueContext } from './prologue'

export const SUITE_XX_PSK0 = 'Noise_XXpsk0_25519_ChaChaPoly_SHA256'
export const SUITE_IK = 'Noise_IK_25519_ChaChaPoly_SHA256'
export const PAIRING_SUITE = SUITE_XX_PSK0
export const RECONNECT_SUITE = SUITE_IK

export class SessionError extends Error {
  override readonly name = 'SessionError'
}

export const HASH_LEN = 32
export const KEY_LEN = 32
export const DH_LEN = 32
export const TAG_LEN = 16
export const MAX_NONCE = (1n << 64n) - 1n

const EMPTY = new Uint8Array(0)
const HANDSHAKE_FRAME_FLAGS = FRAME_FLAG_CONTROL | FRAME_FLAG_FIN

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

export class CipherState {
  private k: Uint8Array | undefined
  private n = 0n

  constructor(key?: Uint8Array | null) {
    if (key && key.byteLength === KEY_LEN) {
      this.k = new Uint8Array(key)
    }
  }

  initializeKey(key: Uint8Array | undefined): void {
    this.k = key ? new Uint8Array(key) : undefined
    this.n = 0n
  }

  hasKey(): boolean {
    return this.k !== undefined
  }

  get nonce(): bigint {
    return this.n
  }

  setNonce(n: bigint): void {
    this.n = n
  }

  setKey(key: Buffer | Uint8Array | null): void {
    this.k = key ? new Uint8Array(key) : undefined
    this.n = 0n
  }

  encryptWithAd(ad: Uint8Array | Buffer, plaintext: Uint8Array | Buffer): Uint8Array {
    if (!this.k) {
      return new Uint8Array(plaintext)
    }
    if (this.n > MAX_NONCE) {
      throw new Error('CipherState nonce exhaustion')
    }
    const nonceBuf = formatNoiseNonce(this.n)
    const ptBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)
    const adBuf = Buffer.isBuffer(ad) ? ad : Buffer.from(ad)

    const cipher = createCipheriv('chacha20-poly1305', toBuffer(this.k), nonceBuf, {
      authTagLength: TAG_LEN
    })
    if (adBuf.byteLength > 0) {
      cipher.setAAD(adBuf, { plaintextLength: ptBuf.byteLength })
    }
    const enc = Buffer.concat([cipher.update(ptBuf), cipher.final()])
    const tag = cipher.getAuthTag()
    this.n += 1n
    return Buffer.concat([enc, tag])
  }

  decryptWithAd(ad: Uint8Array | Buffer, ciphertext: Uint8Array | Buffer): Uint8Array {
    if (!this.k) {
      return Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext)
    }
    if (ciphertext.byteLength < TAG_LEN) {
      throw new Error('ciphertext too short')
    }
    if (this.n > MAX_NONCE) {
      throw new Error('CipherState nonce exhaustion')
    }
    const nonceBuf = formatNoiseNonce(this.n)
    const ctBuf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext)
    const adBuf = Buffer.isBuffer(ad) ? ad : Buffer.from(ad)

    const body = ctBuf.subarray(0, ctBuf.byteLength - TAG_LEN)
    const tag = ctBuf.subarray(ctBuf.byteLength - TAG_LEN)

    const decipher = createDecipheriv('chacha20-poly1305', toBuffer(this.k), nonceBuf, {
      authTagLength: TAG_LEN
    })
    if (adBuf.byteLength > 0) {
      decipher.setAAD(adBuf, { plaintextLength: body.byteLength })
    }
    decipher.setAuthTag(tag)
    try {
      const dec = Buffer.concat([decipher.update(body), decipher.final()])
      this.n += 1n
      return dec
    } catch {
      throw new Error('AEAD authentication failed')
    }
  }
}

export class SymmetricState {
  ck: Uint8Array = new Uint8Array(HASH_LEN)
  h: Uint8Array = new Uint8Array(HASH_LEN)
  readonly cipher = new CipherState()

  constructor(protocolName?: string) {
    if (protocolName) {
      this.initializeSymmetric(protocolName)
    }
  }

  initializeSymmetric(protocolName: string): void {
    const nameBytes = Buffer.from(protocolName, 'ascii')
    if (nameBytes.byteLength <= HASH_LEN) {
      this.h = new Uint8Array(HASH_LEN)
      this.h.set(nameBytes)
    } else {
      this.h = sha256(new Uint8Array(nameBytes))
    }
    this.ck = new Uint8Array(this.h)
    this.cipher.initializeKey(undefined)
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf(this.ck, inputKeyMaterial, 2)
    this.ck = ck!
    this.cipher.initializeKey(tempK)
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concatBytes(this.h, data))
  }

  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [ck, tempH, tempK] = hkdf(this.ck, inputKeyMaterial, 3)
    this.ck = ck!
    this.mixHash(tempH!)
    this.cipher.initializeKey(tempK)
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  getHandshakeHash(): Uint8Array {
    return new Uint8Array(this.h)
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2)
    const c1 = new CipherState()
    const c2 = new CipherState()
    c1.initializeKey(k1)
    c2.initializeKey(k2)
    return [c1, c2]
  }
}

export type HandshakeRole = 'initiator' | 'responder'

export interface NoiseKeyPair {
  privateKey: Uint8Array
  publicKey: Uint8Array
}

export class HandshakeState {
  readonly symmetric = new SymmetricState()
  readonly role: HandshakeRole
  private readonly s: NoiseKeyPair | undefined
  private e: NoiseKeyPair | undefined
  private rs: Uint8Array | undefined
  private re: Uint8Array | undefined
  private readonly psk: Uint8Array | undefined
  private messageIndex = 0
  private readonly pattern: 'XXpsk0' | 'IK'
  private complete = false

  private constructor(
    pattern: 'XXpsk0' | 'IK',
    role: HandshakeRole,
    opts: {
      prologue: Uint8Array
      staticKeyPair?: NoiseKeyPair
      remoteStaticPublicKey?: Uint8Array
      psk?: Uint8Array
      ephemeralKeyPair?: NoiseKeyPair
    }
  ) {
    this.pattern = pattern
    this.role = role
    this.s = opts.staticKeyPair
    this.e = opts.ephemeralKeyPair
    this.rs = opts.remoteStaticPublicKey ? new Uint8Array(opts.remoteStaticPublicKey) : undefined
    this.psk = opts.psk ? new Uint8Array(opts.psk) : undefined

    const protocolName =
      pattern === 'XXpsk0'
        ? SUITE_XX_PSK0
        : SUITE_IK

    this.symmetric.initializeSymmetric(protocolName)
    this.symmetric.mixHash(opts.prologue)

    if (pattern === 'IK') {
      if (role === 'initiator') {
        if (!this.rs) {
          throw new Error('IK initiator requires remote static public key')
        }
        this.symmetric.mixHash(this.rs)
      } else {
        if (!this.s) {
          throw new Error('IK responder requires static key')
        }
        this.symmetric.mixHash(this.s.publicKey)
        this.rs = undefined
      }
    }
  }

  static createXXpsk0(
    role: HandshakeRole,
    opts: {
      prologue: Uint8Array
      staticKeyPair: NoiseKeyPair
      psk: Uint8Array
      ephemeralKeyPair?: NoiseKeyPair
    }
  ): HandshakeState {
    if (opts.psk.byteLength !== 32) {
      throw new Error('psk must be 32 bytes')
    }
    return new HandshakeState('XXpsk0', role, opts)
  }

  static createIK(
    role: HandshakeRole,
    opts: {
      prologue: Uint8Array
      staticKeyPair: NoiseKeyPair
      remoteStaticPublicKey?: Uint8Array
      ephemeralKeyPair?: NoiseKeyPair
    }
  ): HandshakeState {
    if (role === 'initiator' && !opts.remoteStaticPublicKey) {
      throw new Error('IK initiator requires remoteStaticPublicKey')
    }
    return new HandshakeState('IK', role, opts)
  }

  get remoteStaticPublicKey(): Uint8Array | undefined {
    return this.rs ? new Uint8Array(this.rs) : undefined
  }

  isComplete(): boolean {
    return this.complete
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    if (this.complete) {
      throw new Error('handshake already complete')
    }
    const out: Uint8Array[] = []

    if (this.pattern === 'XXpsk0') {
      if (this.role === 'initiator' && this.messageIndex === 0) {
        this.mixPsk()
        this.writeE(out)
        out.push(this.symmetric.encryptAndHash(payload))
        this.messageIndex = 1
        return concatBytes(...out)
      }
      if (this.role === 'responder' && this.messageIndex === 1) {
        this.writeE(out)
        this.dhEe()
        this.writeS(out)
        this.dhEs()
        out.push(this.symmetric.encryptAndHash(payload))
        this.messageIndex = 2
        return concatBytes(...out)
      }
      if (this.role === 'initiator' && this.messageIndex === 2) {
        this.writeS(out)
        this.dhSe()
        out.push(this.symmetric.encryptAndHash(payload))
        this.messageIndex = 3
        this.complete = true
        return concatBytes(...out)
      }
    }

    if (this.pattern === 'IK') {
      if (this.role === 'initiator' && this.messageIndex === 0) {
        this.writeE(out)
        this.dhEs()
        this.writeS(out)
        this.dhSs()
        out.push(this.symmetric.encryptAndHash(payload))
        this.messageIndex = 1
        return concatBytes(...out)
      }
      if (this.role === 'responder' && this.messageIndex === 1) {
        this.writeE(out)
        this.dhEe()
        this.dhSe()
        out.push(this.symmetric.encryptAndHash(payload))
        this.messageIndex = 2
        this.complete = true
        return concatBytes(...out)
      }
    }

    throw new Error(`unexpected writeMessage in ${this.pattern} as ${this.role} at step ${this.messageIndex}`)
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.complete) {
      throw new Error('handshake already complete')
    }
    let offset = 0
    const take = (n: number): Uint8Array => {
      if (offset + n > message.byteLength) {
        throw new Error('handshake message truncated')
      }
      const slice = message.subarray(offset, offset + n)
      offset += n
      return slice
    }

    if (this.pattern === 'XXpsk0') {
      if (this.role === 'responder' && this.messageIndex === 0) {
        this.mixPsk()
        this.readE(take)
        const payload = this.symmetric.decryptAndHash(message.subarray(offset))
        this.messageIndex = 1
        return payload
      }
      if (this.role === 'initiator' && this.messageIndex === 1) {
        this.readE(take)
        this.dhEe()
        this.readS(take)
        this.dhEs()
        const payload = this.symmetric.decryptAndHash(message.subarray(offset))
        this.messageIndex = 2
        return payload
      }
      if (this.role === 'responder' && this.messageIndex === 2) {
        this.readS(take)
        this.dhSe()
        const payload = this.symmetric.decryptAndHash(message.subarray(offset))
        this.messageIndex = 3
        this.complete = true
        return payload
      }
    }

    if (this.pattern === 'IK') {
      if (this.role === 'responder' && this.messageIndex === 0) {
        this.readE(take)
        this.dhEs()
        this.readS(take)
        this.dhSs()
        const payload = this.symmetric.decryptAndHash(message.subarray(offset))
        this.messageIndex = 1
        return payload
      }
      if (this.role === 'initiator' && this.messageIndex === 1) {
        this.readE(take)
        this.dhEe()
        this.dhSe()
        const payload = this.symmetric.decryptAndHash(message.subarray(offset))
        this.messageIndex = 2
        this.complete = true
        return payload
      }
    }

    throw new Error(`unexpected readMessage in ${this.pattern} as ${this.role} at step ${this.messageIndex}`)
  }

  splitTransport(): { send: CipherState; recv: CipherState; handshakeHash: Uint8Array } {
    if (!this.complete) {
      throw new Error('handshake not complete')
    }
    const [c1, c2] = this.symmetric.split()
    const handshakeHash = this.symmetric.getHandshakeHash()
    if (this.role === 'initiator') {
      return { send: c1, recv: c2, handshakeHash }
    }
    return { send: c2, recv: c1, handshakeHash }
  }

  private mixPsk(): void {
    if (!this.psk) {
      throw new Error('missing psk')
    }
    this.symmetric.mixKeyAndHash(this.psk)
  }

  private ensureEphemeral(): NoiseKeyPair {
    if (!this.e) {
      const pair = generateX25519KeyPair()
      this.e = {
        privateKey: new Uint8Array(pair.privateKey),
        publicKey: new Uint8Array(pair.publicKey)
      }
    }
    return this.e
  }

  private writeE(out: Uint8Array[]): void {
    const e = this.ensureEphemeral()
    out.push(new Uint8Array(e.publicKey))
    this.symmetric.mixHash(e.publicKey)
  }

  private readE(take: (n: number) => Uint8Array): void {
    this.re = new Uint8Array(take(DH_LEN))
    this.symmetric.mixHash(this.re)
  }

  private writeS(out: Uint8Array[]): void {
    if (!this.s) {
      throw new Error('missing static key')
    }
    out.push(this.symmetric.encryptAndHash(this.s.publicKey))
  }

  private readS(take: (n: number) => Uint8Array): void {
    const len = this.symmetric.cipher.hasKey() ? DH_LEN + TAG_LEN : DH_LEN
    this.rs = new Uint8Array(this.symmetric.decryptAndHash(take(len)))
  }

  private dhEe(): void {
    const e = this.ensureEphemeral()
    if (!this.re) throw new Error('missing remote ephemeral')
    this.symmetric.mixKey(dh(e.privateKey, this.re))
  }

  private dhEs(): void {
    if (this.role === 'initiator') {
      const e = this.ensureEphemeral()
      if (!this.rs) throw new Error('missing remote static')
      this.symmetric.mixKey(dh(e.privateKey, this.rs))
    } else {
      if (!this.s) throw new Error('missing static key')
      if (!this.re) throw new Error('missing remote ephemeral')
      this.symmetric.mixKey(dh(this.s.privateKey, this.re))
    }
  }

  private dhSe(): void {
    if (this.role === 'initiator') {
      if (!this.s) throw new Error('missing static key')
      if (!this.re) throw new Error('missing remote ephemeral')
      this.symmetric.mixKey(dh(this.s.privateKey, this.re))
    } else {
      const e = this.ensureEphemeral()
      if (!this.rs) throw new Error('missing remote static')
      this.symmetric.mixKey(dh(e.privateKey, this.rs))
    }
  }

  private dhSs(): void {
    if (!this.s) throw new Error('missing static key')
    if (!this.rs) throw new Error('missing remote static')
    this.symmetric.mixKey(dh(this.s.privateKey, this.rs))
  }
}

export class HandshakeError extends Error {
  override readonly name = 'HandshakeError'
}

export interface StaticIdentity {
  keyPair: X25519KeyPair | RawKeyPair
}

function asNoiseKeyPair(keyPair: X25519KeyPair | RawKeyPair): NoiseKeyPair {
  return {
    privateKey: cloneBytes(new Uint8Array(keyPair.privateKey)),
    publicKey: cloneBytes(new Uint8Array(keyPair.publicKey))
  }
}

/**
 * Noise Transport Session:
 * Encrypts canonical envelope bytes into a FIN frame.
 * Decrypts received FIN frame into plaintext envelope bytes.
 */
export class SecureSession {
  private closed = false

  constructor(
    readonly send: CipherState,
    readonly recv: CipherState,
    readonly handshakeHash: Uint8Array,
    readonly remoteStaticPublicKey: Uint8Array
  ) {}

  get sendNonce(): bigint {
    return this.send.nonce
  }

  get recvNonce(): bigint {
    return this.recv.nonce
  }

  encrypt(plaintext: Uint8Array | Buffer): Uint8Array {
    this.assertOpen()
    const pt = Buffer.isBuffer(plaintext) ? new Uint8Array(plaintext) : plaintext
    const ct = this.send.encryptWithAd(EMPTY, pt)
    return encodeFrame(ct, FRAME_FLAG_FIN)
  }

  decrypt(frame: Uint8Array | Buffer): Uint8Array {
    this.assertOpen()
    const f = Buffer.isBuffer(frame) ? new Uint8Array(frame) : frame
    const { payload, flags } = decodeFrame(f)
    if ((flags & FRAME_FLAG_FIN) === 0) {
      throw new SessionError('transport frame missing FIN flag')
    }
    if (payload.byteLength < TAG_LEN) {
      throw new SessionError('ciphertext too short')
    }
    try {
      return this.recv.decryptWithAd(EMPTY, payload)
    } catch {
      throw new SessionError('decrypt failed: authentication, replay, or out-of-order')
    }
  }

  decryptRaw(ciphertext: Uint8Array | Buffer): Uint8Array {
    this.assertOpen()
    const ct = Buffer.isBuffer(ciphertext) ? new Uint8Array(ciphertext) : ciphertext
    try {
      return this.recv.decryptWithAd(EMPTY, ct)
    } catch {
      throw new SessionError('decrypt failed: authentication, replay, or out-of-order')
    }
  }

  encryptRaw(plaintext: Uint8Array | Buffer): Uint8Array {
    this.assertOpen()
    const pt = Buffer.isBuffer(plaintext) ? new Uint8Array(plaintext) : plaintext
    return this.send.encryptWithAd(EMPTY, pt)
  }

  close(): void {
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SessionError('session closed')
    }
  }
}

export interface HandshakeResult {
  session: SecureSession
  remoteStaticPublicKey: Uint8Array
  handshakeHash: Uint8Array
  pattern: 'XXpsk0' | 'IK'
}

export class PairingHandshake {
  private readonly state: HandshakeState
  private readonly pinnedRemoteStatic: Uint8Array | undefined
  private done = false

  private constructor(state: HandshakeState, pinnedRemoteStatic?: Uint8Array) {
    this.state = state
    this.pinnedRemoteStatic = pinnedRemoteStatic
  }

  static initiator(opts: {
    prologue: PrologueContext
    identity: StaticIdentity
    pairingSecret: Uint8Array | Buffer
    ephemeral?: X25519KeyPair | RawKeyPair
  }): PairingHandshake {
    const prologue = encodePrologue(opts.prologue)
    const state = HandshakeState.createXXpsk0('initiator', {
      prologue,
      staticKeyPair: asNoiseKeyPair(opts.identity.keyPair),
      psk: new Uint8Array(opts.pairingSecret),
      ephemeralKeyPair: opts.ephemeral ? asNoiseKeyPair(opts.ephemeral) : undefined
    })
    return new PairingHandshake(state, undefined)
  }

  static responder(opts: {
    prologue: PrologueContext
    identity: StaticIdentity
    pairingSecret: Uint8Array | Buffer
    expectedInitiatorStatic?: Uint8Array | Buffer
    ephemeral?: X25519KeyPair | RawKeyPair
  }): PairingHandshake {
    const prologue = encodePrologue(opts.prologue)
    const state = HandshakeState.createXXpsk0('responder', {
      prologue,
      staticKeyPair: asNoiseKeyPair(opts.identity.keyPair),
      psk: new Uint8Array(opts.pairingSecret),
      ephemeralKeyPair: opts.ephemeral ? asNoiseKeyPair(opts.ephemeral) : undefined
    })
    return new PairingHandshake(
      state,
      opts.expectedInitiatorStatic ? new Uint8Array(opts.expectedInitiatorStatic) : undefined
    )
  }

  write(payload: Uint8Array | Buffer = EMPTY): Uint8Array {
    this.assertActive()
    try {
      const pt = Buffer.isBuffer(payload) ? new Uint8Array(payload) : payload
      return encodeFrame(this.state.writeMessage(pt), HANDSHAKE_FRAME_FLAGS)
    } catch (err) {
      throw new HandshakeError(err instanceof Error ? err.message : 'write failed')
    }
  }

  read(frame: Uint8Array | Buffer): Uint8Array {
    this.assertActive()
    try {
      const f = Buffer.isBuffer(frame) ? new Uint8Array(frame) : frame
      const { payload, flags } = decodeFrame(f)
      if ((flags & FRAME_FLAG_CONTROL) === 0) {
        throw new HandshakeError('handshake frame missing CONTROL flag')
      }
      const plain = this.state.readMessage(payload)
      if (this.pinnedRemoteStatic && this.state.remoteStaticPublicKey) {
        if (!timingSafeEqual(this.state.remoteStaticPublicKey, this.pinnedRemoteStatic)) {
          throw new HandshakeError('remote static key does not match pin')
        }
      }
      return plain
    } catch (err) {
      if (err instanceof HandshakeError) throw err
      throw new HandshakeError(err instanceof Error ? err.message : 'read failed')
    }
  }

  finish(): HandshakeResult {
    if (!this.state.isComplete()) {
      throw new HandshakeError('handshake incomplete')
    }
    this.done = true
    const remote = this.state.remoteStaticPublicKey
    if (!remote) {
      throw new HandshakeError('missing remote static public key')
    }
    if (this.pinnedRemoteStatic && !timingSafeEqual(remote, this.pinnedRemoteStatic)) {
      throw new HandshakeError('remote static key does not match pin')
    }
    const { send, recv, handshakeHash } = this.state.splitTransport()
    return {
      session: new SecureSession(send, recv, handshakeHash, remote),
      remoteStaticPublicKey: remote,
      handshakeHash,
      pattern: 'XXpsk0'
    }
  }

  isComplete(): boolean {
    return this.state.isComplete()
  }

  private assertActive(): void {
    if (this.done) {
      throw new HandshakeError('handshake already finished')
    }
  }
}

export class ReconnectHandshake {
  private readonly state: HandshakeState
  private readonly expectedInitiatorStatic?: Uint8Array
  private done = false

  private constructor(state: HandshakeState, expectedInitiatorStatic?: Uint8Array) {
    this.state = state
    this.expectedInitiatorStatic = expectedInitiatorStatic
  }

  static initiator(opts: {
    prologue: PrologueContext
    identity: StaticIdentity
    remoteStaticPublicKey: Uint8Array | Buffer
    ephemeral?: X25519KeyPair | RawKeyPair
  }): ReconnectHandshake {
    const prologue = encodePrologue(opts.prologue)
    const state = HandshakeState.createIK('initiator', {
      prologue,
      staticKeyPair: asNoiseKeyPair(opts.identity.keyPair),
      remoteStaticPublicKey: new Uint8Array(opts.remoteStaticPublicKey),
      ephemeralKeyPair: opts.ephemeral ? asNoiseKeyPair(opts.ephemeral) : undefined
    })
    return new ReconnectHandshake(state)
  }

  static responder(opts: {
    prologue: PrologueContext
    identity: StaticIdentity
    expectedInitiatorStatic?: Uint8Array | Buffer
    ephemeral?: X25519KeyPair | RawKeyPair
  }): ReconnectHandshake {
    const prologue = encodePrologue(opts.prologue)
    const state = HandshakeState.createIK('responder', {
      prologue,
      staticKeyPair: asNoiseKeyPair(opts.identity.keyPair),
      ephemeralKeyPair: opts.ephemeral ? asNoiseKeyPair(opts.ephemeral) : undefined
    })
    return new ReconnectHandshake(
      state,
      opts.expectedInitiatorStatic ? new Uint8Array(opts.expectedInitiatorStatic) : undefined
    )
  }

  write(payload: Uint8Array | Buffer = EMPTY): Uint8Array {
    this.assertActive()
    try {
      const pt = Buffer.isBuffer(payload) ? new Uint8Array(payload) : payload
      return encodeFrame(this.state.writeMessage(pt), HANDSHAKE_FRAME_FLAGS)
    } catch (err) {
      throw new HandshakeError(err instanceof Error ? err.message : 'write failed')
    }
  }

  read(frame: Uint8Array | Buffer): Uint8Array {
    this.assertActive()
    try {
      const f = Buffer.isBuffer(frame) ? new Uint8Array(frame) : frame
      const { payload, flags } = decodeFrame(f)
      if ((flags & FRAME_FLAG_CONTROL) === 0) {
        throw new HandshakeError('handshake frame missing CONTROL flag')
      }
      const plain = this.state.readMessage(payload)
      if (this.expectedInitiatorStatic && this.state.remoteStaticPublicKey) {
        if (!timingSafeEqual(this.state.remoteStaticPublicKey, this.expectedInitiatorStatic)) {
          throw new HandshakeError('remote static key does not match pin')
        }
      }
      return plain
    } catch (err) {
      if (err instanceof HandshakeError) throw err
      throw new HandshakeError(err instanceof Error ? err.message : 'read failed')
    }
  }

  finish(): HandshakeResult {
    if (!this.state.isComplete()) {
      throw new HandshakeError('handshake incomplete')
    }
    this.done = true
    const remote = this.state.remoteStaticPublicKey
    if (!remote) {
      throw new HandshakeError('missing remote static public key')
    }
    if (this.expectedInitiatorStatic && !timingSafeEqual(remote, this.expectedInitiatorStatic)) {
      throw new HandshakeError('remote static key does not match pin')
    }
    const { send, recv, handshakeHash } = this.state.splitTransport()
    return {
      session: new SecureSession(send, recv, handshakeHash, remote),
      remoteStaticPublicKey: remote,
      handshakeHash,
      pattern: 'IK'
    }
  }

  isComplete(): boolean {
    return this.state.isComplete()
  }

  private assertActive(): void {
    if (this.done) {
      throw new HandshakeError('handshake already finished')
    }
  }
}

/** Run a full XXpsk0 pairing handshake between initiator and responder. */
export function runPairingHandshake(opts: {
  prologue: PrologueContext
  initiatorIdentity: StaticIdentity
  responderIdentity: StaticIdentity
  pairingSecret: Uint8Array | Buffer
  initiatorPayload?: Uint8Array | Buffer
  responderPayload?: Uint8Array | Buffer
  initiatorEphemeral?: X25519KeyPair | RawKeyPair
  responderEphemeral?: X25519KeyPair | RawKeyPair
}): { initiator: HandshakeResult; responder: HandshakeResult; messages: Uint8Array[] } {
  const init = PairingHandshake.initiator({
    prologue: opts.prologue,
    identity: opts.initiatorIdentity,
    pairingSecret: opts.pairingSecret,
    ephemeral: opts.initiatorEphemeral
  })
  const resp = PairingHandshake.responder({
    prologue: opts.prologue,
    identity: opts.responderIdentity,
    pairingSecret: opts.pairingSecret,
    ephemeral: opts.responderEphemeral
  })

  const m1 = init.write(opts.initiatorPayload ?? EMPTY)
  resp.read(m1)
  const m2 = resp.write(opts.responderPayload ?? EMPTY)
  init.read(m2)
  const m3 = init.write()
  resp.read(m3)

  return {
    initiator: init.finish(),
    responder: resp.finish(),
    messages: [m1, m2, m3]
  }
}

/** Run a full IK reconnect handshake between initiator and responder. */
export function runReconnectHandshake(opts: {
  prologue: PrologueContext
  initiatorIdentity: StaticIdentity
  responderIdentity: StaticIdentity
  initiatorPayload?: Uint8Array | Buffer
  responderPayload?: Uint8Array | Buffer
  initiatorEphemeral?: X25519KeyPair | RawKeyPair
  responderEphemeral?: X25519KeyPair | RawKeyPair
}): { initiator: HandshakeResult; responder: HandshakeResult; messages: Uint8Array[] } {
  const init = ReconnectHandshake.initiator({
    prologue: opts.prologue,
    identity: opts.initiatorIdentity,
    remoteStaticPublicKey: opts.responderIdentity.keyPair.publicKey,
    ephemeral: opts.initiatorEphemeral
  })
  const resp = ReconnectHandshake.responder({
    prologue: opts.prologue,
    identity: opts.responderIdentity,
    expectedInitiatorStatic: opts.initiatorIdentity.keyPair.publicKey,
    ephemeral: opts.responderEphemeral
  })

  const m1 = init.write(opts.initiatorPayload ?? EMPTY)
  resp.read(m1)
  const m2 = resp.write(opts.responderPayload ?? EMPTY)
  init.read(m2)

  return {
    initiator: init.finish(),
    responder: resp.finish(),
    messages: [m1, m2]
  }
}

// --- Compatibility helpers for tests and legacy callers ---

export function buildPrologue(fields: any): Uint8Array {
  if (fields && typeof fields === 'object' && 'installationId' in fields && 'mmsDeviceId' in fields) {
    return encodePrologue({
      protocolMajor: fields.protocolMajor ?? 2,
      protocolMinor: fields.protocolMinor ?? 0,
      installationId: fields.installationId,
      controlOrigin: fields.controlOrigin,
      mode: fields.mode === 'self_hosted' ? 'self-hosted' : fields.mode,
      accountId: fields.accountId,
      mmsDeviceId: fields.mmsDeviceId,
      mobileDeviceId: fields.mobileDeviceId ?? (fields.role === 'responder' ? 'mobile' : fields.mmsDeviceId),
      pairingId: fields.pairingId,
      initiatorRole: fields.role === 'responder' ? 'mobile' : 'mms',
      responderRole: fields.role === 'responder' ? 'mms' : 'mobile'
    })
  }
  return Buffer.from(String(fields), 'utf-8')
}

export interface LegacyHandshakeResult {
  sendCipher: CipherState
  recvCipher: CipherState
  remoteStaticKey: Buffer
  handshakeHash: Uint8Array
}

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
    prologue: Buffer | Uint8Array
  ) {
    this.staticKeyPair = staticKeyPair
    this.ephemeralKeyPair = generateX25519KeyPair()
    this.sym = new SymmetricState(SUITE_XX_PSK0)
    this.sym.mixHash(new Uint8Array(prologue))
    this.sym.mixKeyAndHash(new Uint8Array(pairingSecret))
  }

  createMessage1(): Buffer {
    if (this.step !== 0) throw new Error(`Invalid step ${this.step}`)
    this.sym.mixHash(new Uint8Array(this.ephemeralKeyPair.publicKey))
    this.step = 1
    return Buffer.from(this.ephemeralKeyPair.publicKey)
  }

  processMessage2(msg2: Buffer | Uint8Array): { payload: Buffer } {
    if (this.step !== 1) throw new Error(`Invalid step ${this.step}`)
    const buf = Buffer.isBuffer(msg2) ? msg2 : Buffer.from(msg2)
    if (buf.length < 32 + 48) throw new Error('Message 2 too short')

    const re = buf.subarray(0, 32)
    this.remoteEphemeralKey = re
    this.sym.mixHash(new Uint8Array(re))

    const ee = computeSharedSecret(this.ephemeralKeyPair.privateKey, re)
    this.sym.mixKey(new Uint8Array(ee))

    const encryptedStatic = buf.subarray(32, 80)
    this.remoteStaticKey = Buffer.from(this.sym.decryptAndHash(new Uint8Array(encryptedStatic)))

    const es = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(new Uint8Array(es))

    const encryptedPayload = buf.subarray(80)
    const payload = Buffer.from(this.sym.decryptAndHash(new Uint8Array(encryptedPayload)))

    this.step = 2
    return { payload }
  }

  createMessage3(payload: Buffer | Uint8Array = Buffer.alloc(0)): { message: Buffer; result: LegacyHandshakeResult } {
    if (this.step !== 2 || !this.remoteStaticKey || !this.remoteEphemeralKey) {
      throw new Error(`Invalid step ${this.step}`)
    }
    const out: Buffer[] = []
    const encryptedStatic = Buffer.from(this.sym.encryptAndHash(new Uint8Array(this.staticKeyPair.publicKey)))
    out.push(encryptedStatic)

    const se = computeSharedSecret(this.staticKeyPair.privateKey, this.remoteEphemeralKey)
    this.sym.mixKey(new Uint8Array(se))

    const encryptedPayload = Buffer.from(this.sym.encryptAndHash(new Uint8Array(payload)))
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
    prologue: Buffer | Uint8Array
  ) {
    this.staticKeyPair = staticKeyPair
    this.ephemeralKeyPair = generateX25519KeyPair()
    this.sym = new SymmetricState(SUITE_XX_PSK0)
    this.sym.mixHash(new Uint8Array(prologue))
    this.sym.mixKeyAndHash(new Uint8Array(pairingSecret))
  }

  processMessage1(msg1: Buffer | Uint8Array): void {
    if (this.step !== 0) throw new Error(`Invalid step ${this.step}`)
    const buf = Buffer.isBuffer(msg1) ? msg1 : Buffer.from(msg1)
    if (buf.length < 32) throw new Error('Message 1 too short')
    this.remoteEphemeralKey = buf.subarray(0, 32)
    this.sym.mixHash(new Uint8Array(this.remoteEphemeralKey))
    this.step = 1
  }

  createMessage2(payload: Buffer | Uint8Array = Buffer.alloc(0)): Buffer {
    if (this.step !== 1 || !this.remoteEphemeralKey) throw new Error(`Invalid step ${this.step}`)
    const out: Buffer[] = []
    out.push(Buffer.from(this.ephemeralKeyPair.publicKey))
    this.sym.mixHash(new Uint8Array(this.ephemeralKeyPair.publicKey))

    const ee = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteEphemeralKey)
    this.sym.mixKey(new Uint8Array(ee))

    const encryptedStatic = Buffer.from(this.sym.encryptAndHash(new Uint8Array(this.staticKeyPair.publicKey)))
    out.push(encryptedStatic)

    const es = computeSharedSecret(this.staticKeyPair.privateKey, this.remoteEphemeralKey)
    this.sym.mixKey(new Uint8Array(es))

    const encryptedPayload = Buffer.from(this.sym.encryptAndHash(new Uint8Array(payload)))
    out.push(encryptedPayload)

    this.step = 2
    return Buffer.concat(out)
  }

  processMessage3(msg3: Buffer | Uint8Array): { payload: Buffer; result: LegacyHandshakeResult } {
    if (this.step !== 2 || !this.remoteEphemeralKey) throw new Error(`Invalid step ${this.step}`)
    const buf = Buffer.isBuffer(msg3) ? msg3 : Buffer.from(msg3)
    if (buf.length < 48) throw new Error('Message 3 too short')

    const encryptedStatic = buf.subarray(0, 48)
    this.remoteStaticKey = Buffer.from(this.sym.decryptAndHash(new Uint8Array(encryptedStatic)))

    const se = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(new Uint8Array(se))

    const encryptedPayload = buf.subarray(48)
    const payload = Buffer.from(this.sym.decryptAndHash(new Uint8Array(encryptedPayload)))

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

export class NoiseIkInitiator {
  private sym: SymmetricState
  private staticKeyPair: RawKeyPair
  private remoteStaticKey: Buffer
  private ephemeralKeyPair: RawKeyPair
  private step = 0

  constructor(
    staticKeyPair: RawKeyPair,
    remoteStaticKey: Buffer | Uint8Array,
    prologue: Buffer | Uint8Array
  ) {
    this.staticKeyPair = staticKeyPair
    this.remoteStaticKey = Buffer.from(remoteStaticKey)
    this.ephemeralKeyPair = generateX25519KeyPair()
    this.sym = new SymmetricState(SUITE_IK)
    this.sym.mixHash(new Uint8Array(prologue))
    this.sym.mixHash(new Uint8Array(this.remoteStaticKey))
  }

  createMessage1(payload: Buffer | Uint8Array = Buffer.alloc(0)): Buffer {
    if (this.step !== 0) throw new Error(`Invalid step ${this.step}`)
    const out: Buffer[] = []
    out.push(Buffer.from(this.ephemeralKeyPair.publicKey))
    this.sym.mixHash(new Uint8Array(this.ephemeralKeyPair.publicKey))

    const es = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(new Uint8Array(es))

    const encryptedStatic = Buffer.from(this.sym.encryptAndHash(new Uint8Array(this.staticKeyPair.publicKey)))
    out.push(encryptedStatic)

    const ss = computeSharedSecret(this.staticKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(new Uint8Array(ss))

    const encryptedPayload = Buffer.from(this.sym.encryptAndHash(new Uint8Array(payload)))
    out.push(encryptedPayload)

    this.step = 1
    return Buffer.concat(out)
  }

  processMessage2(msg2: Buffer | Uint8Array): { payload: Buffer; result: LegacyHandshakeResult } {
    if (this.step !== 1) throw new Error(`Invalid step ${this.step}`)
    const buf = Buffer.isBuffer(msg2) ? msg2 : Buffer.from(msg2)
    if (buf.length < 32) throw new Error('Message 2 too short')

    const re = buf.subarray(0, 32)
    this.sym.mixHash(new Uint8Array(re))

    const ee = computeSharedSecret(this.ephemeralKeyPair.privateKey, re)
    this.sym.mixKey(new Uint8Array(ee))

    const se = computeSharedSecret(this.staticKeyPair.privateKey, re)
    this.sym.mixKey(new Uint8Array(se))

    const encryptedPayload = buf.subarray(32)
    const payload = Buffer.from(this.sym.decryptAndHash(new Uint8Array(encryptedPayload)))

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
    expectedPeerStaticKey: Buffer | Uint8Array,
    prologue: Buffer | Uint8Array
  ) {
    this.staticKeyPair = staticKeyPair
    this.expectedPeerStaticKey = Buffer.from(expectedPeerStaticKey)
    this.ephemeralKeyPair = generateX25519KeyPair()
    this.sym = new SymmetricState(SUITE_IK)
    this.sym.mixHash(new Uint8Array(prologue))
    this.sym.mixHash(new Uint8Array(this.staticKeyPair.publicKey))
  }

  processMessage1(msg1: Buffer | Uint8Array): { payload: Buffer } {
    if (this.step !== 0) throw new Error(`Invalid handshake step: ${this.step}`)
    const buf = Buffer.isBuffer(msg1) ? msg1 : Buffer.from(msg1)
    if (buf.length < 80) throw new Error('Message 1 too short')

    const e = buf.subarray(0, 32)
    this.remoteEphemeralKey = e
    this.sym.mixHash(new Uint8Array(e))

    const es = computeSharedSecret(this.staticKeyPair.privateKey, e)
    this.sym.mixKey(new Uint8Array(es))

    const encryptedStatic = buf.subarray(32, 80)
    this.remoteStaticKey = Buffer.from(this.sym.decryptAndHash(new Uint8Array(encryptedStatic)))

    if (!this.remoteStaticKey.equals(this.expectedPeerStaticKey)) {
      throw new Error('Peer static key does not match expected paired static key')
    }

    const ss = computeSharedSecret(this.staticKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(new Uint8Array(ss))

    const encryptedPayload = buf.subarray(80)
    const payload = Buffer.from(this.sym.decryptAndHash(new Uint8Array(encryptedPayload)))

    this.step = 1
    return { payload }
  }

  createMessage2(payload: Buffer | Uint8Array = Buffer.alloc(0)): { message: Buffer; result: LegacyHandshakeResult } {
    if (this.step !== 1 || !this.remoteEphemeralKey || !this.remoteStaticKey) {
      throw new Error(`Invalid handshake step: ${this.step}`)
    }
    const out: Buffer[] = []
    out.push(Buffer.from(this.ephemeralKeyPair.publicKey))
    this.sym.mixHash(new Uint8Array(this.ephemeralKeyPair.publicKey))

    const ee = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteEphemeralKey)
    this.sym.mixKey(new Uint8Array(ee))

    const se = computeSharedSecret(this.ephemeralKeyPair.privateKey, this.remoteStaticKey)
    this.sym.mixKey(new Uint8Array(se))

    const encryptedPayload = Buffer.from(this.sym.encryptAndHash(new Uint8Array(payload)))
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

