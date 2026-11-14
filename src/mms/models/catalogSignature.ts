import { createPublicKey, verify, type KeyObject } from 'node:crypto'

/**
 * The signature of a published model catalog (`models-1.json.sig`, docs/providers/model-catalog.md,
 * "Publishing"): a detached Ed25519 signature over the file's exact bytes. The `.sig` file is the
 * raw 64-byte signature, with no encoding or line ending.
 *
 * This file imports only `node:crypto`, so the release scripts load it as is (Node strips the types):
 * `scripts/sign-model-catalog.mjs` checks every signature it writes against these keys.
 */

/** An Ed25519 signature is always this many bytes. */
export const MODEL_CATALOG_SIGNATURE_BYTES = 64

/**
 * Public keys a published catalog may be signed with: each one the base64 text of a raw 32-byte
 * Ed25519 key, as `scripts/model-catalog-keygen.mjs` prints it. There is room for two, so a new key
 * can ship in a release before the publish workflow switches to it; the old one is removed after.
 *
 * Empty until the owner generates the signing key (docs/providers/model-catalog.md, "One-time
 * setup"). With no key here, every signature is rejected, so no downloaded catalog is used.
 */
export const MODEL_CATALOG_PUBLIC_KEYS: readonly string[] = []

/** A key from the list as `node:crypto` takes it; undefined when it is not a 32-byte key. */
function publicKey(base64: string): KeyObject | undefined {
  const raw = Buffer.from(base64, 'base64')
  if (raw.length !== 32 || raw.toString('base64') !== base64) return undefined
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
  } catch {
    return undefined
  }
}

/**
 * Whether `signature` (the raw `.sig` bytes) is a valid Ed25519 signature of `bytes` by one of
 * `keys`. Fails closed: no key, a key that does not read, or a signature that is not 64 bytes is a
 * rejection, never an error.
 */
export function verifyModelCatalogSignature(
  bytes: Uint8Array,
  signature: Uint8Array,
  keys: readonly string[] = MODEL_CATALOG_PUBLIC_KEYS
): boolean {
  if (signature.length !== MODEL_CATALOG_SIGNATURE_BYTES) return false
  for (const base64 of keys) {
    const key = publicKey(base64)
    if (!key) continue
    try {
      if (verify(null, bytes, key, signature)) return true
    } catch {
      // A key or signature node:crypto cannot use counts as no match.
    }
  }
  return false
}
