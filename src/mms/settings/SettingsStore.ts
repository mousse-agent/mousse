import { normalizeErrorReportSettings } from '../../shared/bugReports'
import type { ContextSettings, MousseSettings, MousseSettingsUpdate } from '../../shared/settings'
import { THEME_CSS_MAX_LENGTH, themeCssTooLong } from '../../shared/themes/cssSafety'
import { CONTEXT_COMPACTION_DEFAULT_MARKER, DEFAULT_CONTEXT_COMPACTION_TOKENS, REMOVED_THEME_IDS, getDefaultSettings, normalizeAgentAccessSettings, normalizeAppearance, normalizeContextSettings, normalizeExperimentalSettings, normalizePermissionSettings, normalizeRunSettings, normalizeStorageSettings, normalizeBranchNamingSettings } from '../../shared/settings'
import { MOUSSE_BUILTIN_TOOL_IDS } from '../../shared/integrations'
import { canonicalToolName } from '../../shared/toolAliases'
import { generateRandomUsername } from '../../shared/randomUsername'
import { normalizeShortcuts } from '../../shared/commands'
import type { MousseConfigStore } from '../config/MousseConfigStore'
import { upgradeSelection } from '../../shared/modelSelection'
import { TITLE_PROMPT_MAX } from '../../shared/threadTitleText'

function deepMerge<T extends Record<string, unknown>>(base: T, partial: Partial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(partial) as Array<keyof T>) {
    const value = partial[key]
    if (value === undefined) continue
    const existing = base[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(
        existing as Record<string, unknown>,
        value as Record<string, unknown>
      ) as T[keyof T]
    } else {
      result[key] = value as T[keyof T]
    }
  }
  return result
}

/**
 * A stored selection with its instance id, reasoning level and name kept only when set (a blank one
 * is how a deeply merged section clears it), and a level packed into the model (written before
 * #490) moved into its own field.
 */
function withInstance<T extends { instanceId?: unknown; model?: unknown; effort?: unknown; name?: unknown }>(selection: T): T {
  if (!selection || typeof selection !== 'object') return selection
  const { instanceId, effort, name, ...rest } = selection
  const kept = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const id = kept(instanceId)
  const stored = { ...rest, ...(id ? { instanceId: id } : {}), ...(kept(effort) ? { effort: kept(effort) } : {}), ...(kept(name) ? { name: kept(name) } : {}) }
  return (typeof rest.model === 'string' ? upgradeSelection(stored as typeof stored & { model: string }) : stored) as T
}

/** The title settings with their prompt trimmed and capped; a blank or non-text prompt is dropped. */
function withTitlePrompt(title: MousseSettings['title']): MousseSettings['title'] {
  const { prompt, ...rest } = title
  const kept = typeof prompt === 'string' ? prompt.trim().slice(0, TITLE_PROMPT_MAX) : ''
  return kept ? { ...rest, prompt: kept } : rest
}

/**
 * The title settings with their mode as read: `off` (First line only) only while no model is chosen. Anything else
 * (blank, `auto`, a value this version does not know) is Automatic, kept as no mode at all.
 */
function withTitleMode(title: MousseSettings['title']): MousseSettings['title'] {
  const { mode, ...rest } = title
  const chosen = Boolean(rest.llmProvider?.trim() && rest.model?.trim())
  return mode === 'off' && !chosen ? { ...rest, mode: 'off' } : rest
}

/** An update that changes how threads are named: their model, or First line only. */
function changesTitleNaming(update: { llmProvider?: unknown; model?: unknown; mode?: unknown } | undefined): boolean {
  return Boolean(update) && (update!.llmProvider !== undefined || update!.model !== undefined || update!.mode !== undefined)
}

/** A selection without a reasoning level or name. */
function withoutLevel<T extends object>(selection: T): T {
  if (!selection || typeof selection !== 'object') return selection
  const { effort: _effort, name: _name, ...rest } = selection as T & { effort?: unknown; name?: unknown }
  return rest as T
}

/** An update that names a model: its reasoning level and name are the update's, or none. */
function namesModel(selection: { model?: unknown } | undefined): boolean {
  return selection?.model !== undefined
}

/** An update that picks a model by provider name alone (no instance, or one cleared to blank). */
function namesProviderOnly(selection: { llmProvider?: unknown; instanceId?: unknown } | undefined): boolean {
  return Boolean(selection) && selection!.llmProvider !== undefined && (selection!.instanceId === undefined || selection!.instanceId === '')
}

