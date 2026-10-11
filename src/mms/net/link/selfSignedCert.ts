/**
 * Self-signed X.509 v3 certificates for node transport keys (ECDSA P-256).
 *
 * The certificate is only a carrier for the public key: peers never validate a
 * chain, they pin the SPKI fingerprint (see secureChannel.ts). So the encoder is
 * deliberately minimal: no extensions, one RDN with the common name, and a long
 * validity so nodes never have to rotate a certificate for expiry.
 */
import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { Base64Url } from '../../../shared/net'

export interface GeneratedCertificate {
  /** PEM. */
  cert: string
  /** PEM, PKCS#8. */
  key: string
  /** SubjectPublicKeyInfo DER of the certificate's key. */
  publicKeySpki: Uint8Array
}

export interface CertificateOptions {
  /** Wall clock used for the validity window, ms. Defaults to `Date.now()`. */
  now?: number
  /** Validity after `now`, in days. Defaults to 36500 (100 years). */
  validityDays?: number
}

const DAY_MS = 86_400_000
const DEFAULT_VALIDITY_DAYS = 36_500
/** `ub-common-name` from RFC 5280. */
const MAX_COMMON_NAME_CHARS = 64

// ---------------------------------------------------------------- DER

/** DER length octets: short form below 128, otherwise long form with the fewest bytes. */
export function encodeDerLength(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0)
    throw new RangeError(`Invalid DER length: ${length}`)
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), encodeDerLength(body.length), body])
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts)
const set = (...parts: Buffer[]) => tlv(0x31, ...parts)
const oid = (hex: string) => tlv(0x06, Buffer.from(hex, 'hex'))
const utf8String = (value: string) => tlv(0x0c, Buffer.from(value, 'utf8'))
const bitString = (bytes: Buffer) => tlv(0x03, Buffer.from([0]), bytes)

/** Minimal two's complement INTEGER from unsigned big-endian bytes. */
function unsignedInteger(bytes: Buffer): Buffer {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1
  const trimmed = bytes.subarray(start)
  return tlv(0x02, trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}

/** RFC 5280: UTCTime through 2049, GeneralizedTime from 2050. */
function time(ms: number): Buffer {
  const iso = new Date(ms).toISOString()
  const digits = iso.replace(/[-:T]/g, '').slice(0, 14)
  const year = Number(iso.slice(0, 4))
  if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(`${digits.slice(2)}Z`))
  return tlv(0x18, Buffer.from(`${digits}Z`))
}

// 1.2.840.10045.4.3.2 ecdsa-with-SHA256
const ECDSA_WITH_SHA256 = sequence(oid('2a8648ce3d040302'))
// 2.5.4.3 commonName
const COMMON_NAME_OID = oid('550403')

function toPem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

function buildCertificate(
  privateKey: KeyObject,
  commonName: string,
  options: CertificateOptions
): GeneratedCertificate {
  if (commonName.length === 0 || commonName.length > MAX_COMMON_NAME_CHARS) {
    throw new RangeError(`Certificate common name must be 1-${MAX_COMMON_NAME_CHARS} characters`)
  }
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const now = options.now ?? Date.now()
  const notBefore = now - DAY_MS
  const notAfter = now + (options.validityDays ?? DEFAULT_VALIDITY_DAYS) * DAY_MS

  const name = sequence(set(sequence(COMMON_NAME_OID, utf8String(commonName))))
  // 127 random bits: positive, and the non-zero first byte keeps the encoding minimal.
  const serial = randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 0x40
  const tbs = sequence(
    tlv(0xa0, unsignedInteger(Buffer.from([2]))),
    unsignedInteger(serial),
    ECDSA_WITH_SHA256,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    spki
  )
  const signature = createSign('sha256').update(tbs).sign(privateKey)
  const der = sequence(tbs, ECDSA_WITH_SHA256, bitString(signature))
  return {
    cert: toPem('CERTIFICATE', der),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeySpki: new Uint8Array(spki)
  }
}

// ---------------------------------------------------------------- public API

/** Generates a fresh ECDSA P-256 key pair and a self-signed certificate for it. */
export function generateSelfSignedCert(
  commonName: string,
  options: CertificateOptions = {}
): GeneratedCertificate {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return buildCertificate(privateKey, commonName, options)
}

/** New certificate (new serial and validity) for a key that already exists. */
export function certFromExistingKey(
  privateKeyPem: string,
  commonName: string,
  options: CertificateOptions = {}
): GeneratedCertificate {
  const privateKey = createPrivateKey(privateKeyPem)
  if (
    privateKey.asymmetricKeyType !== 'ec' ||
    privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new TypeError('Transport keys must be ECDSA P-256')
  }
  return buildCertificate(privateKey, commonName, options)
}

/** SPKI DER of the key inside a certificate given as raw DER bytes or as PEM. */
export function transportKeyFromCertificate(certificate: Uint8Array | string): Uint8Array {
  const parsed = new X509Certificate(
    typeof certificate === 'string' ? certificate : Buffer.from(certificate)
  )
  if (
    parsed.publicKey.asymmetricKeyType !== 'ec' ||
    parsed.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new TypeError('Peer transport keys must be ECDSA P-256')
  }
  return new Uint8Array(parsed.publicKey.export({ type: 'spki', format: 'der' }))
}

/** SHA-256 of the SPKI DER, base64url without padding. This is what peers pin. */
export function fingerprint(spki: Uint8Array): Base64Url {
  return createHash('sha256').update(spki).digest('base64url')
}
