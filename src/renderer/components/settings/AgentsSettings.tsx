import { findListedModel, modelLabel } from '../../../shared/modelChoice'
import { resolveModelChoice } from '../../lib/modelChoice'
import type { BotComputerLimit, IdleCompactionSetting, MousseSettings, MousseSettingsUpdate, SettingsOptions } from '../../../shared/settings'
import { BOTS_SHELL_TIP, BOTS_THREADS_TIP, BOTS_UNREADABLE_LINE, normalizeBotSettings, normalizeContextSettings, normalizeExperimentalSettings, oneShotProviderOptions } from '../../../shared/settings'
import { Select, type SelectOption } from '../ui/Select'
import type { Project } from '../../../shared/types'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import { AgentAccessSettings } from './AgentAccessSettings'
import { AgentAutomationsSettings } from './AgentAutomationsSettings'
import { compactionModelOf, ContextCompactionControl } from './ContextCompactionControl'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { SettingsModelPicker } from './SettingsModelPicker'
import { Bot, Brain, Layers, RotateCcw } from '../../lib/icons'
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

/** The switches of What bots may do here, in the owner's words, with where search lands on each and its tooltip. */
const BOT_SWITCHES: ReadonlyArray<{ key: keyof BotComputerLimit; title: string; anchor: string; tip?: string }> = [
  { key: 'shell', title: 'Run commands', anchor: 'agents-bots-shell', tip: BOTS_SHELL_TIP },
  { key: 'files', title: 'Use files on this computer', anchor: 'agents-bots-files' },
  { key: 'browser', title: 'Use the browser', anchor: 'agents-bots-browser' },
  { key: 'threads', title: 'Use your threads', anchor: 'agents-bots-threads', tip: BOTS_THREADS_TIP }
]

/**
 * What bots may do here: a ceiling over every bot of every profile on this computer, enforced by the background
 * service. A switch that is off gives no bot that permission here, and no bot can ask for it; a bot that holds it keeps
 * it for when it is switched on again. When the stored setting could not be read, every switch is off and one line says
 * why, until the owner sets them again.
 */
function BotsHereGroup({ settings, updateSettings }: { settings: MousseSettings; updateSettings: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const { here, unreadable } = normalizeBotSettings(settings.bots)
  return (
    <SettingsGroup
      title="What bots may do here"
      icon={Bot}
      anchor="agents-bots-here"
      description={unreadable ? <span role="status">{BOTS_UNREADABLE_LINE}</span> : 'Every bot on this computer, whatever it was allowed.'}
    >
      {BOT_SWITCHES.map(({ key, title, anchor, tip }) => (
        <SettingsRow
          key={key}
          title={tip ? <span title={tip}>{title}</span> : title}
          anchor={anchor}
          htmlFor={anchor}
          control={
            <Switch
              id={anchor}
              label={title}
              checked={here[key]}
              // Only the switch that changed: the service puts it over the switches it holds, so a page whose copy is
              // older never turns back a switch changed elsewhere (another window, profile or the CLI).
              onChange={(on) => void updateSettings({ bots: { here: { [key]: on } as Partial<BotComputerLimit> } } as MousseSettingsUpdate)}
            />
          }
        />
      ))}
    </SettingsGroup>
  )
}

/**
 * Settings > Agents, in six groups: Models (default, thread titles, bots), Context (compaction and
 * the prompt cache), Access (how far agents may reach into other threads), Subagents, What bots may do
 * here, and the limits on Automations agents add. Replaces the old Models, Context and per-CLI Agents
 * pages; their stored keys are left untouched.
 */
export function AgentsSettings({
  settings,
  options,
  projects,
  updateSettings
}: {
  settings: MousseSettings
  options: SettingsOptions
  projects: readonly Project[]
  updateSettings: (partial: MousseSettingsUpdate) => Promise<void>
}) {
  const providers = options.llmProviders
  const hasProviders = providers.length > 0
  // Titles are one request with no tools: only instances (and models) that run one are offered.
  const titleProviders = oneShotProviderOptions(providers)

  // Blank title keys mean "Automatic": threads are named from their first line, with no model call.
  // Show the saved mode.
  const titleProvider = settings.title?.llmProvider ?? ''
  const titleModel = settings.title?.model ?? ''
  const titleIsAutomatic = !titleProvider || !titleModel
  // A stored choice the picker no longer offers (a Bedrock model, an agent without one-shots) cannot run:
  // say so instead of showing an empty picker while titles quietly fall back.
  const titleInstance = settings.title?.instanceId
  const titleUnavailable = !titleIsAutomatic && providers.length > 0 && !titleProviders.some((provider) =>
    (titleInstance ? provider.instanceId === titleInstance : provider.id === titleProvider) &&
    Boolean(findListedModel(provider.models, titleModel)))

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
            ? `${modelLabel(resolveModelChoice({ instanceId: titleInstance, provider: titleProvider, model: titleModel }, providers), { effort: false })} can't name threads here, so threads keep their first line as the title. Choose another model or Automatic.`
            : 'Automatic picks a fast connected model to name threads.'}
          titleAction={!titleIsAutomatic && (
            <button
              type="button"
              className="settings-title-icon-btn"
              aria-label="Use automatic"
              title="Use automatic"
              onClick={() => void updateSettings({ title: { llmProvider: '', model: '' } })}
            >
              <RotateCcw size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          control={
            <SettingsModelPicker
              id="agents-title-model"
              ariaLabel="Thread title model"
              placeholder="Automatic"
              providers={titleProviders}
              providerId={titleIsAutomatic ? '' : titleProvider}
              instanceId={titleIsAutomatic ? undefined : settings.title?.instanceId}
              modelId={titleIsAutomatic ? '' : titleModel}
              effort={titleIsAutomatic ? undefined : settings.title?.effort}
              onSelect={(llmProvider, pick, instanceId) =>
                // Always the whole selection: a write without the instance or level clears it.
                void updateSettings({ title: { ...(instanceId ? { instanceId } : {}), llmProvider, model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}) } })
              }
            />
          }
        />
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
        projects={projects}
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

      <BotsHereGroup settings={settings} updateSettings={updateSettings} />

      <AgentAutomationsSettings />
    </section>
  )
}
