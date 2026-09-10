/** C1 profile identity helpers. Stable UUID v4; display names and slugs may change. */

export const PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const PROFILE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const DEFAULT_PROFILE_SLUG = 'default'
export const DEFAULT_PROFILE_DISPLAY_NAME = 'Default'

const UUID_ANY_VERSION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ProfileId = string & { readonly __brand: 'ProfileId' }

export function canonicalizeProfileId(value: string): ProfileId {
  const trimmed = value.trim().toLowerCase()
  if (!PROFILE_ID_PATTERN.test(trimmed)) {
    throw new Error(`Invalid profile id: ${value}`)
  }
  return trimmed as ProfileId
}

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value.trim().toLowerCase())
}

export function looksLikeUuid(value: string): boolean {
  return UUID_ANY_VERSION.test(value.trim())
}

export function canonicalizeProfileSlug(value: string): string {
  const slug = value.trim().toLowerCase()
  if (slug.length < 1 || slug.length > 64 || !PROFILE_SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid profile slug: ${value}`)
  }
  if (looksLikeUuid(slug)) {
    throw new Error('Profile slug must not be a UUID')
  }
  return slug
}

export function isReservedProfileSlug(slug: string): boolean {
  return slug === DEFAULT_PROFILE_SLUG
}
