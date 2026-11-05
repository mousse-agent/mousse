#!/usr/bin/env node
// Signs a model catalog file for publishing (docs/providers/model-catalog.md, "Publishing").
//
//   MODEL_CATALOG_SIGNING_KEY=<key> node scripts/sign-model-catalog.mjs <models-1.json>
//
// Writes <file>.sig: the raw 64-byte Ed25519 signature over the file's exact bytes. The key is the
// base64 PKCS#8 text that scripts/model-catalog-keygen.mjs saved as the secret. The signature is
// read back and checked against MODEL_CATALOG_PUBLIC_KEYS (src/mms/models/catalogSignature.ts), the
// keys installed builds trust; when none of them matches, no .sig is left and it exits 1.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { MODEL_CATALOG_PUBLIC_KEYS, verifyModelCatalogSignature } from '../src/mms/models/catalogSignature.ts'

/** The private key from its base64 PKCS#8 DER text; throws when it is not an Ed25519 key. */
function privateKeyOf(text) {
  const key = createPrivateKey({ key: Buffer.from(text.trim(), 'base64'), format: 'der', type: 'pkcs8' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('MODEL_CATALOG_SIGNING_KEY is not an Ed25519 key.')
  return key
}

/** The public key that goes with `privateKey`, as MODEL_CATALOG_PUBLIC_KEYS lists keys. */
function publicKeyOf(privateKey) {
  return Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url').toString('base64')
}

/**
 * Signs the file at `path` with `privateKeyText`, writes `<path>.sig` and checks it against `keys`.
 * Returns the signature path; throws (leaving no .sig) when the check fails.
 */
export function signCatalogFile(path, privateKeyText, keys = MODEL_CATALOG_PUBLIC_KEYS) {
  const privateKey = privateKeyOf(privateKeyText)
  const bytes = readFileSync(path)
  const sigPath = `${path}.sig`
  writeFileSync(sigPath, sign(null, bytes, privateKey))
  // Check what is on disk, against the keys installed builds trust.
  if (!verifyModelCatalogSignature(readFileSync(path), readFileSync(sigPath), keys)) {
    rmSync(sigPath, { force: true })
    const message = keys.length
      ? `The signature does not match any key in MODEL_CATALOG_PUBLIC_KEYS. This signing key's public key is ${publicKeyOf(privateKey)}.`
      : 'MODEL_CATALOG_PUBLIC_KEYS in src/mms/models/catalogSignature.ts is empty, so installed builds would reject any signature. Add the public key first.'
    throw new Error(message)
  }
  return sigPath
}

function main() {
  const [path, ...rest] = process.argv.slice(2)
  if (!path || rest.length) throw new Error('Usage: node scripts/sign-model-catalog.mjs <models-1.json>')
  const key = process.env.MODEL_CATALOG_SIGNING_KEY
  if (!key?.trim()) throw new Error('MODEL_CATALOG_SIGNING_KEY is not set.')
  const sigPath = signCatalogFile(path, key)
  console.log(`Signed ${path}; ${sigPath} checks against the public keys in code.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
