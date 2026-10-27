import type { MousseSettings, MousseSettingsUpdate } from '../../../shared/settings'
import { Pause } from '../../lib/icons'
import { Select } from '../ui/Select'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'

/** How many automatic resumes in a row a person can choose. A value saved by hand outside these stays listed. */
export const USAGE_LIMIT_CAP_CHOICES = [1, 3, 5] as const

export function capChoices(current: number): number[] {
  return [...new Set<number>([...USAGE_LIMIT_CAP_CHOICES, current])].sort((a, b) => a - b)
}

/** Settings → General → Runs: whether a run paused by a usage limit continues by itself, and how often in a row. */
export function RunSettingsGroup({ runs, onUpdate }: { runs: MousseSettings['runs']; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const cap = runs.usageLimitPauseCap
  return (
    <SettingsGroup title="Runs" icon={Pause}>
      <SettingsRow
        title="Resume after usage limits reset"
        description={`Sends one continue message when the limit resets, at most ${cap} ${cap === 1 ? 'time' : 'times'} in a row. Runs already paused are not resumed; press Resume now.`}
        control={
          <Switch
            label="Resume after usage limits reset"
            checked={runs.resumeAfterUsageLimit}
            onChange={(resumeAfterUsageLimit) => void onUpdate({ runs: { ...runs, resumeAfterUsageLimit } })}
          />
        }
      />
      <SettingsRow
        title="Automatic resumes in a row"
        description="After this many resumes that hit the limit again, the run stops with an error instead of pausing."
        disabled={!runs.resumeAfterUsageLimit}
        control={
          <Select
            ariaLabel="Automatic resumes in a row"
            value={String(cap)}
            disabled={!runs.resumeAfterUsageLimit}
            onChange={(value) => { if (Number(value) !== cap) void onUpdate({ runs: { ...runs, usageLimitPauseCap: Number(value) } }) }}
            options={capChoices(cap).map((value) => ({ value: String(value), label: String(value) }))}
          />
        }
      />
    </SettingsGroup>
  )
}
