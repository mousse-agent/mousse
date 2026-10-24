import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Electron's node:crypto is built on BoringSSL, which has no ChaCha20-Poly1305 cipher.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const unknown = (name: string) => {
    if (/chacha20/i.test(name)) throw new Error('Unknown cipher')
  }
  return {
    ...actual,
    createCipheriv: (name: string, ...rest: unknown[]) => {
      unknown(name)
      return (actual.createCipheriv as (...args: unknown[]) => unknown)(name, ...rest)
    },
    createDecipheriv: (name: string, ...rest: unknown[]) => {
      unknown(name)
      return (actual.createDecipheriv as (...args: unknown[]) => unknown)(name, ...rest)
    }
  }
})

const { openOfferSeal, openRequestSeal, sealInviteForOffer, sealInviteForRequest } = await import(
  '../../../src/mms/net/plus/enrollmentSeal'
)
const vectors = JSON.parse(
  readFileSync(join(__dirname, '../../../test-vectors/net/plus/enrollment-seal.json'), 'utf8')
)
const bytes = (value: string) => Buffer.from(value, 'base64url')

describe('Plus enrollment sealing without a ChaCha20 cipher in node:crypto', () => {
  it('still reproduces and opens the frozen request seal', () => {
    const v = vectors.requestSeal
    expect(
      sealInviteForRequest(vectors.invite, v.boxPublicKey, v.requestId, {
        ephemeralPrivateKey: bytes(v.ephemeralPrivateKey),
        nonce: bytes(v.nonce)
      })
    ).toBe(v.sealedInvite)
    expect(openRequestSeal(v.sealedInvite, bytes(v.boxPrivateKey), v.requestId)).toBe(vectors.invite)
  })

  it('still seals and opens an offer', () => {
    const key = new Uint8Array(32).fill(7)
    expect(openOfferSeal(sealInviteForOffer(vectors.invite, key), key)).toBe(vectors.invite)
  })
})
