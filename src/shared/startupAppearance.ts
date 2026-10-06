import { normalizeAppearance, type AppearanceSettings } from './settings'

const ARGUMENT_PREFIX = '--mousse-startup-appearance='

export function startupAppearanceArgument(appearance: AppearanceSettings): string {
  return ARGUMENT_PREFIX + encodeURIComponent(JSON.stringify(normalizeAppearance(appearance)))
}

export function readStartupAppearanceArgument(argv: string[]): AppearanceSettings | null {
  const argument = argv.find((value) => value.startsWith(ARGUMENT_PREFIX))
  if (!argument) return null
  try {
    const value = JSON.parse(decodeURIComponent(argument.slice(ARGUMENT_PREFIX.length)))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? normalizeAppearance(value)
      : null
  } catch {
    return null
  }
}
