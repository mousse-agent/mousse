import { useEffect, useMemo, useState } from 'react'
import type { LlmModelOption } from '../../shared/settings'
import {
  groupModelsByFamily,
  parseModelVariant,
  parseThinkingSuffixFromModelId,
  resolveModelVariant,
  type ModelFamily
} from '../../shared/modelVariants'

interface ModelFamilySettingsFieldsProps {
  providerId: string
  modelId: string
  models: LlmModelOption[]
  onChange: (modelId: string) => void
  familySelectId?: string
  contextSelectId?: string
  effortSelectId?: string
  speedSelectId?: string
}

function findFamilyForModel(families: ModelFamily[], modelId: string, models: LlmModelOption[]): ModelFamily | undefined {
  const { baseId } = parseThinkingSuffixFromModelId(modelId)
  const model = models.find((entry) => entry.id === modelId) ?? models.find((entry) => entry.id === baseId)
  if (!model) return families[0]
  const familyLabel = parseModelVariant(model).familyLabel
  return families.find((family) => family.familyLabel === familyLabel) ?? families[0]
}

function getVariantSelections(modelId: string, models: LlmModelOption[], family?: ModelFamily) {
  const { baseId, effort: effortFromId } = parseThinkingSuffixFromModelId(modelId)
  const parsed =
    models.find((entry) => entry.id === modelId) ?? models.find((entry) => entry.id === baseId)
  const variant = parsed ? parseModelVariant(parsed) : undefined
  return {
    context: variant?.context ?? family?.contexts[0],
    effort: effortFromId ?? variant?.effort ?? family?.efforts[0],
    speed: variant?.speed ?? family?.speeds[0]
  }
}

export function ModelFamilySettingsFields({
  providerId,
  modelId,
  models,
  onChange,
  familySelectId,
  contextSelectId,
  effortSelectId,
  speedSelectId
}: ModelFamilySettingsFieldsProps) {
  const families = useMemo(() => groupModelsByFamily(providerId, models), [providerId, models])
  const initialFamily = findFamilyForModel(families, modelId, models)
  const [familyLabel, setFamilyLabel] = useState(initialFamily?.familyLabel ?? families[0]?.familyLabel ?? '')
  const family = families.find((entry) => entry.familyLabel === familyLabel) ?? families[0]
  const initialSelections = getVariantSelections(modelId, models, family)
  const [context, setContext] = useState(initialSelections.context)
  const [effort, setEffort] = useState(initialSelections.effort)
  const [speed, setSpeed] = useState(initialSelections.speed)

  useEffect(() => {
    const nextFamily = findFamilyForModel(families, modelId, models) ?? families[0]
    if (!nextFamily) return
    setFamilyLabel(nextFamily.familyLabel)
    const next = getVariantSelections(modelId, models, nextFamily)
    setContext(next.context)
    setEffort(next.effort)
    setSpeed(next.speed)
  }, [families, modelId, models])

  const applySelection = (
    nextFamily: ModelFamily | undefined,
    nextContext?: string,
    nextEffort?: string,
    nextSpeed?: string
  ) => {
    if (!nextFamily) return
    const resolved = resolveModelVariant(nextFamily, {
      context: nextContext,
      effort: nextEffort,
      speed: nextSpeed
    })
    if (resolved) onChange(resolved.id)
  }

  if (families.length === 0) {
    return <p className="provider-empty-hint">No models available for this provider.</p>
  }

  return (
    <div className="model-family-settings-fields">
      <div className="settings-row">
        <label htmlFor={familySelectId}>Model</label>
        <select
          id={familySelectId}
          className="settings-select"
          value={family?.familyLabel ?? ''}
          onChange={(event) => {
            const nextFamily = families.find((entry) => entry.familyLabel === event.target.value)
            if (!nextFamily) return
            const nextContext = nextFamily.contexts[0]
            const nextEffort = nextFamily.efforts[0]
            const nextSpeed = nextFamily.speeds[0]
            setFamilyLabel(nextFamily.familyLabel)
            setContext(nextContext)
            setEffort(nextEffort)
            setSpeed(nextSpeed)
            applySelection(nextFamily, nextContext, nextEffort, nextSpeed)
          }}
        >
          {families.map((entry) => (
            <option key={entry.familyId} value={entry.familyLabel}>
              {entry.familyLabel}
            </option>
          ))}
        </select>
      </div>

      {family?.contexts.length ? (
        <div className="settings-row">
          <label htmlFor={contextSelectId}>Context</label>
          <select
            id={contextSelectId}
            className="settings-select"
            value={context ?? ''}
            onChange={(event) => {
              const nextContext = event.target.value || undefined
              setContext(nextContext)
              applySelection(family, nextContext, effort, speed)
            }}
          >
            {family.contexts.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {family?.efforts.length ? (
        <div className="settings-row">
          <label htmlFor={effortSelectId}>Effort</label>
          <select
            id={effortSelectId}
            className="settings-select"
            value={effort ?? ''}
            onChange={(event) => {
              const nextEffort = event.target.value || undefined
              setEffort(nextEffort)
              applySelection(family, context, nextEffort, speed)
            }}
          >
            {family.efforts.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {family?.speeds.length ? (
        <div className="settings-row">
          <label htmlFor={speedSelectId}>Speed</label>
          <select
            id={speedSelectId}
            className="settings-select"
            value={speed ?? ''}
            onChange={(event) => {
              const nextSpeed = event.target.value || undefined
              setSpeed(nextSpeed)
              applySelection(family, context, effort, nextSpeed)
            }}
          >
            {family.speeds.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  )
}
