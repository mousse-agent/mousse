import type { MousseSettings, MousseSettingsUpdate } from '../../../shared/settings'
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
 * Settings → General → Runs: where new chats start, and whether a run paused by a usage limit continues by
 * itself, and how often in a row. Resuming is one select: Off, or how many times in a row. Off keeps the
 * saved count, so turning it back on offers the same one.
 */
export function RunSettingsGroup({ runs, onUpdate }: { runs: MousseSettings['runs']; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const cap = runs.usageLimitPauseCap
  const value = runs.resumeAfterUsageLimit ? String(cap) : OFF
  const tooltip = runs.resumeAfterUsageLimit
    ? `Sends one continue message when the limit resets, at most ${cap} ${cap === 1 ? 'time' : 'times'} in a row; after that the run stops with an error. Runs already paused are not resumed; press Resume now.`
    : 'A run paused by a usage limit waits until you press Resume now.'
  return (
    <SettingsGroup title="Runs" icon={Pause}>
      <SettingsRow
        title="Start new chats in a worktree"
        anchor="general-worktree-default"
        description={<span title="Each new chat in a project gets its own Git worktree, so its changes stay apart from the project folder until you publish them. A new chat can still change this from the composer before its first message.">New chats in a project work in their own worktree.</span>}
        control={
          <Switch
            label="Start new chats in a worktree"
            checked={runs.worktreeByDefault}
            onChange={(worktreeByDefault) => void onUpdate({ runs: { ...runs, worktreeByDefault } })}
          />
        }
      />
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
    </SettingsGroup>
  )
}
