import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MODEL_CATALOG_PUBLIC_KEYS, verifyModelCatalogSignature } from '../src/mms/models/catalogSignature'

function keyPair(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64') }
}

const bytes = Buffer.from('{"format":1,"revision":7,"models":[]}\n')
const signer = keyPair()
const signature = sign(null, bytes, signer.privateKey)

describe('verifyModelCatalogSignature', () => {
  it('accepts a signature by a listed key, in either slot', () => {
    expect(verifyModelCatalogSignature(bytes, signature, [signer.publicKey])).toBe(true)
    expect(verifyModelCatalogSignature(bytes, signature, [keyPair().publicKey, signer.publicKey])).toBe(true)
  })

  it('rejects bytes changed after signing', () => {
    const tampered = Buffer.from(bytes)
    tampered[tampered.length - 2] ^= 1
    expect(verifyModelCatalogSignature(tampered, signature, [signer.publicKey])).toBe(false)
  })

  it('rejects a signature by a key that is not listed', () => {
    expect(verifyModelCatalogSignature(bytes, signature, [keyPair().publicKey])).toBe(false)
  })

  it('rejects everything when no key is listed, as the shipped list is until the owner adds one', () => {
    expect(MODEL_CATALOG_PUBLIC_KEYS).toEqual([])
    expect(verifyModelCatalogSignature(bytes, signature)).toBe(false)
    expect(verifyModelCatalogSignature(bytes, signature, [])).toBe(false)
  })

  it('rejects a signature that is not 64 bytes', () => {
    expect(verifyModelCatalogSignature(bytes, signature.subarray(0, 63), [signer.publicKey])).toBe(false)
    expect(verifyModelCatalogSignature(bytes, Buffer.concat([signature, Buffer.from([0])]), [signer.publicKey])).toBe(false)
    // The base64 text of a good signature is not the raw bytes the .sig file holds.
    expect(verifyModelCatalogSignature(bytes, Buffer.from(signature.toString('base64')), [signer.publicKey])).toBe(false)
  })

  it('skips a key that does not read and still checks the others', () => {
    expect(verifyModelCatalogSignature(bytes, signature, ['not a key', 'AAAA', signer.publicKey])).toBe(true)
    expect(verifyModelCatalogSignature(bytes, signature, ['not a key'])).toBe(false)
  })
})
