import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  encodePairingQrUri,
  parsePairingQrUri,
  validateQrPayload
} from '../src/mms/control/pairing/pairingQr'
import type { QrV2Payload } from '../src/shared/controlTypes'
import { generateQrMatrix, qrMatrixToSvg } from '../src/shared/qrCode'

describe('Control Protocol 2.0 - QR v2 Validation and Parsing', () => {
  const validPayload: QrV2Payload = {
    v: 2,
    mode: 'hosted',
    controlOrigin: 'https://control.mousse.plus',
    installationId: 'inst-test-1234',
    installationPublicKey: randomBytes(32).toString('base64url'),
    mmsDeviceId: 'mms-dev-test-5678',
    mmsIdentityPublicKey: randomBytes(32).toString('base64url'),
    pairingId: 'pair-test-9999',
    expiresAt: Date.now() + 120_000,
    protocolMajor: 2,
    pairingSecret: randomBytes(32).toString('base64url'),
    accountId: 'usr-123'
  }

  it('encodes and parses a valid QR v2 URI canonically', () => {
    const uri = encodePairingQrUri(validPayload)
    expect(uri.startsWith('mousse://pair?v=2&data=')).toBe(true)

    const parsed = parsePairingQrUri(uri)
    expect(parsed.v).toBe(2)
    expect(parsed.mode).toBe('hosted')
    expect(parsed.controlOrigin).toBe(validPayload.controlOrigin)
    expect(parsed.mmsDeviceId).toBe(validPayload.mmsDeviceId)
    expect(parsed.pairingId).toBe(validPayload.pairingId)
    expect(parsed.pairingSecret).toBe(validPayload.pairingSecret)
    expect(parsed.accountId).toBe(validPayload.accountId)
  })

  it('rejects URIs with scheme other than mousse://pair', () => {
    const uri = encodePairingQrUri(validPayload).replace('mousse://pair', 'https://example.com/pair')
    expect(() => parsePairingQrUri(uri)).toThrow(/Invalid QR scheme/)
  })

  it('rejects unsupported major versions (!= 2)', () => {
    const invalidVersion = { ...validPayload, v: 3 as any }
    expect(() => validateQrPayload(invalidVersion)).toThrow(/Unsupported QR payload version/)
  })

  it('rejects expired payloads', () => {
    const expiredPayload = { ...validPayload, expiresAt: Date.now() - 5000 }
    expect(() => validateQrPayload(expiredPayload)).toThrow(/Pairing QR code has expired/)
  })

  it('rejects keys that are not 32 bytes base64', () => {
    const invalidKey = {
      ...validPayload,
      mmsIdentityPublicKey: Buffer.from('short-key').toString('base64url')
    }
    expect(() => validateQrPayload(invalidKey)).toThrow(/Invalid public key length/)
  })

  it('rejects secrets that are not 32 bytes base64', () => {
    const invalidSecret = {
      ...validPayload,
      pairingSecret: Buffer.from('too-short-secret').toString('base64url')
    }
    expect(() => validateQrPayload(invalidSecret)).toThrow(/Invalid pairing secret length/)
  })

  it('rejects oversized payloads (> 4096 bytes)', () => {
    const hugePayload = {
      ...validPayload,
      installationId: 'A'.repeat(5000)
    }
    expect(() => encodePairingQrUri(hugePayload)).toThrow(/exceeds maximum allowed/)
  })

  it('ensures no owner token, session token, or account password is present in QR payload', () => {
    const json = JSON.stringify(validPayload)
    expect(json).not.toContain('ownerToken')
    expect(json).not.toContain('sessionToken')
    expect(json).not.toContain('accessToken')
    expect(json).not.toContain('password')
    expect(json).not.toContain('secretKey')
  })

  it('generates QR Model 2 matrix and SVG string without errors', () => {
    const uri = encodePairingQrUri(validPayload)
    const matrix = generateQrMatrix(uri)

    expect(matrix.length).toBeGreaterThanOrEqual(21)
    expect(matrix[0].length).toBe(matrix.length)

    const svg = qrMatrixToSvg(matrix)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('viewBox')
  })
})
