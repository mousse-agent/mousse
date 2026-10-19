/**
 * Glass orb pictures for the voice carousel, one colour scheme each. Kokoro's voices get one orb
 * apiece in catalog order; provider voices are spread over the same orbs by name.
 */
const ORBS: readonly string[] = Object.entries(
  import.meta.glob<string>('../assets/voice-orbs/orb-*.webp', { eager: true, query: '?url', import: 'default' })
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url)

function hash(text: string): number {
  let value = 0
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) >>> 0
  return value
}

/** The orb for a voice. `index` is the voice's place in a local model's catalog, when it has one. */
export function voiceOrb(voiceId: string, index?: number): string | undefined {
  if (ORBS.length === 0) return undefined
  return ORBS[(index ?? hash(voiceId)) % ORBS.length]
}
