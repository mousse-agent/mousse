import { useState } from 'react'
import { findListedModel, modelLabelParts } from '../../../shared/modelChoice'
import { listingServes } from '../../../shared/providerInstances'
import {
  CONTEXT_COMPACTION_MAX_TOKENS,
  CONTEXT_COMPACTION_MIN_TOKENS,
  CONTEXT_COMPACTION_PRESETS,
  contextCompactionPoint,
  formatContextCompactionSize,
  parseContextCompactionSize,
  type ContextSettings,
  type LlmProviderOption,
  type MousseSettings
} from '../../../shared/settings'
import { resolveModelChoice } from '../../lib/modelChoice'
import { ComboBox } from '../ui/ComboBox'

const OFF = 'off'
const AUTO = 'model-max'
const CONTROL_ID = 'agents-context-compaction'
const NOTE_ID = `${CONTROL_ID}-note`

export const COMPACTION_SIZE_ERROR =
  `Enter ${formatContextCompactionSize(CONTEXT_COMPACTION_MIN_TOKENS)} to ${formatContextCompactionSize(CONTEXT_COMPACTION_MAX_TOKENS)} tokens, like 300k.`

/** A model's name and context window, for the line under the control. */
export interface CompactionModel {
  name: string
  contextWindow: number
}

/** The default model with the window its listing states; undefined when the listing does not say. */
export function compactionModelOf(providers: readonly LlmProviderOption[], provider: MousseSettings['provider']): CompactionModel | undefined {
  if (!provider.llmProvider || !provider.model) return undefined
  const listing = providers.find((entry) => listingServes(entry, { instanceId: provider.instanceId, llmProvider: provider.llmProvider }))
  const contextWindow = listing && findListedModel(listing.models, provider.model)?.contextWindow
  if (!contextWindow || contextWindow <= 0) return undefined
  const choice = resolveModelChoice({ instanceId: provider.instanceId, provider: provider.llmProvider, model: provider.model }, providers)
  // The short name alone: the line states the window itself.
  return { name: modelLabelParts(choice, { short: true, effort: false })[0]!, contextWindow }
}

/** A token count rounded the way a reader scans it: `184k`, `1M`. */
function roughTokens(tokens: number): string {
  const thousands = Math.round(tokens / 1000)
  return thousands >= 1000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${thousands}k`
}

/** Where the default model compacts with this setting, at the point the daemon uses. */
export function compactionNote(context: ContextSettings, model: CompactionModel | undefined): string | undefined {
  if (!context.compactionEnabled || !model) return undefined
  const { name, contextWindow } = model
  const size = context.compactionTokens
  if (size === AUTO) return `${name}: compacts near its ${roughTokens(contextWindow)} limit`
  const point = roughTokens(contextCompactionPoint(contextWindow, size))
  return size > contextWindow
    ? `Above ${name}'s ${roughTokens(contextWindow)} window: compacts at ${point}`
    : `${name}: compacts at ${point} of ${roughTokens(contextWindow)}`
}

const sizeText = (tokens: number) => `${formatContextCompactionSize(tokens)} tokens`

/**
 * Settings > Agents > Compact context: one editable select. The list offers Off, Auto and a few
 * sizes; any size in range can be typed. Off keeps the saved size, so turning it back on offers it.
 */
export function ContextCompactionControl({ context, model, onSave }: {
  context: ContextSettings
  model: CompactionModel | undefined
  onSave: (next: ContextSettings) => void
}) {
  const [invalid, setInvalid] = useState(false)
  const value = context.compactionEnabled ? String(context.compactionTokens) : OFF
  const text = !context.compactionEnabled ? 'Off' : context.compactionTokens === AUTO ? 'Auto' : sizeText(context.compactionTokens)
  const note = invalid ? COMPACTION_SIZE_ERROR : compactionNote(context, model)
  // A saved size of the person's own is listed among the presets, so the list marks what is saved.
  const saved = context.compactionTokens
  const sizes = typeof saved === 'number' && !CONTEXT_COMPACTION_PRESETS.includes(saved)
    ? [...CONTEXT_COMPACTION_PRESETS, saved].sort((a, b) => a - b)
    : CONTEXT_COMPACTION_PRESETS
  const save = (compactionTokens: ContextSettings['compactionTokens']) => {
    if (context.compactionEnabled && compactionTokens === context.compactionTokens) return
    onSave({ ...context, compactionEnabled: true, compactionTokens })
  }
  return (
    <div className="settings-compaction">
      <ComboBox
        id={CONTROL_ID}
        ariaLabel="Compact context"
        ariaDescribedBy={note ? NOTE_ID : undefined}
        value={value}
        text={text}
        options={[
          { value: OFF, label: 'Off' },
          { value: AUTO, label: 'Auto' },
          ...sizes.map((tokens) => ({ value: String(tokens), label: sizeText(tokens) }))
        ]}
        placeholder="Type a size, like 300k"
        title="Pick a size or type one, like 300k"
        onChange={(next) => {
          if (next === OFF) onSave({ ...context, compactionEnabled: false })
          else save(next === AUTO ? AUTO : Number(next))
        }}
        onCommitText={(typed) => {
          const tokens = parseContextCompactionSize(typed)
          if (tokens === undefined) return false
          save(tokens)
          return true
        }}
        onInvalidChange={setInvalid}
      />
      {note && (
        <span id={NOTE_ID} className={`settings-compaction-note${invalid ? ' invalid' : ''}`} role={invalid ? 'alert' : undefined}>
          {note}
        </span>
      )}
    </div>
  )
}