function normalizeSettings(settings: MousseSettings): MousseSettings {
  const defaults = getDefaultSettings()
  // Bot quiet hours were removed: a value an older version stored, or an older window sends, is ignored.
  if (settings.notifications) delete (settings.notifications as { quietHours?: unknown }).quietHours
  const integrations = settings.integrations as MousseSettings['integrations'] & {
    tools?: { enabled?: unknown; enabledTools?: unknown; knownTools?: unknown }
  }
  const rawTools = integrations?.tools
  const validIds = new Set(MOUSSE_BUILTIN_TOOL_IDS)
  // A tool saved under its old name (`canonicalToolName`) keeps its switch under its new one.
  const filterToolIds = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? value.flatMap((id) => (typeof id === 'string' && validIds.has(canonicalToolName(id)) ? [canonicalToolName(id)] : []))
      : undefined
  const storedTools = filterToolIds(rawTools?.enabledTools) ?? [...MOUSSE_BUILTIN_TOOL_IDS]
  const knownTools = filterToolIds(rawTools?.knownTools)
  // A stored enabledTools list predates this catalog marker. Treat the current
  // catalog as its default once, then use knownTools to distinguish future new
  // built-ins from tools the user explicitly switched off.
  const newlyAvailable = knownTools
    ? MOUSSE_BUILTIN_TOOL_IDS.filter((id) => !knownTools.includes(id))
    : [...MOUSSE_BUILTIN_TOOL_IDS]
  const enabledSet = new Set([...storedTools, ...newlyAvailable])
  const enabledTools = MOUSSE_BUILTIN_TOOL_IDS.filter((id) => enabledSet.has(id))
  const skills = settings.integrations?.skills
  return {
    ...settings,
    appearance: normalizeAppearance(settings.appearance),
    context: normalizeContextSettings(settings.context),
    // The daemon and the desktop run on one machine, so its platform resolves the defaults.
    shortcuts: normalizeShortcuts(settings.shortcuts, process.platform),
    permissions: normalizePermissionSettings(settings.permissions),
    agentAccess: normalizeAgentAccessSettings(settings.agentAccess),
    runs: normalizeRunSettings(settings.runs),
    experimental: normalizeExperimentalSettings(settings.experimental),
    storage: normalizeStorageSettings(settings.storage),
    branches: normalizeBranchNamingSettings(settings.branches),
    errorReports: normalizeErrorReportSettings(settings.errorReports),
    ...(typeof settings.provider?.model === 'string' ? { provider: upgradeSelection(settings.provider) } : {}),
    ...(settings.title ? { title: withTitleMode(withTitlePrompt(withInstance(settings.title))) } : {}),
    // The bot's depth sets the level, so a bot model keeps none.
    ...(settings.botModel ? { botModel: withoutLevel(withInstance(settings.botModel)) } : {}),
    integrations: {
      ...settings.integrations,
      ...(skills?.model ? {
        skills: {
          ...skills,
          model: Object.fromEntries(Object.entries(skills.model).map(([skillId, value]) => [skillId, withInstance(value)]))
        }
      } : {}),
      tools: {
        enabled: typeof rawTools?.enabled === 'boolean' ? rawTools.enabled : defaults.integrations.tools.enabled,
        enabledTools,
        knownTools: [...MOUSSE_BUILTIN_TOOL_IDS]
      }
    }
  }
}

const savedListeners = new Set<() => void>()

/** Calls `listener` after any profile's settings are saved through a SettingsStore. Returns a function that stops it. */
export function onSettingsSaved(listener: () => void): () => void {
  savedListeners.add(listener)
  return () => { savedListeners.delete(listener) }
}

export class SettingsStore {
  private shouldPersistUsername = false

  constructor(private readonly config: MousseConfigStore) {
    const settings = this.config.assembleSettings()
    if (!settings.profile?.username?.trim()) {
      this.config.applySettingsPatch({
        profile: { username: generateRandomUsername() }
      })
      this.shouldPersistUsername = true
    }
    // Migrate legacy acrylic theme ids into theme + acrylic fields.
    const normalized = normalizeSettings(this.config.assembleSettings())
    const rawTheme = settings.appearance?.theme as string | undefined
    const needsAppearanceMigrate =
      rawTheme === 'dark-acrylic' ||
      rawTheme === 'light-acrylic' ||
      rawTheme === 'system-acrylic' ||
      (rawTheme !== undefined && rawTheme in REMOVED_THEME_IDS) ||
      typeof settings.appearance?.acrylic !== 'boolean' ||
      typeof settings.appearance?.acrylicIntensity !== 'number' ||
      typeof settings.appearance?.renderMath !== 'boolean' ||
      settings.appearance?.threadProjectColors !== normalized.appearance.threadProjectColors
    if (needsAppearanceMigrate) {
      this.config.applySettingsPatch({ appearance: normalized.appearance })
      this.shouldPersistUsername = true
    }
    // Once: the stored 128k every install wrote as the old default becomes the model's maximum.
    const storedContext = settings.context as (ContextSettings & Record<string, unknown>) | undefined
    if (storedContext?.[CONTEXT_COMPACTION_DEFAULT_MARKER] !== true) {
      const context = { ...normalized.context, [CONTEXT_COMPACTION_DEFAULT_MARKER]: true }
      if (storedContext?.compactionTokens === 128000) context.compactionTokens = DEFAULT_CONTEXT_COMPACTION_TOKENS
      this.config.applySettingsPatch({ context })
      this.shouldPersistUsername = true
    }
    if (this.shouldPersistUsername) {
      this.config.persist()
    }
  }

