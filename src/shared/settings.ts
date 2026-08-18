import type { MousseIntegrationsSettings, SkillModelSettings } from './integrations'
import type { ChatMode } from './types'
import { getSkillIdFromMode } from './chatMode'
import { generateRandomUsername } from './randomUsername'

/** Color themes only — acrylic is a separate appearance toggle. */
export type ThemeId =
  | 'system'
  | 'blacksphere-plus'
  | 'dark'
  | 'light'
  | 'dark-modern'
  | 'one-dark'
  | 'monokai'
  | 'solarized-dark'
  | 'github-dark'
  | 'high-contrast'

/** @deprecated Legacy theme ids persisted before acrylic was decoupled. */
export type LegacyThemeId = 'dark-acrylic' | 'light-acrylic' | 'system-acrylic'

export type ThemeScheme = 'dark' | 'light' | 'system'

export type LlmProviderId = string

export type AgentTypeId = 'mousse' | 'claude-code' | 'codex' | 'opencode' | 'cursor-agents-cli'

export interface AgentModelOption {
  id: string
  label: string
  /** Optional section header when rendering a grouped model picker. */
  group?: string
}

export interface AppearanceSettings {
  theme: ThemeId
  accentColor: string
  /** Windows acrylic / translucent glass over any theme. */
  acrylic: boolean
  /** 0–100: how strong the glass effect is (opacity + blur). */
  acrylicIntensity: number
}

export interface NotificationSettings {
  /** Use the operating system notification sound when a thread's agent finishes. */
  threadCompletionSound: boolean
}

export interface MousseSettings {
  profile: {
    username: string
  }
  appearance: AppearanceSettings
  notifications: NotificationSettings
  provider: {
    llmProvider: LlmProviderId
    model: string
  }
  /** Lightweight model used to name chats. Blank values use the best connected default. */
  title: {
    llmProvider: LlmProviderId
    model: string
  }
  agents: {
    enabled: Record<AgentTypeId, boolean>
    /** Default provider for in-app Mousse subagents; blank inherits the main model. */
    llmProvider: Record<AgentTypeId, string>
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
  scheme: ThemeScheme
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

export const ACRYLIC_INTENSITY_MIN = 0
export const ACRYLIC_INTENSITY_MAX = 100
export const ACRYLIC_INTENSITY_DEFAULT = 55

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

export interface NamedModelOption {
  id: string
  label: string
}

/**
 * Build the OpenCode agent's model options from the pi connector catalogs.
 * The connector exposes OpenCode Zen (and OpenCode Go) models without the
 * `opencode/` prefix the CLI expects, so ids are re-prefixed and grouped by
 * their gateway provider. Rebuilt on every launch from the live catalogs.
 */
export function buildOpencodeAgentModels(
  opencodeModels: NamedModelOption[],
  opencodeGoModels: NamedModelOption[]
): AgentModelOption[] {
  const entries: AgentModelOption[] = opencodeModels.map((model) => ({
    id: `opencode/${model.id}`,
    label: model.label,
    group: 'OpenCode'
  }))
  for (const model of opencodeGoModels) {
    entries.push({
      id: `opencode-go/${model.id}`,
      label: model.label,
      group: 'OpenCode Go'
    })
  }
  return entries
}

/** Split agent model options into render groups ('' = ungrouped) preserving first-seen order. */
export function groupAgentModelOptions(
  models: AgentModelOption[]
): { group: string; models: AgentModelOption[] }[] {
  const buckets = new Map<string, { group: string; models: AgentModelOption[] }>()
  for (const model of models) {
    const key = model.group ?? ''
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { group: key, models: [] }
      buckets.set(key, bucket)
    }
    bucket.models.push(model)
  }
  return [...buckets.values()]
}

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
  { id: 'system', label: 'System', scheme: 'system' },
  { id: 'blacksphere-plus', label: 'Blacksphere+', scheme: 'dark' },
  { id: 'dark', label: 'Dark', scheme: 'dark' },
  { id: 'dark-modern', label: 'Dark Modern', scheme: 'dark' },
  { id: 'one-dark', label: 'One Dark', scheme: 'dark' },
  { id: 'monokai', label: 'Monokai', scheme: 'dark' },
  { id: 'solarized-dark', label: 'Solarized Dark', scheme: 'dark' },
  { id: 'github-dark', label: 'GitHub Dark', scheme: 'dark' },
  { id: 'high-contrast', label: 'High Contrast', scheme: 'dark' },
  { id: 'light', label: 'Light', scheme: 'light' }
]

const VALID_THEME_IDS = new Set<string>(THEME_OPTIONS.map((t) => t.id))

export function clampAcrylicIntensity(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ACRYLIC_INTENSITY_DEFAULT
  return Math.max(ACRYLIC_INTENSITY_MIN, Math.min(ACRYLIC_INTENSITY_MAX, Math.round(n)))
}

