// Ported from @earendil-works/pi-ai 1.4.0 `dist/auth/oauth/pkce.js` (MIT, Copyright (c) Mario Zechner),
// rewritten for Node's crypto with the 64-byte verifier the Sign in with ChatGPT docs recommend.
// See THIRD_PARTY_NOTICES.md.

import { createHash, randomBytes } from 'node:crypto'

/** A PKCE pair: a 64-byte random verifier and its S256 challenge, both base64url. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** A fresh 32-byte value for `state` and `nonce`. */
export function randomValue(): string {
  return randomBytes(32).toString('base64url')
}
