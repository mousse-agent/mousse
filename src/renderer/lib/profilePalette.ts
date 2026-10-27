/** The eight colours shared by the account avatar and the profile colour dots. */
export const PROFILE_SWATCHES = [
  { name: 'Slate', color: '#4d6088' },
  { name: 'Violet', color: '#604880' },
  { name: 'Teal', color: '#2f7a6a' },
  { name: 'Copper', color: '#8a5a3c' },
  { name: 'Plum', color: '#7a3f5c' },
  { name: 'Steel', color: '#3f6f8a' },
  { name: 'Olive', color: '#6b7a2f' },
  { name: 'Indigo', color: '#5a4d88' }
] as const

export const PROFILE_PALETTE: readonly string[] = PROFILE_SWATCHES.map((swatch) => swatch.color)

/** A stable palette colour for a string, so one account or profile always gets the same one. */
export function paletteColorFor(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PROFILE_PALETTE[hash % PROFILE_PALETTE.length]!
}

/** The stored colour of a profile, or undefined to use the accent gradient. */
export const profileColor = (profile: { color?: string }): string | undefined => profile.color || undefined

/** The first palette colour no profile uses yet, so a new profile starts out distinct. */
export function nextProfileColor(profiles: ReadonlyArray<{ color?: string }>): string {
  const taken = new Set(profiles.map((profile) => profile.color?.toLowerCase()))
  return PROFILE_PALETTE.find((color) => !taken.has(color)) ?? PROFILE_PALETTE[profiles.length % PROFILE_PALETTE.length]!
}
