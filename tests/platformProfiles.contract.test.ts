import { describe, expect, it } from 'vitest'
import {
  assertFrozenContractInvariants,
  canonicalizeProfileId,
  CANONICALIZABLE_PROFILE_ID,
  classifyMousseConfKey,
  FIXTURE_PROFILE_A_ID,
  INVALID_PROFILE_IDS,
  INVALID_PROFILE_SLUGS,
  MOUSSE_CONF_INSTALLATION_KEYS,
  MOUSSE_CONF_PROFILE_KEYS,
  PATH_OWNERSHIP_RULES,
  PROFILE_CONTRACT_ID,
  PROFILE_CONTRACT_VERSION,
  canonicalizeProfileSlug
} from '../src/shared/profiles'

describe('C1 profile contract fixtures', () => {
  it('freezes identity, classification, and fixture invariants', () => {
    expect(PROFILE_CONTRACT_ID).toBe('C1')
    expect(PROFILE_CONTRACT_VERSION).toBe('1.0.0')
    expect(() => assertFrozenContractInvariants()).not.toThrow()
    expect(canonicalizeProfileId(CANONICALIZABLE_PROFILE_ID)).toBe(FIXTURE_PROFILE_A_ID)
  })

  it('rejects invalid profile identities and UUID-shaped slugs', () => {
    for (const value of INVALID_PROFILE_IDS) {
      expect(() => canonicalizeProfileId(value), value).toThrow(/Invalid profile id/)
    }
    for (const value of INVALID_PROFILE_SLUGS) {
      expect(() => canonicalizeProfileSlug(value), value).toThrow()
    }
  })

  it('keeps provider credentials and MMS infrastructure installation-scoped', () => {
    expect(classifyMousseConfKey('mms')).toBe('installation')
    expect(classifyMousseConfKey('features')).toBe('installation')
    expect(classifyMousseConfKey('providers')).toBe('profile')
    expect(classifyMousseConfKey('scheduled')).toBe('profile')
    expect(classifyMousseConfKey('channels')).toBe('profile')
    expect(classifyMousseConfKey('mystery')).toBe('unknown')
    expect(MOUSSE_CONF_INSTALLATION_KEYS).toEqual(['version', 'mms', 'features'])
    expect(MOUSSE_CONF_PROFILE_KEYS).toContain('agents')
    const auth = PATH_OWNERSHIP_RULES.find((rule) => rule.logicalName === 'auth.json')
    const owner = PATH_OWNERSHIP_RULES.find((rule) => rule.logicalName === 'mms.owner.json')
    const sock = PATH_OWNERSHIP_RULES.find((rule) => rule.logicalName === 'mms.sock')
    const control = PATH_OWNERSHIP_RULES.find((rule) => rule.logicalName === 'control/')
    expect(auth?.scope).toBe('installation')
    expect(auth?.preservedDuringMigration).toBe(true)
    expect(owner?.preservedDuringMigration).toBe(true)
    expect(sock?.preservedDuringMigration).toBe(true)
    expect(control?.scope).toBe('profile')
    expect(control?.notes).toMatch(/re-encrypted/)
  })
})
