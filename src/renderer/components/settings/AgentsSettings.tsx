import { findListedModel, modelLabel } from '../../../shared/modelChoice'
import { resolveModelChoice } from '../../lib/modelChoice'
import type { MousseSettings, MousseSettingsUpdate, SettingsOptions } from '../../../shared/settings'
import { CONTEXT_COMPACTION_OPTIONS, normalizeContextSettings, oneShotProviderOptions, type ContextCompactionTokens } from '../../../shared/settings'
import type { Project } from '../../../shared/types'
import { AgentAccessSettings } from './AgentAccessSettings'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { SettingsModelPicker } from './SettingsModelPicker'
import { Select } from '../ui/Select'
import { Brain, Layers, RotateCcw } from '../../lib/icons'

/**
 * Settings > Agents: the default model and chat title model, plus context
 * compaction, and how far agents may reach into other threads. Replaces the old Models, Context and
 * per-CLI Agents pages; their stored keys are left untouched.
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

  // Blank title keys mean "Automatic": chats are named from their first line, with no model call.
  // Show the saved mode.
  const titleProvider = settings.title?.llmProvider ?? ''
  const titleModel = settings.title?.model ?? ''
  const titleIsAutomatic = !titleProvider || !titleModel
  // A stored choice the picker no longer offers (a Bedrock model, an agent runtime) cannot run:
  // say so instead of showing an empty picker while titles quietly fall back.
  const titleInstance = settings.title?.instanceId
  const titleUnavailable = !titleIsAutomatic && providers.length > 0 && !titleProviders.some((provider) =>
    (titleInstance ? provider.instanceId === titleInstance : provider.id === titleProvider) &&
    Boolean(findListedModel(provider.models, titleModel)))

  const context = normalizeContextSettings(settings.context)

  return (
    <section id="agents" className="settings-section">
      <SettingsGroup title="Models" icon={Brain}>
        <SettingsRow
          title="Default model"
          titleId="agents-default-model-title"
          description={hasProviders
            ? 'New chats start with this model.'
            : 'Add a provider under Providers to choose a model.'}
          control={
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
          }
        />
        <SettingsRow
          title="Chat titles"
          titleId="agents-title-model-title"
          description={titleUnavailable
            ? `${modelLabel(resolveModelChoice({ instanceId: titleInstance, provider: titleProvider, model: titleModel }, providers), { effort: false })} can't name chats here, so chats keep their first line as the title. Choose another model or Automatic.`
            : 'Automatic picks a fast connected model to name chats.'}
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
              ariaLabel="Chat title model"
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
      </SettingsGroup>

      <SettingsGroup title="Context" icon={Layers}>
        <SettingsRow
          title="Compact context"
          htmlFor="agents-context-compaction"
          description="Summarizes earlier messages when the active context reaches this size."
          control={<>
            <Select
              ariaLabel="Compact context at"
              value={String(context.compactionTokens)}
              disabled={!context.compactionEnabled}
              onChange={(next) => {
                const compactionTokens = next === 'model-max'
                  ? 'model-max'
                  : Number(next) as ContextCompactionTokens
                void updateSettings({ context: { ...context, compactionTokens } })
              }}
              options={CONTEXT_COMPACTION_OPTIONS.map(({ value, label }) => ({
                value: String(value),
                label: value === 'model-max' ? 'Model maximum' : `${label} tokens`
              }))}
            />
            <Switch
              id="agents-context-compaction"
              label="Compact context"
              checked={context.compactionEnabled}
              onChange={(compactionEnabled) => void updateSettings({ context: { ...context, compactionEnabled } })}
            />
          </>}
        />
      </SettingsGroup>

      <AgentAccessSettings settings={settings} projects={projects} updateSettings={updateSettings} />
    </section>
  )
}
