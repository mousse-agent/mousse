import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from 'node:crypto'
import { NetError } from '../../../shared/net'
import { decodeBase64, publicKeyFromRaw, rawPublicKey } from '../identity/crypto'

/**
 * Sealing of `mj1_` invites for phones that enroll through Mousse ID (contract §5,
 * docs/net/protocol.md "Phone enrollment through Mousse ID"). Mousse ID only ever stores the
 * resulting ciphertext. Frozen vectors: test-vectors/net/plus/enrollment-seal.json.
 */
export const ENROLL_SEAL_INFO = 'mousse-net/enroll-seal/v1'
export const ENROLL_OFFER_AAD = 'mousse-net/enroll-offer/v1'
export const ENROLL_MATCH_DOMAIN = 'mousse-net/enroll-match/v1'
/** Mousse ID rejects sealed invites above this size. */
export const SEALED_INVITE_MAX_BYTES = 16 * 1024
const NONCE = 12,
  TAG = 16,
  KEY = 32

function x25519Private(raw: Uint8Array) {
  if (raw.length !== KEY) throw new NetError('bad_request')
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]),
    format: 'der',
    type: 'pkcs8'
  })
}
// ChaCha20-Poly1305 comes from @noble/ciphers: Electron's BoringSSL build of node:crypto
// has no such cipher, so createCipheriv fails inside the packaged app.
function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  if (key.length !== KEY || nonce.length !== NONCE) throw new NetError('bad_request')
  return Buffer.from(chacha20poly1305(key, nonce, Buffer.from(aad, 'utf8')).encrypt(plaintext))
}
function open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  if (key.length !== KEY || nonce.length !== NONCE || sealed.length < TAG)
    throw new NetError('invite_invalid')
  try {
    return Buffer.from(chacha20poly1305(key, nonce, Buffer.from(aad, 'utf8')).decrypt(sealed))
  } catch {
    throw new NetError('invite_invalid')
  }
}
function checkedInvite(invite: string): Buffer {
  if (typeof invite !== 'string' || !invite.startsWith('mj1_')) throw new NetError('bad_request')
  return Buffer.from(invite, 'utf8')
}
function checkedSize(text: string): string {
  if (Buffer.byteLength(text) > SEALED_INVITE_MAX_BYTES) throw new NetError('too_large')
  return text
}
function requestKey(shared: Uint8Array, ephemeral: Uint8Array, box: Uint8Array): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephemeral, box]),
      Buffer.from(ENROLL_SEAL_INFO, 'utf8'),
      KEY
    )
  )
}
const requestAad = (requestId: string): string => `${ENROLL_SEAL_INFO}:${requestId}`

/** Seals an invite to a phone's X25519 `boxPublicKey` for one enrollment request. */
export function sealInviteForRequest(
  invite: string,
  boxPublicKey: string,
  requestId: string,
  fixed?: { ephemeralPrivateKey: Uint8Array; nonce: Uint8Array }
): string {
  const box = decodeBase64(boxPublicKey, KEY),
    ephemeral = fixed
      ? x25519Private(fixed.ephemeralPrivateKey)
      : generateKeyPairSync('x25519').privateKey,
    ephemeralPublic = decodeBase64(rawPublicKey(ephemeral), KEY),
    shared = diffieHellman({ privateKey: ephemeral, publicKey: publicKeyFromRaw(boxPublicKey, 'x25519') }),
    key = requestKey(shared, ephemeralPublic, box),
    nonce = fixed?.nonce ?? randomBytes(NONCE)
  try {
    return checkedSize(
      Buffer.concat([
        ephemeralPublic,
        nonce,
        seal(key, nonce, checkedInvite(invite), requestAad(requestId))
      ]).toString('base64url')
    )
  } finally {
    key.fill(0)
    shared.fill(0)
  }
}

/** The phone side of {@link sealInviteForRequest}; used by tests and conformance vectors. */
export function openRequestSeal(
  sealedInvite: string,
  boxPrivateKey: Uint8Array,
  requestId: string
): string {
  const bytes = decodeBase64(sealedInvite)
  if (bytes.length < KEY + NONCE + TAG) throw new NetError('invite_invalid')
  const privateKey = x25519Private(boxPrivateKey),
    box = decodeBase64(rawPublicKey(createPublicKey(privateKey)), KEY),
    ephemeral = bytes.subarray(0, KEY),
    shared = diffieHellman({
      privateKey,
      publicKey: publicKeyFromRaw(ephemeral.toString('base64url'), 'x25519')
    }),
    key = requestKey(shared, ephemeral, box)
  try {
    return open(key, bytes.subarray(KEY, KEY + NONCE), bytes.subarray(KEY + NONCE), requestAad(requestId)).toString('utf8')
  } finally {
    key.fill(0)
    shared.fill(0)
  }
}

/** Seals an invite with the QR-code key `K` for an enrollment offer. */
export function sealInviteForOffer(invite: string, key: Uint8Array, nonce?: Uint8Array): string {
  const iv = nonce ?? randomBytes(NONCE)
  return checkedSize(
    Buffer.concat([iv, seal(key, iv, checkedInvite(invite), ENROLL_OFFER_AAD)]).toString('base64url')
  )
}

export function openOfferSeal(sealedInvite: string, key: Uint8Array): string {
  const bytes = decodeBase64(sealedInvite)
  if (bytes.length < NONCE + TAG) throw new NetError('invite_invalid')
  return open(key, bytes.subarray(0, NONCE), bytes.subarray(NONCE), ENROLL_OFFER_AAD).toString('utf8')
}

/** Six digits both screens show so a person can spot a swapped key. Mousse ID never computes it. */
export function enrollmentMatchCode(boxPublicKey: string, transportFingerprint: string): string {
  const hash = createHash('sha256')
    .update(Buffer.from(ENROLL_MATCH_DOMAIN, 'utf8'))
    .update(Buffer.of(0))
    .update(decodeBase64(boxPublicKey, KEY))
    .update(Buffer.of(0))
    .update(Buffer.from(transportFingerprint, 'utf8'))
    .digest()
  return String(hash.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/** `mousse://net/join?...` payload for the QR code (contract §4). */
export function enrollmentJoinUrl(plusOrigin: string, offerId: string, key: Uint8Array): string {
  if (key.length !== KEY) throw new NetError('bad_request')
  const query = new URLSearchParams({
    v: '1',
    plus: plusOrigin,
    offer: offerId,
    key: Buffer.from(key).toString('base64url')
  })
  return `mousse://net/join?${query.toString()}`
}
