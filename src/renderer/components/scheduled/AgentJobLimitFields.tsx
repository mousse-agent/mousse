import { useEffect, useId, useState } from 'react'
import {
  AGENT_JOB_LIMIT_RANGES,
  AGENT_JOB_LIMIT_SETTINGS,
  type AgentJobLimitKey
} from '../../../shared/agentJobLimits'
import type { ScheduledSettings, ScheduledSettingsUpdate } from '../../../shared/types'

/** Each limit reads as a sentence: "At most [10] active", "At least [15] minutes apart", "End after [7] days". */
const FIELDS: ReadonlyArray<{ key: AgentJobLimitKey; label: string; unit: string; name: string; help: string }> = [
  {
    key: 'maxActive',
    label: 'At most',
    unit: 'active',
    name: 'Most active tasks',
    help: 'How many active tasks agents may have in this profile at once. Lowering it never pauses or deletes a task that exists: it only refuses new ones until there is room.'
  },
  {
    key: 'minIntervalMinutes',
    label: 'At least',
    unit: 'minutes apart',
    name: 'Fewest minutes between runs',
    help: 'The fewest minutes between runs of a task an agent adds or changes. It applies to the next add or change; tasks that already exist keep the schedule they have.'
  },
  {
    key: 'lifetimeDays',
    label: 'End after',
    unit: 'days',
    name: 'Days before a task ends',
    help: 'How long a task an agent adds lasts unless you extend it. It applies to tasks added or extended from now on; the end date of an existing task does not change.'
  }
]

interface Props {
  /** The profile's settings; null until it has answered. */
  settings: ScheduledSettings | null
  save(update: ScheduledSettingsUpdate): Promise<void>
}

/**
 * The limits on jobs agents create: rows under "Agents may create jobs" in the Scheduled settings, shown whether it is
 * on or off. A value is saved when the field is left or Enter is pressed; one that is not a whole number in range is
 * refused with the range.
 */
export function AgentJobLimitFields({ settings, save }: Props) {
  const idPrefix = useId()
  const [drafts, setDrafts] = useState<Partial<Record<AgentJobLimitKey, string>>>({})
  const [problem, setProblem] = useState<{ key: AgentJobLimitKey; text: string } | null>(null)

  // A value the profile saved replaces what was typed.
  useEffect(() => setDrafts({}), [settings])

  const commit = (key: AgentJobLimitKey) => {
    const typed = drafts[key]
    if (typed === undefined || !settings) return
    const current = settings[AGENT_JOB_LIMIT_SETTINGS[key]]
    const value = /^\s*\d+\s*$/.test(typed) ? Number(typed) : Number.NaN
    const { min, max } = AGENT_JOB_LIMIT_RANGES[key]
    if (!Number.isInteger(value) || value < min || value > max) {
      setProblem({ key, text: `${FIELDS.find((item) => item.key === key)?.name} must be a whole number from ${min} to ${max}.` })
      return
    }
    setProblem(null)
    if (value === current) {
      setDrafts((previous) => ({ ...previous, [key]: undefined }))
      return
    }
    void save({ [AGENT_JOB_LIMIT_SETTINGS[key]]: value })
  }

  return (
    <>
      {FIELDS.map(({ key, label, unit, name, help }) => {
        const setting = AGENT_JOB_LIMIT_SETTINGS[key]
        const { min, max } = AGENT_JOB_LIMIT_RANGES[key]
        const id = `${idPrefix}-${key}`
        const invalid = problem?.key === key
        return (
          <div key={key} className="settings-item scheduled-agent-limit" title={`${help} Whole number from ${min} to ${max}.`}>
            <div className="settings-item-text">
              <label className="settings-item-title" htmlFor={id}>{label}</label>
              {invalid && problem ? (
                <p id={`${id}-problem`} className="scheduled-field-error" role="alert">
                  {problem.text}
                </p>
              ) : null}
            </div>
            <div className="settings-item-control scheduled-limit-control">
              <input
                id={id}
                aria-label={name}
                type="number"
                className="settings-input narrow"
                min={min}
                max={max}
                step={1}
                inputMode="numeric"
                value={drafts[key] ?? (settings ? String(settings[setting]) : '')}
                disabled={settings === null}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? `${id}-problem` : undefined}
                onChange={(event) => {
                  const typed = event.currentTarget.value
                  setDrafts((previous) => ({ ...previous, [key]: typed }))
                  if (invalid) setProblem(null)
                }}
                onBlur={() => commit(key)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit(key)
                }}
              />
              <span className="scheduled-limit-unit" aria-hidden="true">{unit}</span>
            </div>
          </div>
        )
      })}
    </>
  )
}
