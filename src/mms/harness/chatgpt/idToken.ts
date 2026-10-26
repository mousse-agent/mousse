import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
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
  const unverified = () => new ChatGptAuthError('signed_out', 'verify', MESSAGES.verify)
  let claims: JWTPayload
  try {
    claims = (await jwtVerify(idToken, expected.keys, {
      issuer: expected.issuer,
      audience: expected.clientId,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 5,
      requiredClaims: ['sub', 'exp', 'nonce']
    })).payload
  } catch {
    throw unverified()
  }
  // The token must belong to this attempt and name an account.
  const subject = typeof claims.sub === 'string' ? claims.sub : ''
  if (claims.nonce !== expected.nonce || subject === '') throw unverified()
  const email = typeof claims.email === 'string' && claims.email !== '' ? claims.email : null
  return { subject, email }
}
