import { defaultAgentSettings } from '../../../shared/agents/defaults'
import type { AgentDefinitionIssue } from '../../../shared/agents/errors'
import type { AgentDefinitionSettings, AgentRuntimeKind } from '../../../shared/agents/types'
import type { AgentEditorCatalogs } from './client'

export interface EditorFieldIssue {
  pointer: string
  fieldId: string
  message: string
  blocking: boolean
}

const CLI_UNSUPPORTED_POINTERS = [
  '/settings/primaryModel/capabilityOverrides',
  '/settings/fallbacks',
  '/settings/output/jsonSchema',
  '/settings/memory',
  '/settings/skills',
  '/settings/mcp',
  '/settings/browser',
  '/settings/delegation',
  '/settings/script',
  '/settings/recovery'
] as const

export function fieldIdForPointer(pointer: string): string {
  return `agent-field${pointer.replaceAll('/', '-')}`
}

export function settingUnsupportedReason(runtimeKind: AgentRuntimeKind, pointer: string): string | null {
  if (runtimeKind === 'mousse') return null
  const match = CLI_UNSUPPORTED_POINTERS.find((entry) => pointer === entry || pointer.startsWith(`${entry}/`))
  if (!match) return null
  return `${runtimeKind} does not support this setting. CLI adapters publish a compatibility report; unsupported controls are rejected rather than guaranteed.`
}

export function isSettingSupported(runtimeKind: AgentRuntimeKind, pointer: string): boolean {
  return settingUnsupportedReason(runtimeKind, pointer) == null
}

function pointerValue(settings: AgentDefinitionSettings, pointer: string): unknown {
  const path = pointer.replace(/^\//, '').split('/')
  if (path[0] !== 'settings') return undefined
  let current: unknown = settings
  for (const segment of path.slice(1)) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function collectUnsupportedCliSettingPointers(
  runtimeKind: AgentRuntimeKind,
  settings: AgentDefinitionSettings
): string[] {
  if (runtimeKind === 'mousse') return []
  const defaults = defaultAgentSettings({ name: 'default', slug: 'default' })
  const used: string[] = []
  for (const pointer of CLI_UNSUPPORTED_POINTERS) {
    if (JSON.stringify(pointerValue(settings, pointer) ?? null) !== JSON.stringify(pointerValue(defaults, pointer) ?? null)) {
      used.push(pointer)
    }
  }
  return used
}

export function findModelInCatalog(
  catalogs: AgentEditorCatalogs,
  providerId: string,
  modelId: string
): { providerLabel: string; modelLabel: string } | null {
  const provider = catalogs.providers.find((entry) => entry.id === providerId)
  const model = provider?.models.find((entry) => entry.id === modelId)
  if (!provider || !model) return null
  return { providerLabel: provider.label, modelLabel: model.label }
}

export function collectEditorIssues(input: {
  runtimeKind: AgentRuntimeKind
  settings: AgentDefinitionSettings
  catalogs: AgentEditorCatalogs
  serverIssues?: AgentDefinitionIssue[]
}): EditorFieldIssue[] {
  const issues: EditorFieldIssue[] = []
  const ref = input.settings.primaryModel.ref
  if (!ref.providerId || !ref.modelId) {
    issues.push({
      pointer: '/settings/primaryModel/ref',
      fieldId: fieldIdForPointer('/settings/primaryModel'),
      message: 'Choose a model before publishing or running.',
      blocking: true
    })
  } else if (!findModelInCatalog(input.catalogs, ref.providerId, ref.modelId)) {
    issues.push({
      pointer: '/settings/primaryModel/ref',
      fieldId: fieldIdForPointer('/settings/primaryModel'),
      message: `Selected model ${ref.providerId}/${ref.modelId} is not in the shared catalog.`,
      blocking: true
    })
  }

  for (const pointer of collectUnsupportedCliSettingPointers(input.runtimeKind, input.settings)) {
    issues.push({
      pointer,
      fieldId: fieldIdForPointer(pointer),
      message: settingUnsupportedReason(input.runtimeKind, pointer) ?? 'Unsupported for this runtime.',
      blocking: true
    })
  }

  for (const issue of input.serverIssues ?? []) {
    const pointer = issue.pointer ?? '/settings'
    issues.push({
      pointer,
      fieldId: fieldIdForPointer(pointer),
      message: issue.message,
      blocking:
        issue.code === 'MODEL_CAPABILITY_MISSING' ||
        issue.code === 'DEPENDENCY_MISSING' ||
        issue.code === 'SETTINGS_UNSUPPORTED'
    })
  }

  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.pointer}:${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function slugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'agent'
}
