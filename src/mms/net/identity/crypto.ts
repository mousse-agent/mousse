import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { NetError } from '../../../shared/net/errors'
import { validateSignedDocument } from '../../../shared/net/schemas'
import type { SignedDocumentKind } from '../../../shared/net/schemas'
import type { Base64Url, Signed } from '../../../shared/net/identity'
import { canonicalJson, parseProtocolJson } from '../sync/codec'
import { MAX_INLINE_ENVELOPE_BYTES } from '../../../shared/net/limits'

export function decodeBase64(value: string, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new NetError('bad_request', 'Invalid base64url encoding.')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length))
    throw new NetError('bad_request', 'Invalid encoded byte length.')
  return bytes
}

export function rawPublicKey(key: KeyObject): Base64Url {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key
  if (publicKey.asymmetricKeyType !== 'ed25519' && publicKey.asymmetricKeyType !== 'x25519')
    throw new NetError('bad_request', 'Expected an Ed25519 or X25519 key.')
  return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
}

export function publicKeyFromRaw(value: Base64Url, kind: 'ed25519' | 'x25519'): KeyObject {
  const prefix = kind === 'ed25519' ? '302a300506032b6570032100' : '302a300506032b656e032100'
  return createPublicKey({
    key: Buffer.concat([Buffer.from(prefix, 'hex'), decodeBase64(value, 32)]),
    format: 'der',
    type: 'spki'
  })
}

export function generateSigningKey(): { privateKey: string; publicKey: Base64Url } {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: rawPublicKey(pair.publicKey)
  }
}

export function signBytes(bytes: Uint8Array, privateKey: string): Uint8Array {
  return sign(null, bytes, createPrivateKey(privateKey))
}

export function verifyBytes(bytes: Uint8Array, signature: Uint8Array, publicKey: Base64Url): void {
  try {
    if (
      signature.length !== 64 ||
      !verify(null, bytes, publicKeyFromRaw(publicKey, 'ed25519'), signature)
    )
      throw new Error('Signature mismatch.')
  } catch (cause) {
    throw new NetError('bad_signature', undefined, { cause })
  }
}

export function signedDocument(value: unknown, signer: (bytes: Uint8Array) => Uint8Array): Signed {
  const bytes = canonicalJson(value)
  if (bytes.length > MAX_INLINE_ENVELOPE_BYTES) throw new NetError('too_large')
  return {
    payload: Buffer.from(bytes).toString('base64url'),
    sig: Buffer.from(signer(bytes)).toString('base64url')
  }
}

export function verifyDocument<T>(document: Signed, key: Base64Url, kind?: SignedDocumentKind): T {
  if (!validateSignedDocument('signed', document))
    throw new NetError('bad_request', 'Malformed signed wrapper.')
  const payload = decodeBase64(document.payload)
  if (payload.length > MAX_INLINE_ENVELOPE_BYTES) throw new NetError('too_large')
  verifyBytes(payload, decodeBase64(document.sig, 64), key)
  const value = parseProtocolJson(payload)
  if (kind && !validateSignedDocument(kind, value))
    throw new NetError('bad_delegation', 'Invalid signed identity document.')
  return value as T
}