  getDefaults(): MousseSettings {
    return getDefaultSettings()
  }

  get(): MousseSettings {
    return normalizeSettings(structuredClone(this.config.assembleSettings()))
  }

  set(update: MousseSettingsUpdate): MousseSettings {
    // `bots` (the removed "What bots may do here" switches) is ignored when an older window or script still sends it.
    const { bots: _retired, ...partial } = update as MousseSettingsUpdate & { bots?: unknown }
    // A theme's CSS over the limit is refused, never cut, and nothing in the update is saved.
    const themes = (partial.appearance as { userThemes?: unknown } | undefined)?.userThemes
    if (Array.isArray(themes)) {
      const long = themes.find((theme) => theme && typeof theme === 'object' && typeof (theme as { css?: unknown }).css === 'string' && ((theme as { css: string }).css.length > THEME_CSS_MAX_LENGTH))
      if (long) throw new Error(`${themeCssTooLong((long as { css: string }).css.length)} Nothing was saved.`)
    }
    const current = this.get()
    const merged = deepMerge(
      current as unknown as Record<string, unknown>,
      partial as Partial<Record<string, unknown>>
    ) as unknown as MousseSettings
    // Choosing a built-in theme without naming a user theme turns the user theme off (the CLI's `appearance.theme`).
    if (partial.appearance && Object.hasOwn(partial.appearance, 'theme') && !Object.hasOwn(partial.appearance, 'userTheme'))
      merged.appearance = { ...merged.appearance, userTheme: '' }
    // A default chosen by provider name alone must not keep the instance of an earlier choice.
    if (partial.provider?.llmProvider !== undefined && partial.provider.instanceId === undefined)
      merged.provider = { ...merged.provider, instanceId: undefined }
    // Nor the reasoning level or name of an earlier model.
    if (namesModel(partial.provider))
      merged.provider = { ...merged.provider, effort: partial.provider!.effort || undefined, name: partial.provider!.name || undefined }
    const normalized = normalizeSettings(merged)
    // The providers section is replaced key by key on disk: a cleared level or name is written as
    // an absent key, so it must be there to overwrite the stored one.
    if (namesModel(partial.provider)) normalized.provider = { ...normalized.provider, effort: normalized.provider.effort, name: normalized.provider.name }
    // The same for the title model and each skill's model. Their section is merged deeply on
    // disk, so the instance, level and name are cleared by writing them blank; reading drops them.
    const cleared = <T extends { instanceId?: string; effort?: string }>(selection: T, update: { llmProvider?: unknown; instanceId?: unknown; model?: unknown; effort?: string }): T => ({
      ...selection,
      ...(namesProviderOnly(update) ? { instanceId: '' } : {}),
      ...(namesModel(update) && !update.effort ? { effort: '' } : {})
    })
    if (partial.title) normalized.title = cleared(normalized.title, partial.title)
    // A cleared title prompt is written blank for the same reason.
    if (partial.title && Object.hasOwn(partial.title, 'prompt')) normalized.title = { ...normalized.title, prompt: normalized.title.prompt ?? '' }
    // And the mode: a model chosen, or Automatic again, writes it blank over a stored First line only.
    // (Blank is only ever on disk: reading drops it.)
    if (changesTitleNaming(partial.title)) normalized.title = { ...normalized.title, mode: (normalized.title.mode ?? '') as MousseSettings['title']['mode'] }
    // The bot model keeps no level, so only its instance is cleared.
    if (partial.botModel && namesProviderOnly(partial.botModel)) normalized.botModel = { ...normalized.botModel, instanceId: '' }
    const skillModels = Object.entries(partial.integrations?.skills?.model ?? {})
    if (skillModels.length) {
      const model = { ...normalized.integrations.skills.model }
      for (const [skillId, update] of skillModels) if (model[skillId] && update) model[skillId] = cleared(model[skillId]!, update)
      normalized.integrations = { ...normalized.integrations, skills: { ...normalized.integrations.skills, model } }
    }
    this.config.applySettingsPatch(normalized)
    for (const listener of savedListeners) {
      try { listener() } catch (error) { console.warn('[SettingsStore] a settings listener failed', error) }
    }
    return this.get()
  }
}
