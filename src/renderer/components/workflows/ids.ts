import { WORKFLOW_SLUG_PATTERN, isReservedWorkflowSlug } from '../../../shared/workflows'

export function newUuid(): string {
  const cryptoRef = globalThis.crypto
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16)
    const value = char === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

export function newNodeId(existing: Iterable<string>, prefix = 'node'): string {
  const used = new Set(existing)
  for (let i = 1; i < 10_000; i += 1) {
    const id = `${prefix}-${i}`
    if (!used.has(id)) return id
  }
  return `${prefix}-${newUuid().slice(0, 8)}`
}

export function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  if (!slug || !WORKFLOW_SLUG_PATTERN.test(slug)) return `wf_${Date.now().toString(36)}`
  if (isReservedWorkflowSlug(slug)) return `wf_${slug}`.slice(0, 64)
  return slug
}

export function uniqueSlug(slug: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((item) => item.toLowerCase()))
  if (!used.has(slug) && !isReservedWorkflowSlug(slug)) return slug
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${slug}_${i}`.slice(0, 64)
    if (!used.has(candidate) && !isReservedWorkflowSlug(candidate)) return candidate
  }
  return `wf_${newUuid().slice(0, 8)}`
}
