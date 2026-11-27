import { useEffect, useRef, useState } from 'react'
import { findListedModel, modelLabel } from '../../../shared/modelChoice'
import { TITLE_PROMPT_MAX } from '../../../shared/threadTitleText'
import { resolveModelChoice } from '../../lib/modelChoice'
import type { IdleCompactionSetting, LlmProviderOption, MousseSettings, MousseSettingsUpdate, SettingsOptions, TitleListing, TitleOptions } from '../../../shared/settings'
import type { UnavailableModelProvider } from '../ModelFamilyMenu'
import { normalizeContextSettings, normalizeExperimentalSettings } from '../../../shared/settings'
import { Select, type SelectOption } from '../ui/Select'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import { AgentAccessSettings } from './AgentAccessSettings'
import { AgentAutomationsSettings } from './AgentAutomationsSettings'
import { SecretsSettings } from './SecretsSettings'
import { compactionModelOf, ContextCompactionControl } from './ContextCompactionControl'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { SettingsModelPicker } from './SettingsModelPicker'
import { DRIVER_INFO, type DriverInfo } from '../providers/providerView'
import { Brain, Layers, RotateCcw } from '../../lib/icons'
import { openProvider, openSettingsSection } from '../../lib/settingsNavigation'
import { DEVICE_SCOPE, useProviderSnapshots } from '../../lib/providerSnapshots'

const IDLE_COMPACTION_OPTIONS: SelectOption<IdleCompactionSetting>[] = [
  { value: 'suggest', label: 'Suggest compacting' },
  { value: 'off', label: "Don't suggest" }
]

/** How long one Claude Code entry keeps the prompt cache, as the Cache time row says it. */
export function cacheTimeLabel(state: NonNullable<InstanceSnapshot['promptCacheHour']>): string {
  if (state.userSetting) return 'Set in Claude Code'
  return state.on ? '1 hour' : '5 minutes'
}

/**
 * Read-only: how long each Claude Code entry on this device keeps the prompt cache. An entry that
 * has the switch (it pays per token, or its subscription is unconfirmed) links to it in Providers.
 */
