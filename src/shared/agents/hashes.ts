import { createHash } from 'node:crypto'
import type { AgentDefinitionSettings, AgentVisualMetadata } from './types'

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key])
    }
    return sorted
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

export interface SemanticHashInput {
  id: string
  runtimeKind: string
  settings: AgentDefinitionSettings
  systemPrompt: string
}

export function computeSemanticHash(input: SemanticHashInput): string {
  return sha256Hex(
    canonicalJson({
      id: input.id,
      runtimeKind: input.runtimeKind,
      settings: input.settings,
      systemPrompt: input.systemPrompt
    })
  )
}

export function computeVisualHash(visual: AgentVisualMetadata | undefined): string {
  return sha256Hex(canonicalJson(visual ?? {}))
}

export function computeDraftHash(input: SemanticHashInput & { visual: AgentVisualMetadata; flags: unknown }): string {
  return sha256Hex(
    canonicalJson({
      semantic: {
        id: input.id,
        runtimeKind: input.runtimeKind,
        settings: input.settings,
        systemPrompt: input.systemPrompt
      },
      visual: input.visual ?? {},
      flags: input.flags
    })
  )
}
