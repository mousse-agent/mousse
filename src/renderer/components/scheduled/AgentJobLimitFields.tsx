import { useEffect, useId, useState } from 'react'
import {
  AGENT_JOB_LIMIT_RANGES,
  AGENT_JOB_LIMIT_SETTINGS,
  agentJobLimitProblem,
  type AgentJobLimitKey
} from '../../../shared/agentJobLimits'
import type { ScheduledSettings, ScheduledSettingsUpdate } from '../../../shared/types'

const FIELDS: ReadonlyArray<{ key: AgentJobLimitKey; label: string; help: string }> = [
  {
    key: 'maxActive',
    label: 'Max active jobs',
    help: 'How many active jobs agents may have in this profile at once. Lowering it never pauses or deletes a job that exists: it only refuses new ones until there is room.'
  },
  {
    key: 'minIntervalMinutes',
    label: 'Min interval (minutes)',
    help: 'The fewest minutes between runs of a job an agent creates or changes. It applies to the next create or change; jobs that already exist keep the schedule they have.'
  },
  {
    key: 'lifetimeDays',
    label: 'Lifetime (days)',
    help: 'How long a job an agent creates lasts unless you extend it. It applies to jobs created or extended from now on; the end date of an existing job does not change.'
  }
]

interface Props {
  /** The profile's settings; null until it has answered. */
  settings: ScheduledSettings | null
  save(update: ScheduledSettingsUpdate): Promise<void>
}

/**
 * The limits on jobs agents create, beside "Agents may create jobs" and visible whether it is on or off. A value is
 * saved when the field is left or Enter is pressed; one that is not a whole number in range is refused with the range.
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
      setProblem({ key, text: agentJobLimitProblem(key) })
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
      {FIELDS.map(({ key, label, help }) => {
        const setting = AGENT_JOB_LIMIT_SETTINGS[key]
        const { min, max } = AGENT_JOB_LIMIT_RANGES[key]
        const id = `${idPrefix}-${key}`
        const invalid = problem?.key === key
        return (
          <label key={key} className="scheduled-agent-toggle scheduled-agent-limit" htmlFor={id} title={`${help} Whole number from ${min} to ${max}.`}>
            <input
              id={id}
              type="number"
              className="scheduled-input"
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
            {label}
          </label>
        )
      })}
      {problem ? (
        <p id={`${idPrefix}-${problem.key}-problem`} className="scheduled-field-error scheduled-agent-limit-error" role="alert">
          {problem.text}
        </p>
      ) : null}
    </>
  )
}
