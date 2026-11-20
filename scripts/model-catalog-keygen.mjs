#!/usr/bin/env node
// Makes the model catalog's Ed25519 signing key (docs/providers/model-catalog.md, "One-time setup").
//
//   node scripts/model-catalog-keygen.mjs [--repo owner/name] [--dry-run]
//
// The private key goes straight to `gh secret set MODEL_CATALOG_SIGNING_KEY --env model-catalog`
// through stdin: it is never printed or written to disk. Only then is the public key printed, as
// the line to paste into MODEL_CATALOG_PUBLIC_KEYS (src/mms/models/catalogSignature.ts). Nothing else
// goes to stdout. --dry-run skips gh (for tests): the private key is discarded.
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const SECRET_NAME = 'MODEL_CATALOG_SIGNING_KEY'
export const ENVIRONMENT = 'model-catalog'

/**
 * A new key pair: the private key as the base64 text of its PKCS#8 DER form (what
 * `sign-model-catalog.mjs` reads), the public key as the base64 text of its raw 32 bytes.
 */
export function generateCatalogKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64')
  }
}

/** The public key as one element of MODEL_CATALOG_PUBLIC_KEYS. */
export function publicKeyLine(publicKey) {
  return `'${publicKey}',`
}

function parseArgs(argv) {
  const options = { dryRun: false, repo: undefined }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--repo' && argv[index + 1]) options.repo = argv[++index]
    else throw new Error(`Unknown argument: ${arg}. Usage: node scripts/model-catalog-keygen.mjs [--repo owner/name] [--dry-run]`)
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const { privateKey, publicKey } = generateCatalogKeyPair()
  if (options.dryRun) {
    process.stderr.write('Dry run: the private key was not saved anywhere.\n')
  } else {
    const args = ['secret', 'set', SECRET_NAME, '--env', ENVIRONMENT, ...(options.repo ? ['--repo', options.repo] : [])]
    // gh's own output goes to stderr, so stdout holds the public key alone.
    const result = spawnSync('gh', args, { input: privateKey, stdio: ['pipe', 2, 2] })
    if (result.error || result.status !== 0) {
      process.stderr.write(`gh secret set failed${result.error ? `: ${result.error.message}` : ''}. Nothing was saved; run this again.\n`)
      process.exit(1)
    }
    process.stderr.write(`Saved the private key as ${SECRET_NAME} in the ${ENVIRONMENT} environment.\n`)
  }
  process.stderr.write('Paste this line into MODEL_CATALOG_PUBLIC_KEYS in src/mms/models/catalogSignature.ts:\n')
  process.stdout.write(`${publicKeyLine(publicKey)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
