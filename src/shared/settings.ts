import type { MousseIntegrationsSettings, SkillModelSettings } from './integrations'
import type { ChatMode } from './types'
import { getSkillIdFromMode } from './chatMode'
import { generateRandomUsername } from './randomUsername'

export type ThemeId =
  | 'system'
  | 'dark'
  | 'light'
  | 'dark-acrylic'
  | 'light-acrylic'
  | 'system-acrylic'

export type LlmProviderId = string

export type AgentTypeId = 'mousse' | 'claude-code' | 'codex' | 'opencode' | 'cursor-agents-cli'

export interface AgentModelOption {
  id: string
  label: string
}

export interface MousseSettings {
  profile: {
    username: string
  }
  appearance: {
    theme: ThemeId
    accentColor: string
  }
  provider: {
    llmProvider: LlmProviderId
    model: string
  }
  agents: {
    enabled: Record<AgentTypeId, boolean>
    model: Record<AgentTypeId, string>
    headless: Record<AgentTypeId, boolean>
  }
  integrations: MousseIntegrationsSettings
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[]
    ? T[K]
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K]
}

export type MousseSettingsUpdate = DeepPartial<MousseSettings>

export interface ThemeOption {
  id: ThemeId
  label: string
  material: 'acrylic' | 'none'
}

export interface AccentColorOption {
  id: string
  label: string
  value: string
}

export interface LlmModelOption {
  id: string
  label: string
  /** Supported reasoning/effort levels from the provider (excludes "off"). */
  efforts?: string[]
}

export interface LlmProviderOption {
  id: LlmProviderId
  label: string
  models: LlmModelOption[]
}

export interface AgentTypeOption {
  id: AgentTypeId
  label: string
  models: AgentModelOption[]
}

export interface SettingsOptions {
  themes: ThemeOption[]
  accentColors: AccentColorOption[]
  llmProviders: LlmProviderOption[]
  agentTypes: AgentTypeOption[]
}

export const ACCENT_COLORS: AccentColorOption[] = [
  { id: 'purple', label: 'Purple', value: '#a785c7' },
  { id: 'violet', label: 'Violet', value: '#8a66b6' },
  { id: 'indigo', label: 'Indigo', value: '#6b5b95' },
  { id: 'blue', label: 'Blue', value: '#5b8def' },
  { id: 'cyan', label: 'Cyan', value: '#4ecdc4' },
  { id: 'teal', label: 'Teal', value: '#3d9970' },
  { id: 'green', label: 'Green', value: '#7ec99a' },
  { id: 'amber', label: 'Amber', value: '#d4b06a' },
  { id: 'rose', label: 'Rose', value: '#e07a8a' },
  { id: 'coral', label: 'Coral', value: '#e8927c' },
  { id: 'pink', label: 'Pink', value: '#d486b8' },
  { id: 'slate', label: 'Slate', value: '#8892a6' }
]

