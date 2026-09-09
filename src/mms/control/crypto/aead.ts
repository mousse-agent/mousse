/**
 * ChaCha20-Poly1305 AEAD and HKDF primitives for Control Protocol 2.0.
 * Complies with RFC 8439 and the Noise Protocol framework.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync
} from 'node:crypto'

export const AEAD_TAG_LENGTH = 16
export const AEAD_KEY_LENGTH = 32
export const AEAD_NONCE_LENGTH = 12

/**
 * Format an integer counter into a 12-byte IV according to Noise protocol specification:
 * 4 zero bytes followed by 8-byte little-endian unsigned integer.
 */
export function formatNoiseNonce(counter: bigint | number): Buffer {
  const buf = Buffer.alloc(AEAD_NONCE_LENGTH)
  const val = typeof counter === 'number' ? BigInt(counter) : counter
  buf.writeBigUInt64LE(val, 4)
  return buf
}

/**
 * Encrypt plaintext using ChaCha20-Poly1305 AEAD.
 * Returns ciphertext concatenated with the 16-byte authentication tag.
 */
export function encryptChaCha20Poly1305(
  key: Buffer | Uint8Array,
  nonce: Buffer | Uint8Array,
  plaintext: Buffer | Uint8Array,
  associatedData?: Buffer | Uint8Array
): Buffer {
  if (key.length !== AEAD_KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${AEAD_KEY_LENGTH}, got ${key.length}`)
  }
  if (nonce.length !== AEAD_NONCE_LENGTH) {
    throw new Error(`Invalid nonce length: expected ${AEAD_NONCE_LENGTH}, got ${nonce.length}`)
  }

  const cipher = createCipheriv('chacha20-poly1305', Buffer.from(key), Buffer.from(nonce), {
    authTagLength: AEAD_TAG_LENGTH
  })

  if (associatedData && associatedData.length > 0) {
    cipher.setAAD(Buffer.from(associatedData), { plaintextLength: plaintext.length })
  }

  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([ciphertext, tag])
}

/**
 * Decrypt ciphertext using ChaCha20-Poly1305 AEAD.
 * Input must include the trailing 16-byte authentication tag.
 * Throws if authentication fails or ciphertext was tampered with.
 */
export function decryptChaCha20Poly1305(
  key: Buffer | Uint8Array,
  nonce: Buffer | Uint8Array,
  ciphertextAndTag: Buffer | Uint8Array,
  associatedData?: Buffer | Uint8Array
): Buffer {
  if (key.length !== AEAD_KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${AEAD_KEY_LENGTH}, got ${key.length}`)
  }
  if (nonce.length !== AEAD_NONCE_LENGTH) {
    throw new Error(`Invalid nonce length: expected ${AEAD_NONCE_LENGTH}, got ${nonce.length}`)
  }
  if (ciphertextAndTag.length < AEAD_TAG_LENGTH) {
    throw new Error(`Ciphertext too short to contain auth tag: ${ciphertextAndTag.length} bytes`)
  }

  const inputBuf = Buffer.from(ciphertextAndTag)
  const ciphertext = inputBuf.subarray(0, inputBuf.length - AEAD_TAG_LENGTH)
  const tag = inputBuf.subarray(inputBuf.length - AEAD_TAG_LENGTH)

  const decipher = createDecipheriv('chacha20-poly1305', Buffer.from(key), Buffer.from(nonce), {
    authTagLength: AEAD_TAG_LENGTH
  })

  decipher.setAuthTag(tag)

  if (associatedData && associatedData.length > 0) {
    decipher.setAAD(Buffer.from(associatedData), { plaintextLength: ciphertext.length })
  }

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext
  } catch (err) {
    throw new Error(`AEAD authentication failure: invalid ciphertext or tag: ${(err as Error).message}`)
  }
}

/**
 * Derive cryptographic keys using HKDF-SHA256.
 */
export function deriveKeysHkdf(
  ikm: Buffer | Uint8Array,
  salt: Buffer | Uint8Array,
  info: Buffer | Uint8Array | string,
  length: number
): Buffer {
  const infoBuf = typeof info === 'string' ? Buffer.from(info, 'utf-8') : Buffer.from(info)
  const derived = hkdfSync('sha256', Buffer.from(ikm), Buffer.from(salt), infoBuf, length)
  return Buffer.from(derived)
}

/**
 * Compute HMAC-SHA256.
 */
export function hmacSha256(key: Buffer | Uint8Array, data: Buffer | Uint8Array): Buffer {
  return createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest()
}