/** Map intensity dial (0–100) to glass alphas and blur. Higher = more translucent. */
export function glassTokensFromIntensity(intensity: number): {
  alphaBase: number
  alphaStrong: number
  alphaSoft: number
  blurPx: number
} {
  const t = clampAcrylicIntensity(intensity) / 100
  return {
    alphaBase: roundAlpha(0.92 - t * 0.48),
    alphaStrong: roundAlpha(0.95 - t * 0.42),
    alphaSoft: roundAlpha(0.88 - t * 0.48),
    blurPx: Math.round(8 + t * 32)
  }
}

function roundAlpha(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function getDefaultSettings(): MousseSettings {
  return {
    profile: {
      username: generateRandomUsername()
    },
    appearance: {
      theme: 'system',
      accentColor: '#a785c7',
      acrylic: true,
      acrylicIntensity: ACRYLIC_INTENSITY_DEFAULT
    },
    notifications: {
      threadCompletionSound: true
    },
    provider: {
      llmProvider: '',
      model: ''
    },
    title: {
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
      llmProvider: {
        mousse: '',
        'claude-code': '',
        codex: '',
        opencode: '',
        'cursor-agents-cli': ''
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

/**
 * Normalize appearance from disk / partial updates.
 * Migrates legacy theme ids (`*-acrylic`) into theme + acrylic boolean.
 */
export function normalizeAppearance(
  raw: Partial<AppearanceSettings> & { theme?: string } | null | undefined
): AppearanceSettings {
  const defaults = getDefaultSettings().appearance
  if (!raw || typeof raw !== 'object') {
    return { ...defaults }
  }

  let theme: string = typeof raw.theme === 'string' ? raw.theme : defaults.theme
  let acrylic = typeof raw.acrylic === 'boolean' ? raw.acrylic : undefined

  if (theme === 'dark-acrylic') {
    theme = 'dark'
    if (acrylic === undefined) acrylic = true
  } else if (theme === 'light-acrylic') {
    theme = 'light'
    if (acrylic === undefined) acrylic = true
  } else if (theme === 'system-acrylic') {
    theme = 'system'
    if (acrylic === undefined) acrylic = true
  }

  if (!VALID_THEME_IDS.has(theme)) {
    theme = defaults.theme
  }

  if (acrylic === undefined) {
    acrylic = defaults.acrylic
  }

  const accentColor =
    typeof raw.accentColor === 'string' && raw.accentColor.trim()
      ? raw.accentColor.trim()
      : defaults.accentColor

  return {
    theme: theme as ThemeId,
    accentColor,
    acrylic,
    acrylicIntensity: clampAcrylicIntensity(
      raw.acrylicIntensity !== undefined ? raw.acrylicIntensity : defaults.acrylicIntensity
    )
  }
}

export function appearanceUsesAcrylic(appearance: Pick<AppearanceSettings, 'acrylic'>): boolean {
  return Boolean(appearance.acrylic)
}

/** @deprecated Use appearanceUsesAcrylic — kept for any stray imports during transition. */
export function themeUsesAcrylic(theme: string): boolean {
  return theme.endsWith('-acrylic') || theme === 'system-acrylic'
}

function preferredTitleModel(provider: LlmProviderOption): string {
  const providerName = `${provider.id} ${provider.label}`.toLowerCase()
  const models = provider.models
  const find = (pattern: RegExp) =>
    [...models]
      .filter((model) => pattern.test(`${model.id} ${model.label}`.toLowerCase()))
      .sort((a, b) => b.id.localeCompare(a.id))[0]

  let selected: LlmModelOption | undefined
  if (/openai/.test(providerName)) selected = find(/luna/)
  if (!selected && /(anthropic|claude)/.test(providerName)) selected = find(/haiku/)
  selected ??= find(/\b(?:mini|flash|small|lite|fast)\b/)
  selected ??= models[0]
  if (!selected) return ''

  // Luna is inexpensive and capable enough for a one-line title; avoid spending reasoning tokens.
  if (/luna/i.test(`${selected.id} ${selected.label}`) && selected.efforts?.includes('low')) {
    return `${selected.id}:low`
  }
  return selected.id
}

/** Resolve the title model: empty means heuristic prompt words, no auto-pick. */
export function resolveTitleModel(
  settings: MousseSettings,
  providers: LlmProviderOption[]
): { llmProvider: string; model: string } {
  if (!settings.title.llmProvider?.trim() || !settings.title.model?.trim()) {
    return { llmProvider: '', model: '' }
  }
  const explicitProvider = providers.find((provider) => provider.id === settings.title.llmProvider)
  if (explicitProvider) {
    const { baseId } = parseTitleModelId(settings.title.model)
    if (explicitProvider.models.some((model) => model.id === baseId)) {
      return settings.title
    }
    return { llmProvider: explicitProvider.id, model: preferredTitleModel(explicitProvider) }
  }
  return { llmProvider: '', model: '' }
}

function parseTitleModelId(modelId: string): { baseId: string } {
  const suffix = modelId.match(/:(?:off|minimal|low|medium|high|xhigh|max)$/)?.[0]
  return { baseId: suffix ? modelId.slice(0, -suffix.length) : modelId }
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
