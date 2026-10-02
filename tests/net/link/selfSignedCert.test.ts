import { readFileSync } from 'node:fs'
import { X509Certificate, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateSelfSignedCert, certFromExistingKey, encodeDerLength, fingerprint, transportKeyFromCertificate } from '../../../src/mms/net/link/selfSignedCert'

describe('transport certificate', () => {
  it('parses, self-verifies and preserves its P-256 SPKI in PEM and DER', () => {
    const generated = generateSelfSignedCert('nod-test')
    const cert = new X509Certificate(generated.cert)
    expect(cert.subject).toBe('CN=nod-test')
    expect(cert.verify(cert.publicKey)).toBe(true)
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    expect(transportKeyFromCertificate(generated.cert)).toEqual(generated.publicKeySpki)
    expect(transportKeyFromCertificate(cert.raw)).toEqual(generated.publicKeySpki)
    expect(fingerprint(generated.publicKeySpki)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
  it('rejects a real RSA certificate even when its fingerprint could be pinned', () => {
    // Public negative fixture, generated for tests; no production key material.
    const pem = readFileSync(new URL('./fixtures/rsa-cert.pem', import.meta.url), 'utf8')
    expect(new X509Certificate(pem).publicKey.asymmetricKeyType).toBe('rsa')
    expect(() => transportKeyFromCertificate(pem)).toThrow('Peer transport keys must be ECDSA P-256')
  })
  it('renews a certificate without changing the key', () => {
    const a = generateSelfSignedCert('node-a')
    const b = certFromExistingKey(a.key, 'node-b')
    expect(b.cert).not.toBe(a.cert)
    expect(b.publicKeySpki).toEqual(a.publicKeySpki)
    expect(new X509Certificate(b.cert).subject).toBe('CN=node-b')
  })
  it.each([[0, [0]], [127, [127]], [128, [129, 128]], [255, [129, 255]], [256, [130, 1, 0]], [65536, [131, 1, 0, 0]]])('encodes DER length %d minimally', (length, bytes) => {
    expect([...encodeDerLength(length as number)]).toEqual(bytes)
  })
  it('rejects invalid names, lengths and non-P256 keys', () => {
    expect(() => generateSelfSignedCert('')).toThrow(RangeError)
    expect(() => generateSelfSignedCert('x'.repeat(65))).toThrow(RangeError)
    for (const length of [-1, 0.5, Infinity]) expect(() => encodeDerLength(length)).toThrow(RangeError)
    const { privateKey } = generateKeyPairSync('ed25519')
    expect(() => certFromExistingKey(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), 'node')).toThrow(TypeError)
  })
})
