import type { MousseSettings, MousseSettingsUpdate } from '../../../shared/settings'
import { EXPIRY_PRESETS } from '../../../shared/threadExpiry'
import { GOAL_TURN_LIMIT_CHOICES } from '../../../shared/threadGoal'
import { Pause } from '../../lib/icons'
import { Select } from '../ui/Select'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'

/** How many automatic resumes in a row a person can choose. A value saved by hand outside these stays listed. */
export const USAGE_LIMIT_CAP_CHOICES = [1, 3, 5] as const

export function capChoices(current: number): number[] {
  return [...new Set<number>([...USAGE_LIMIT_CAP_CHOICES, current])].sort((a, b) => a - b)
}

/** The resume select's value for Off. */
const OFF = 'off'

function capLabel(cap: number): string {
  return cap === 1 ? 'Once' : `Up to ${cap} times`
}

/**
 * Settings → General → Threads: whether a run paused by a usage limit continues by itself, and how often in a row,
 * whether the computer stays awake while runs work, and when new private threads archive themselves. Resuming is one select: Off, or how many times in a row. Off keeps the
 * saved count, so turning it back on offers the same one.
 */
export function RunSettingsGroup({ runs, onUpdate }: { runs: MousseSettings['runs']; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const cap = runs.usageLimitPauseCap
  const value = runs.resumeAfterUsageLimit ? String(cap) : OFF
  const tooltip = runs.resumeAfterUsageLimit
    ? `Sends one continue message when the limit resets, at most ${cap} ${cap === 1 ? 'time' : 'times'} in a row; after that the run stops with an error. Runs already paused are not resumed; press Try now.`
    : 'A run paused by a usage limit waits until you press Try now.'
  return (
    <SettingsGroup title="Threads" icon={Pause}>
      <SettingsRow
        title="Resume after usage limits reset"
        anchor="general-resume"
        description={<span title={tooltip}>Continues a paused run when the limit resets.</span>}
        control={
          <Select
            ariaLabel="Resume after usage limits reset"
            value={value}
            onChange={(next) => {
              if (next === value) return
              if (next === OFF) void onUpdate({ runs: { ...runs, resumeAfterUsageLimit: false } })
              else void onUpdate({ runs: { ...runs, resumeAfterUsageLimit: true, usageLimitPauseCap: Number(next) } })
            }}
            options={[
              { value: OFF, label: 'Off' },
              ...capChoices(cap).map((choice) => ({ value: String(choice), label: capLabel(choice) }))
            ]}
          />
        }
      />
      <SettingsRow
        title="Keep computer awake"
        anchor="general-keep-awake"
        description={<span title="While a thread, subagent or bot is working, and for 90 seconds after the last one ends, the computer does not go to sleep. The screen can still turn off. Waiting for a reminder or schedule does not keep it awake.">While agents or bots are working.</span>}
        control={
          <Switch
            label="Keep computer awake"
            checked={runs.keepAwake}
            onChange={(keepAwake) => void onUpdate({ runs: { ...runs, keepAwake } })}
          />
        }
      />
      <SettingsRow
        title="Goal turn limit"
        anchor="general-goal-turns"
        description={<span title="A goal set with /goal keeps starting turns until the agent reports it met or blocked. After this many turns it stops; Continue on the goal allows as many again. Messages you send don't count.">Turns a /goal may run before it stops.</span>}
        control={
          <Select
            ariaLabel="Goal turn limit"
            value={String(runs.goalTurnLimit)}
            onChange={(next) => {
              if (Number(next) === runs.goalTurnLimit) return
              void onUpdate({ runs: { ...runs, goalTurnLimit: Number(next) } })
            }}
            options={[...new Set<number>([...GOAL_TURN_LIMIT_CHOICES, runs.goalTurnLimit])].sort((a, b) => a - b).map((choice) => ({ value: String(choice), label: `${choice} turns` }))}
          />
        }
      />
      <SettingsRow
        title="Archive private threads after"
        anchor="general-private-expiry"
        description={<span title="A new private thread starts with this expiry; the composer can change it before the first message, and the thread can be extended or kept later. At expiry the thread is archived, as Archive does; nothing is deleted.">New private threads archive themselves after this time.</span>}
        control={
          <Select
            ariaLabel="Archive private threads after"
            value={runs.privateThreadExpiry}
            onChange={(next) => {
              if (next === runs.privateThreadExpiry) return
              void onUpdate({ runs: { ...runs, privateThreadExpiry: next as MousseSettings['runs']['privateThreadExpiry'] } })
            }}
            options={[
              { value: 'never', label: 'Never' },
              ...EXPIRY_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))
            ]}
          />
        }
      />
    </SettingsGroup>
  )
}
