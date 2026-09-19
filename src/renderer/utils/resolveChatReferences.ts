import type { ChatReference } from '../../shared/chatReferences'
import { parseChatReference } from '../../shared/chatReferences'

/** Resolve daemon-owned resource metadata before it enters a composer or send payload. */
export async function resolveChatReference(reference: ChatReference): Promise<ChatReference> {
  const parsed = parseChatReference(reference)
  if (!parsed) throw new Error('This reference is incomplete or invalid.')
  if (parsed.kind !== 'project' && parsed.kind !== 'thread') return parsed
  const resolved = await window.mousse.chatReferences.resolve(parsed)
  if (!resolved) throw new Error(`The ${parsed.kind} “${parsed.title}” no longer exists in this profile.`)
  const validated = parseChatReference(resolved)
  if (!validated) throw new Error('Mousse returned invalid reference metadata.')
  return validated
}

export async function resolveChatReferences(references: ChatReference[]): Promise<ChatReference[]> {
  const resolved = await Promise.all(references.map(resolveChatReference))
  const seen = new Set<string>()
  return resolved.filter((reference) => {
    if (seen.has(reference.id)) return false
    seen.add(reference.id)
    return true
  })
}
