import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  enrollmentJoinUrl,
  enrollmentMatchCode,
  openOfferSeal,
  openRequestSeal,
  sealInviteForOffer,
  sealInviteForRequest,
  SEALED_INVITE_MAX_BYTES
} from '../../../src/mms/net/plus/enrollmentSeal'

const vectors = JSON.parse(
  readFileSync(join(__dirname, '../../../test-vectors/net/plus/enrollment-seal.json'), 'utf8')
)
const bytes = (value: string) => Buffer.from(value, 'base64url')

function boxPair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  return {
    privateKey: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).subarray(-32),
    publicKey: Buffer.from(publicKey.export({ format: 'der', type: 'spki' }))
      .subarray(-32)
      .toString('base64url')
  }
}

describe('Plus enrollment sealing vectors', () => {
  it('reproduces the frozen request seal and opens it', () => {
    const v = vectors.requestSeal
    expect(
      sealInviteForRequest(vectors.invite, v.boxPublicKey, v.requestId, {
        ephemeralPrivateKey: bytes(v.ephemeralPrivateKey),
        nonce: bytes(v.nonce)
      })
    ).toBe(v.sealedInvite)
    expect(openRequestSeal(v.sealedInvite, bytes(v.boxPrivateKey), v.requestId)).toBe(
      vectors.invite
    )
    expect(bytes(v.sealedInvite).subarray(0, 32).toString('base64url')).toBe(
      v.ephemeralPublicKey
    )
  })

  it('reproduces the frozen offer seal and join URL', () => {
    const v = vectors.offerSeal
    expect(sealInviteForOffer(vectors.invite, bytes(v.key), bytes(v.nonce))).toBe(v.sealedInvite)
    expect(openOfferSeal(v.sealedInvite, bytes(v.key))).toBe(vectors.invite)
    expect(enrollmentJoinUrl(v.plusOrigin, v.offerId, bytes(v.key))).toBe(v.joinUrl)
  })

  it('reproduces the frozen match code', () => {
    const v = vectors.matchCode
    expect(enrollmentMatchCode(v.boxPublicKey, v.transportFingerprint)).toBe(v.matchCode)
    expect(v.matchCode).toMatch(/^\d{6}$/)
  })

  it('rejects the listed tampering cases', () => {
    const r = vectors.requestSeal
    expect(() =>
      openRequestSeal(r.sealedInvite, bytes(r.boxPrivateKey), vectors.rejections[0].requestId)
    ).toThrow(expect.objectContaining({ code: 'invite_invalid' }))
    const flipped = bytes(vectors.offerSeal.sealedInvite)
    flipped[flipped.length - 1] ^= 1
    expect(() => openOfferSeal(flipped.toString('base64url'), bytes(vectors.offerSeal.key))).toThrow(
      expect.objectContaining({ code: 'invite_invalid' })
    )
    expect(() => openOfferSeal(vectors.offerSeal.sealedInvite, randomBytes(32))).toThrow(
      expect.objectContaining({ code: 'invite_invalid' })
    )
  })
})

describe('Plus enrollment sealing', () => {
  it('round-trips with fresh keys and never reuses a nonce', () => {
    const box = boxPair(),
      invite = 'mj1_' + randomBytes(600).toString('base64url')
    const a = sealInviteForRequest(invite, box.publicKey, 'req_a'),
      b = sealInviteForRequest(invite, box.publicKey, 'req_a')
    expect(a).not.toBe(b)
    expect(openRequestSeal(a, box.privateKey, 'req_a')).toBe(invite)
    expect(() => openRequestSeal(a, boxPair().privateKey, 'req_a')).toThrow(
      expect.objectContaining({ code: 'invite_invalid' })
    )
    const key = randomBytes(32)
    expect(openOfferSeal(sealInviteForOffer(invite, key), key)).toBe(invite)
  })

  it('refuses non-invites and oversized output', () => {
    const box = boxPair()
    expect(() => sealInviteForRequest('nope', box.publicKey, 'r')).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
    const huge = 'mj1_' + 'a'.repeat(SEALED_INVITE_MAX_BYTES)
    expect(() => sealInviteForOffer(huge, randomBytes(32))).toThrow(
      expect.objectContaining({ code: 'too_large' })
    )
  })

  it('changes the match code when either key changes', () => {
    const box = boxPair(),
      other = boxPair()
    const code = enrollmentMatchCode(box.publicKey, 'fp-a')
    expect(enrollmentMatchCode(other.publicKey, 'fp-a')).not.toBe(code)
    expect(enrollmentMatchCode(box.publicKey, 'fp-b')).not.toBe(code)
    // Sanity: the derived private key matches the exported public key.
    const pkcs8 = Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      box.privateKey
    ])
    expect(
      Buffer.from(
        createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({
          format: 'der',
          type: 'spki'
        })
      )
        .subarray(-32)
        .toString('base64url')
    ).toBe(box.publicKey)
  })
})
