// Verification rules from T3 Code `apps/server/src/provider/CodexChatGptAuth.ts` (MIT,
// Copyright (c) 2026 T3 Tools Inc.). See THIRD_PARTY_NOTICES.md.

import { jwtVerify, type JWTVerifyGetKey } from 'jose'
import { ChatGptAuthError, MESSAGES } from './errors'

export interface VerifiedIdentity {
  /** The account's subject for this client registration. */
  subject: string
  email: string | null
}

/**
 * Verifies the ID token of a sign-in: signature against the issuer's keys, issuer, audience (the
 * issued client id), RS256 or ES256 only, expiry with 5 s of clock tolerance, and the attempt's nonce.
 */
export async function verifyIdToken(
  idToken: string,
  expected: { keys: JWTVerifyGetKey; issuer: string; clientId: string; nonce: string }
): Promise<VerifiedIdentity> {
  try {
    const { payload } = await jwtVerify(idToken, expected.keys, {
      issuer: expected.issuer,
      audience: expected.clientId,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 5,
      requiredClaims: ['sub', 'exp', 'nonce']
    })
    if (payload.nonce !== expected.nonce || typeof payload.sub !== 'string' || !payload.sub) throw new Error('identity')
    return { subject: payload.sub, email: typeof payload.email === 'string' && payload.email ? payload.email : null }
  } catch {
    throw new ChatGptAuthError('signed_out', 'verify', MESSAGES.verify)
  }
}