export const AGENT_MODELS: Record<AgentTypeId, AgentModelOption[]> = {
  mousse: [],
  'claude-code': [
    { id: 'sonnet', label: 'Claude Sonnet' },
    { id: 'opus', label: 'Claude Opus' },
    { id: 'haiku', label: 'Claude Haiku' },
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' }
  ],
  codex: [
    { id: 'o3', label: 'o3' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }
  ],
  opencode: [
    { id: 'opencode/big-pickle', label: 'Big Pickle (free)' },
    { id: 'openrouter/anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
    { id: 'openrouter/anthropic/claude-opus-4.6', label: 'Claude Opus 4.6' },
    { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
    { id: 'openai/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' }
  ],
  'cursor-agents-cli': [
    { id: 'composer-2.5', label: 'Composer 2.5' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { id: 'claude-4.5-sonnet-thinking', label: 'Claude 4.5 Sonnet' },
    { id: 'claude-4.5-opus-high-thinking', label: 'Claude 4.5 Opus' }
  ]
}

export const AGENT_TYPES: AgentTypeOption[] = [
  { id: 'mousse', label: 'Mousse', models: AGENT_MODELS.mousse },
  { id: 'claude-code', label: 'Claude Code', models: AGENT_MODELS['claude-code'] },
  { id: 'codex', label: 'Codex', models: AGENT_MODELS.codex },
  { id: 'opencode', label: 'OpenCode', models: AGENT_MODELS.opencode },
  { id: 'cursor-agents-cli', label: 'Cursor Agents CLI', models: AGENT_MODELS['cursor-agents-cli'] }
]

const DEFAULT_AGENT_INTEGRATION_ENABLEMENT: Record<AgentTypeId, boolean> = {
  mousse: true,
  'claude-code': true,
  codex: true,
  opencode: true,
  'cursor-agents-cli': true
}

const DEFAULT_AGENT_HEADLESS: Record<AgentTypeId, boolean> = {
  mousse: false,
  'claude-code': true,
  codex: true,
  opencode: true,
  'cursor-agents-cli': true
}

export function appendAgentModelFlag(
  baseCommand: string,
  cliType: AgentTypeId,
  model: string
): string {
  if (cliType === 'mousse') return baseCommand
  const trimmed = model.trim()
  if (!trimmed) return baseCommand

  const quoted = trimmed.includes(' ') ? `"${trimmed.replace(/"/g, '\\"')}"` : trimmed
  if (cliType === 'codex') {
    return `${baseCommand} -m ${quoted}`
  }
  return `${baseCommand} --model ${quoted}`
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'system', label: 'System', material: 'none' },
  { id: 'dark', label: 'Dark', material: 'none' },
  { id: 'light', label: 'Light', material: 'none' },
  { id: 'dark-acrylic', label: 'Dark Acrylic', material: 'acrylic' },
  { id: 'light-acrylic', label: 'Light Acrylic', material: 'acrylic' },
  { id: 'system-acrylic', label: 'System Acrylic (Default)', material: 'acrylic' }
]

export function getDefaultSettings(): MousseSettings {
  return {
    profile: {
      username: generateRandomUsername()
    },
    appearance: {
      theme: 'system-acrylic',
      accentColor: '#a785c7'
    },
    provider: {
      llmProvider: '',
      model: ''
    },
    agents: {
      enabled: {
        mousse: true,
        'claude-code': true,
        codex: true,
        opencode: true,
        'cursor-agents-cli': false
      },
      model: {
        mousse: '',
        'claude-code': '',
        codex: '',
        opencode: '',
        'cursor-agents-cli': ''
      },
      headless: { ...DEFAULT_AGENT_HEADLESS }
    },
    integrations: {
      mcp: {
        enabled: true,
        enabledServers: [],
        enableForMainAgent: true,
        enableForAgents: { ...DEFAULT_AGENT_INTEGRATION_ENABLEMENT }
      },
      skills: {
        enabled: true,
        enabledSkills: [],
        enableForMainAgent: true,
        enableForAgents: { ...DEFAULT_AGENT_INTEGRATION_ENABLEMENT },
        model: {}
      }
    }
  }
}

export function themeUsesAcrylic(theme: ThemeId): boolean {
  return theme.endsWith('-acrylic') || theme === 'system-acrylic'
}

export function resolveSkillModelSettings(
  settings: MousseSettings,
  skillId: string
): SkillModelSettings | undefined {
  const skillModel = settings.integrations.skills.model[skillId]
  if (!skillModel?.llmProvider || !skillModel.model) return undefined
  return skillModel
}

export function resolveModelForMode(
  settings: MousseSettings,
  mode: ChatMode,
  connectedProviderIds: Set<string> | string[] = []
): { llmProvider: string; model: string } {
  const connected = connectedProviderIds instanceof Set
    ? connectedProviderIds
    : new Set(connectedProviderIds)

  const skillId = getSkillIdFromMode(mode)
  if (skillId) {
    const skillModel = resolveSkillModelSettings(settings, skillId)
    if (skillModel && connected.has(skillModel.llmProvider)) {
      return skillModel
    }
  }

  const { llmProvider, model } = settings.provider
  if (llmProvider && model && connected.has(llmProvider)) {
    return { llmProvider, model }
  }

  return { llmProvider: settings.provider.llmProvider, model: settings.provider.model }
}
