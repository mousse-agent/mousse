import { defaultAgentSettings } from './defaults'
import { canonicalJson } from './hashes'
import type { AgentDefinitionSettings, AgentRuntimeCompatibility, AgentRuntimeKind } from './types'

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

const NATIVE_SUPPORTED_POINTERS = [
  '/settings/identity',
  '/settings/instructions',
  '/settings/primaryModel',
  '/settings/fallbacks',
  '/settings/output',
  '/settings/context',
  '/settings/memory',
  '/settings/skills',
  '/settings/mcp',
  '/settings/tools',
  '/settings/browser',
  '/settings/delegation',
  '/settings/workspace',
  '/settings/script',
  '/settings/approval',
  '/settings/limits',
  '/settings/recovery',
  '/settings/examples'
] as const

export function getRuntimeCompatibility(runtimeKind: AgentRuntimeKind): AgentRuntimeCompatibility {
  if (runtimeKind === 'mousse') {
    return {
      runtimeKind,
      native: true,
      supportedSettingPointers: [...NATIVE_SUPPORTED_POINTERS],
      unsupportedSettingPointers: [],
      notes: ['Native Mousse supports the full definition settings model.']
    }
  }
  return {
    runtimeKind,
    native: false,
    supportedSettingPointers: [
      '/settings/identity',
      '/settings/instructions',
      '/settings/primaryModel/ref',
      '/settings/output/language',
      '/settings/output/tone',
      '/settings/output/verbosity',
      '/settings/tools',
      '/settings/workspace',
      '/settings/approval',
      '/settings/limits',
      '/settings/examples'
    ],
    unsupportedSettingPointers: [...CLI_UNSUPPORTED_POINTERS],
    notes: [
      `CLI adapter ${runtimeKind} publishes a compatibility report; unsupported controls are rejected rather than guaranteed.`,
      'Do not treat a saved CLI definition as a native Mousse agent loop.'
    ]
  }
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

function defaultValueForPointer(pointer: string): unknown {
  const defaults = defaultAgentSettings({ name: 'default', slug: 'default' })
  return pointerValue(defaults, pointer)
}

export function collectUnsupportedCliSettings(runtimeKind: AgentRuntimeKind, settings: AgentDefinitionSettings): string[] {
  const compatibility = getRuntimeCompatibility(runtimeKind)
  if (compatibility.native) return []
  const used: string[] = []
  for (const pointer of compatibility.unsupportedSettingPointers) {
    const actual = pointerValue(settings, pointer)
    const expected = defaultValueForPointer(pointer)
    if (canonicalJson(actual ?? null) !== canonicalJson(expected ?? null)) {
      used.push(pointer)
    }
  }
  return used
}
