import type { MousseSettings, MousseSettingsUpdate, SettingsOptions } from '../../../shared/settings'
import { CONTEXT_COMPACTION_OPTIONS, normalizeContextSettings, type ContextCompactionTokens } from '../../../shared/settings'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { SettingsModelPicker } from './SettingsModelPicker'
import { Select } from '../ui/Select'
import { Brain, Layers, RotateCcw } from '../../lib/icons'

/**
 * Settings > Agents: the default model and chat title model, plus context
 * compaction. Replaces the old Models, Context and
 * per-CLI Agents pages; their stored keys are left untouched.
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

  // Blank title keys mean "Automatic" (resolveTitleModel picks a connected
  // model at send time). Show the saved mode, not the resolved fallback.
  const titleProvider = settings.title?.llmProvider ?? ''
  const titleModel = settings.title?.model ?? ''
  const titleIsAutomatic = !titleProvider || !titleModel

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
              onSelect={(llmProvider, model, instanceId) =>
                // Always the whole selection: a write without the instance clears it.
                void updateSettings({ provider: { ...(instanceId ? { instanceId } : {}), llmProvider, model } })
              }
            />
          }
        />
        <SettingsRow
          title="Chat titles"
          titleId="agents-title-model-title"
          description="Automatic picks a fast connected model to name chats."
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
              providers={providers}
              providerId={titleIsAutomatic ? '' : titleProvider}
              modelId={titleIsAutomatic ? '' : titleModel}
              onSelect={(llmProvider, model) => void updateSettings({ title: { llmProvider, model } })}
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
    </section>
  )
}
