/**
 * Returns a normalized http(s) URL string, or null for anything else
 * (file:, javascript:, custom schemes, malformed input).
 */
export function toSafeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.toString()
}

/** Opens the URL externally only if it is http(s); logs and denies otherwise. */
export async function openExternalSafely(
  open: (url: string) => Promise<void>,
  value: unknown,
  context: string
): Promise<boolean> {
  const url = toSafeExternalUrl(value)
  if (!url) {
    console.warn(`[${context}] blocked non-http(s) external URL`)
    return false
  }
  try {
    await open(url)
    return true
  } catch (error) {
    console.warn(`[${context}] failed to open external URL:`, error)
    return false
  }
}
