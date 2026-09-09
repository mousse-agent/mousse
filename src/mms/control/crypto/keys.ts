/**
 * Cryptographic key management for Control Protocol 2.0.
 * Implements X25519 (ECDH key exchange) and Ed25519 (digital signatures).
 * Uses Node.js native crypto without external dependencies.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject
} from 'node:crypto'
import { PUBLIC_KEY_BYTES } from '../constants'

export const PRIVATE_KEY_BYTES = 32
export const DH_OUTPUT_BYTES = 32

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export interface RawKeyPair {
  publicKey: Buffer // 32 bytes
  privateKey: Buffer // 32 bytes
}

export interface X25519KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export interface DeviceKeyBundle {
  /** X25519 keypair for E2E secure channel. */
  transport: RawKeyPair
  /** Ed25519 keypair for control server attestation and receipts. */
  signing: RawKeyPair
}

/** Generate a fresh 32-byte random X25519 keypair. */
export function generateX25519KeyPair(): RawKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const rawPublic = extractRawPublicKey(publicKey, X25519_SPKI_PREFIX)
  const rawPrivate = extractRawPrivateKey(privateKey, X25519_PKCS8_PREFIX)
  return { publicKey: rawPublic, privateKey: rawPrivate }
}

/** Generate a fresh X25519 key pair with Uint8Array keys. */
export function generateKeyPair(): X25519KeyPair {
  const kp = generateX25519KeyPair()
  return {
    publicKey: new Uint8Array(kp.publicKey),
    privateKey: new Uint8Array(kp.privateKey)
  }
}


/** Generate a fresh 32-byte random Ed25519 keypair. */
export function generateEd25519KeyPair(): RawKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const rawPublic = extractRawPublicKey(publicKey, ED25519_SPKI_PREFIX)
  const rawPrivate = extractRawPrivateKey(privateKey, ED25519_PKCS8_PREFIX)
  return { publicKey: rawPublic, privateKey: rawPrivate }
}

/** Generate full device key bundle. */
export function generateDeviceKeyBundle(): DeviceKeyBundle {
  return {
    transport: generateX25519KeyPair(),
    signing: generateEd25519KeyPair()
  }
}

/** Convert raw 32-byte X25519 public key to Node KeyObject. */
export function rawX25519PublicToKeyObject(raw: Buffer | Uint8Array): KeyObject {
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`Invalid X25519 public key length: expected ${PUBLIC_KEY_BYTES}, got ${raw.length}`)
  }
  const der = Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)])
  return createPublicKey({ key: der, format: 'der', type: 'spki' })
}

/** Convert raw 32-byte X25519 private key to Node KeyObject. */
export function rawX25519PrivateToKeyObject(raw: Buffer | Uint8Array): KeyObject {
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`Invalid X25519 private key length: expected ${PUBLIC_KEY_BYTES}, got ${raw.length}`)
  }
  const der = Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(raw)])
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

/** Derive the X25519 public key for a 32-byte private scalar. */
export function publicKeyFromPrivate(privateKey: Uint8Array | Buffer): Uint8Array {
  const privKeyObj = rawX25519PrivateToKeyObject(privateKey)
  const jwk = privKeyObj.export({ format: 'jwk' })
  if (!jwk.x) {
    throw new Error('failed to derive X25519 public key')
  }
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'))
}

/** Convert raw 32-byte Ed25519 public key to Node KeyObject. */
export function rawEd25519PublicToKeyObject(raw: Buffer | Uint8Array): KeyObject {
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`Invalid Ed25519 public key length: expected ${PUBLIC_KEY_BYTES}, got ${raw.length}`)
  }
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)])
  return createPublicKey({ key: der, format: 'der', type: 'spki' })
}

/** Convert raw 32-byte Ed25519 private key to Node KeyObject. */
export function rawEd25519PrivateToKeyObject(raw: Buffer | Uint8Array): KeyObject {
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`Invalid Ed25519 private key length: expected ${PUBLIC_KEY_BYTES}, got ${raw.length}`)
  }
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(raw)])
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

/** Perform X25519 ECDH calculation to compute shared secret (32 bytes). */
export function computeSharedSecret(
  localPrivateKey: Buffer | Uint8Array,
  peerPublicKey: Buffer | Uint8Array
): Buffer {
  const privKeyObj = rawX25519PrivateToKeyObject(localPrivateKey)
  const pubKeyObj = rawX25519PublicToKeyObject(peerPublicKey)
  return diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyObj })
}

/** X25519 Diffie-Hellman returning Uint8Array. */
export function dh(
  privateKey: Uint8Array | Buffer,
  peerPublicKey: Uint8Array | Buffer
): Uint8Array {
  return new Uint8Array(computeSharedSecret(privateKey, peerPublicKey))
}

/** Sign data using Ed25519 private key (returns 64-byte signature). */
export function signEd25519(
  data: Buffer | Uint8Array | string,
  privateKey: Buffer | Uint8Array
): Buffer {
  const privKeyObj = rawEd25519PrivateToKeyObject(privateKey)
  const dataBuf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data)
  return sign(null, dataBuf, privKeyObj)
}

/** Verify Ed25519 signature over data. */
export function verifyEd25519(
  data: Buffer | Uint8Array | string,
  signature: Buffer | Uint8Array,
  publicKey: Buffer | Uint8Array
): boolean {
  try {
    const pubKeyObj = rawEd25519PublicToKeyObject(publicKey)
    const dataBuf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data)
    const sigBuf = Buffer.from(signature)
    return verify(null, dataBuf, pubKeyObj, sigBuf)
  } catch {
    return false
  }
}

/** Generate a friendly human-readable fingerprint of a public key. */
export function computeFingerprint(publicKey: Buffer | Uint8Array | string): string {
  const buf = typeof publicKey === 'string' ? Buffer.from(publicKey, 'base64') : Buffer.from(publicKey)
  const hash = createHash('sha256').update(buf).digest('hex').toUpperCase()
  // Format as 4 groups of 4 hex characters: e.g. "A1B2-C3D4-E5F6-7890"
  return `${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}`
}

/** Constant-time equality for byte arrays. */
export function timingSafeEqual(a: Uint8Array | Buffer, b: Uint8Array | Buffer): boolean {
  if (a.byteLength !== b.byteLength) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

/** Generate secure random bytes (e.g. for pairing secrets, salts, nonces). */
export function secureRandomBytes(size: number): Buffer {
  return randomBytes(size)
}

export function randomKeyBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length))
}

function extractRawPublicKey(key: KeyObject, prefix: Buffer): Buffer {
  const der = key.export({ type: 'spki', format: 'der' })
  if (der.length !== prefix.length + PUBLIC_KEY_BYTES || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new Error('Unexpected DER format for public key')
  }
  return der.subarray(prefix.length)
}

function extractRawPrivateKey(key: KeyObject, prefix: Buffer): Buffer {
  const der = key.export({ type: 'pkcs8', format: 'der' })
  if (der.length !== prefix.length + PUBLIC_KEY_BYTES || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new Error('Unexpected DER format for private key')
  }
  return der.subarray(prefix.length)
}