function CacheTimeRow() {
  const { snapshots } = useProviderSnapshots(DEVICE_SCOPE)
  const entries = (snapshots ?? []).filter((snapshot) => snapshot.promptCacheHour && snapshot.enabled.effective)
  if (entries.length === 0) return null
  return (
    <SettingsRow
      title="Cache time"
      anchor="agents-cache-time"
      description="How long each Claude Code provider keeps the prompt cache."
    >
      <ul className="agent-access-caps agents-cache-times" aria-label="Cache time">
        {entries.map((snapshot) => {
          const state = snapshot.promptCacheHour!
          return (
            <li key={snapshot.instanceId} className="agent-access-cap">
              <span>{snapshot.displayName}</span>
              <span className="agents-cache-time">
                <span className="agent-access-cap-level">{cacheTimeLabel(state)}</span>
                {state.basis !== 'subscription' && (
                  <button
                    type="button"
                    className="settings-btn"
                    aria-label={`Change ${snapshot.displayName} in Providers`}
                    onClick={() => openProvider(snapshot.instanceId, 'providers-prompt-cache-hour')}
                  >
                    Change
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </SettingsRow>
  )
}

/**
 * The optional title prompt under Thread titles: a dimmed row with Add while empty; the text box shows
 * while it is being written or once it has text, and saves when it loses focus (blank removes it).
 */
function TitlePromptRow({ prompt, off, updateSettings }: {
  prompt: string
  /** Thread titles are set to First line only: no model reads the prompt, so the row is off (and keeps its text). */
  off: boolean
  updateSettings: (partial: MousseSettingsUpdate) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(prompt)
  useEffect(() => { if (!editing) setDraft(prompt) }, [prompt, editing])
  // Escape blurs the box without saving what was typed.
  const discarded = useRef(false)
  const open = editing || Boolean(prompt)
  const save = () => {
    setEditing(false)
    if (discarded.current) {
      discarded.current = false
      setDraft(prompt)
      return
    }
    const next = draft.trim()
    if (next !== prompt) void updateSettings({ title: { prompt: next } })
  }
  return (
    <SettingsRow
      title="Title prompt"
      anchor="agents-title-prompt"
      htmlFor={open ? 'agents-title-prompt' : undefined}
      indent
      disabled={!open || off}
      description={off ? <span title="First line only names threads without a model.">Used when a model names threads.</span> : undefined}
      control={!open && (
        <button type="button" className="settings-btn" disabled={off} onClick={() => setEditing(true)}>Add</button>
      )}
    >
      {open && (
        <textarea
          id="agents-title-prompt"
          className="agents-title-prompt"
          rows={2}
          maxLength={TITLE_PROMPT_MAX}
          disabled={off}
          autoFocus={editing && !prompt}
          value={draft}
          placeholder="e.g. Start each title with an emoji"
          onFocus={() => setEditing(true)}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            discarded.current = true
            event.currentTarget.blur()
          }}
        />
      )}
    </SettingsRow>
  )
}

/**
 * Settings > Agents, in five groups: Models (default, thread titles, bots), Context (compaction and
 * the prompt cache), Access (answering approvals on other threads), Subagents, and the limits on
 * Automations agents add. Replaces the old Models, Context and per-CLI Agents
 * pages; their stored keys are left untouched.
 */
export function AgentsSettings({
  settings,
  options,
  updateSettings
}: {
  settings: MousseSettings
  options: SettingsOptions
  updateSettings: (partial: MousseSettingsUpdate) => Promise<void>
}) {
  const providers = options.llmProviders
  const hasProviders = providers.length > 0
  // Titles are one request with no tools: only the models admitted for one are offered (`LlmModelOption.title`), read
  // from the daemon's cached listing (`settings.titleOptions`), which never waits for a provider check.
  const titleOptions = useTitleOptions(settings.title)
  const titleProviders = titlePickerProviders(titleOptions?.llmProviders ?? providers)
  const titleUnavailableProviders = unavailableTitleProviders(titleOptions?.titleListing, titleProviders)

  // Blank title keys mean "Automatic": the first line names the thread at once, then the best connected model renames
  // it. `mode: 'off'` with blank keys is "First line only": no model is asked.
  // Show the saved mode.
  const titleProvider = settings.title?.llmProvider ?? ''
  const titleModel = settings.title?.model ?? ''
  const titleIsAutomatic = !titleProvider || !titleModel
  const titleIsOff = titleIsAutomatic && settings.title?.mode === 'off'
  // The saved choice as the daemon reads it, with its exact reason when it cannot name threads now; a computer that
  // does not send it is read from the picker's own listing.
  const titleInstance = settings.title?.instanceId
  // Only the listing's saved row for the choice made now: one read before a new choice describes the old one.
  const listedSaved = titleIsAutomatic ? undefined : titleOptions?.titleListing?.saved
  const saved = listedSaved && listedSaved.model === titleModel && (!titleInstance || listedSaved.instanceId === titleInstance) ? listedSaved : undefined
  const titleUnavailable = !titleIsAutomatic && (saved
    ? saved.state === 'unavailable'
    : providers.length > 0 && !titleProviders.some((provider) =>
      (titleInstance ? provider.instanceId === titleInstance : provider.id === titleProvider) &&
      Boolean(findListedModel(provider.models, titleModel))))
  // A best-effort route may name threads (chosen, or Automatic with one admitted): say so, with what it does not hold.
  const bestEffortTitles = titleIsOff || titleUnavailable
    ? undefined
    : titleIsAutomatic
      ? titleProviders.map((provider) => bestEffortNamer(provider)).find(Boolean)
      : bestEffortNamer(titleProviders.find((provider) => titleInstance ? provider.instanceId === titleInstance : provider.id === titleProvider), titleModel)

  // The bots' default model: blank is Automatic (each bot picks by how deeply it works).
  const botProviders = options.botProviders ?? []
  const botProvider = settings.botModel?.llmProvider ?? ''
  const botModel = settings.botModel?.model ?? ''
  const botInstance = settings.botModel?.instanceId
  const botIsAutomatic = !botProvider || !botModel
  // A stored choice no ready entry can run a bot on now: bots pick automatically meanwhile.
  const botUnavailable = !botIsAutomatic && !botProviders.some((provider) =>
    (botInstance ? provider.instanceId === botInstance : provider.id === botProvider) &&
    Boolean(findListedModel(provider.models, botModel)))

  const context = normalizeContextSettings(settings.context)
  const compactionModel = compactionModelOf(providers, settings.provider)
  const experimental = normalizeExperimentalSettings(settings.experimental)

  return (
    <section id="agents" className="settings-section">
      <SettingsGroup title="Models" icon={Brain} anchor="agents-models">
        <SettingsRow
          title="Default model"
          anchor="agents-default-model"
          titleId="agents-default-model-title"
          description={hasProviders ? 'New threads start with this model.' : 'Add a provider to choose a model.'}
          control={!hasProviders ? (
            <button type="button" className="settings-btn" onClick={() => openSettingsSection('providers')}>
              Open Providers
            </button>
          ) : (
            <SettingsModelPicker
              id="agents-default-model"
              ariaLabel="Default model"
              providers={providers}
              providerId={settings.provider.llmProvider}
              instanceId={settings.provider.instanceId}
              modelId={settings.provider.model}
              effort={settings.provider.effort}
              onSelect={(llmProvider, pick, instanceId) =>
                // Always the whole selection: a write without the instance or level clears it.
                void updateSettings({ provider: { ...(instanceId ? { instanceId } : {}), llmProvider, model: pick.model, effort: pick.effort } })
              }
            />
          )}
        />
        <SettingsRow
          title="Thread titles"
          anchor="agents-title-model"
          titleId="agents-title-model-title"
          description={titleUnavailable
            ? <span title={saved?.reason}>{`${saved?.label ?? modelLabel(resolveModelChoice({ instanceId: titleInstance, provider: titleProvider, model: titleModel }, providers), { effort: false })} can't name threads here, so threads keep their first line as the title. Choose another model or Automatic.`}</span>
            : titleIsOff
              ? 'Threads keep their first line as the title. Automatic picks a fast connected model to name threads.'
              : bestEffortTitles
                ? <>Automatic picks a fast connected model to name threads. <span title={bestEffortTitles.why}>{bestEffortTitles.label} naming is best-effort.</span></>
                : 'Automatic picks a fast connected model to name threads.'}
          titleAction={(!titleIsAutomatic || titleIsOff) && (
            <button
              type="button"
              className="settings-title-icon-btn"
              aria-label="Use automatic"
              title="Use automatic"
              onClick={() => void updateSettings({ title: { llmProvider: '', model: '', mode: 'auto' } })}
            >
              <RotateCcw size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          control={
            <SettingsModelPicker
              id="agents-title-model"
              ariaLabel="Thread title model"
              placeholder={titleIsOff ? 'First line only' : 'Automatic'}
              providers={titleProviders}
              unavailableProviders={titleUnavailableProviders}
              providerId={titleIsAutomatic ? '' : titleProvider}
              instanceId={titleIsAutomatic ? undefined : settings.title?.instanceId}
              modelId={titleIsAutomatic ? '' : titleModel}
              effort={titleIsAutomatic ? undefined : settings.title?.effort}
              onSelect={(llmProvider, pick, instanceId) =>
                // Always the whole selection: a write without the instance or level clears it.
                void updateSettings({ title: { ...(instanceId ? { instanceId } : {}), llmProvider, model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}), mode: 'auto' } })
              }
              clear={{
                label: 'First line only',
                title: 'Name threads from their first line, without a model.',
                active: titleIsOff,
                onClear: () => void updateSettings({ title: { llmProvider: '', model: '', mode: 'off' } })
              }}
            />
          }
        />
        <TitlePromptRow prompt={settings.title?.prompt ?? ''} off={titleIsOff} updateSettings={updateSettings} />
        <SettingsRow
          title="Bot model"
          anchor="agents-bot-model"
          titleId="agents-bot-model-title"
          description={botUnavailable
            ? `${modelLabel(resolveModelChoice({ instanceId: botInstance, provider: botProvider, model: botModel }, providers), { effort: false })} can't run bots right now, so bots pick a model automatically. Choose another model or Automatic.`
            : 'Automatic picks a model for each bot by how deeply it works. Bots use the model chosen here while it can run them.'}
          titleAction={!botIsAutomatic && (
            <button
              type="button"
              className="settings-title-icon-btn"
              aria-label="Use automatic for bots"
              title="Use automatic"
              onClick={() => void updateSettings({ botModel: { llmProvider: '', model: '', instanceId: '' } })}
            >
              <RotateCcw size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          control={
            <SettingsModelPicker
              id="agents-bot-model"
              ariaLabel="Bot model"
              placeholder="Automatic"
              providers={botProviders}
              providerId={botIsAutomatic ? '' : botProvider}
              instanceId={botIsAutomatic ? undefined : botInstance}
              modelId={botIsAutomatic ? '' : botModel}
              onSelect={(llmProvider, pick, instanceId) =>
                // The bot's depth sets the reasoning level, so only the model is kept.
                void updateSettings({ botModel: { llmProvider, model: pick.model, instanceId: instanceId ?? '' } })
              }
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Context" icon={Layers} anchor="agents-context">
        <SettingsRow
          title="Compact context"
          anchor="agents-context-compaction"
          htmlFor="agents-context-compaction"
          description="Summarizes earlier messages when the active context reaches this size."
          control={
            <ContextCompactionControl
              context={context}
              model={compactionModel}
              onSave={(next) => void updateSettings({ context: next })}
            />
          }
        />
        <SettingsRow
          title="When the cache expires"
          anchor="agents-idle-compaction"
          description="After a pause, the next message re-reads the whole thread."
          control={
            <Select
              ariaLabel="When the cache expires"
              value={context.idleCompaction}
              onChange={(idleCompaction) => void updateSettings({ context: { ...context, idleCompaction } })}
              options={IDLE_COMPACTION_OPTIONS}
            />
          }
        />
        <CacheTimeRow />
      </SettingsGroup>

      <AgentAccessSettings
        settings={settings}
        updateSettings={updateSettings}
        subagentRows={
          <SettingsRow
            title="Worktree per subagent"
            titleAction={<span className="settings-badge">Experimental</span>}
            anchor="agents-subagent-worktrees"
            htmlFor="agents-subagent-worktrees"
            description="Each subagent starts on its own branch from the main agent's current commit. Off: the main agent decides."
            control={
              <Switch
                id="agents-subagent-worktrees"
                label="Worktree per subagent"
                checked={experimental.subagentWorktrees}
                onChange={(subagentWorktrees) => void updateSettings({ experimental: { ...experimental, subagentWorktrees } })}
              />
            }
          />
        }
      />

      <AgentAutomationsSettings />

      <SecretsSettings />
    </section>
  )
}

/**
 * The title picker's models: those admitted for a single request (`LlmModelOption.title`). A computer that sends no
 * per-model listing is read from its per-instance flag and the models it marks as unable.
 */
function titlePickerProviders(providers: readonly LlmProviderOption[]): LlmProviderOption[] {
  return providers
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => model.title ? model.title.state !== 'unavailable' : provider.oneShot === true && model.oneShot !== false)
    }))
    .filter((provider) => provider.models.length > 0)
}

/**
 * Whether naming on `provider` (or on its `model`) is best-effort, with why for its tooltip: from the listing's label
 * and facts, else (a provider still on its own one-shot code) from what its card says.
 */
function bestEffortNamer(provider: LlmProviderOption | undefined, model?: string): { label: string; why: string } | undefined {
  if (!provider) return undefined
  const models = model ? provider.models.filter((each) => each.id === model) : provider.models
  const listed = models.find((each) => each.title?.state === 'best_effort')
  if (listed) return { label: provider.label, why: listed.title?.facts?.join(' ') ?? '' }
  const info = (DRIVER_INFO as Partial<Record<string, DriverInfo>>)[provider.id]
  return info?.bestEffortNaming && models.some((each) => !each.title || each.title.state === 'legacy') ? { label: info.label, why: info.bestEffortNaming } : undefined
}

/**
 * Thread titles' choices from the daemon's cached listing (`settings.titleOptions`), read again when the title choice
 * or a provider's state changes. Undefined until read, or from a daemon that does not offer it.
 */
function useTitleOptions(title: MousseSettings['title'] | undefined): TitleOptions | undefined {
  const [value, setValue] = useState<TitleOptions>()
  const { snapshots } = useProviderSnapshots(DEVICE_SCOPE)
  const key = JSON.stringify(title ?? null)
  useEffect(() => {
    const read = window.mousse?.settings?.getTitleOptions
    if (!read) return
    let live = true
    read().then((next) => { if (live) setValue(next) }, () => undefined)
    return () => { live = false }
  }, [key, snapshots])
  return value
}

/** The entries none of whose models can name threads now, each with its reason (turned off, signed out, unchecked). */
function unavailableTitleProviders(listing: TitleListing | undefined, offered: readonly LlmProviderOption[]): UnavailableModelProvider[] {
  return (listing?.entries ?? [])
    .filter((entry) => !offered.some((provider) => provider.instanceId === entry.instanceId))
    .map((entry) => ({ instanceId: entry.instanceId, label: entry.label, reason: entry.reason ?? entry.models.find((model) => model.reason)?.reason ?? `${entry.label} can't name threads now.` }))
}
