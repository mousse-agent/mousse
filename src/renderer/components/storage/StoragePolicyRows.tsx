import { useState, type ReactNode } from 'react'
import type { TrashRetentionPolicy } from '../../../shared/resourceLifecycle'
import { STORAGE_POLICY_MAX_DAYS, type StoragePolicy } from '../../../shared/storage'
import { GitBranch, Globe, Trash2 } from '../../lib/icons'
import { STORAGE_RULE_COPY, WORKTREE_GROUP_DESCRIPTION, WORKTREE_GROUP_TOOLTIP, ruleTooltip, trashCountSentence, type StorageRuleId } from '../../lib/storageCopy'
import { SettingsGroup, SettingsRow, Switch } from '../settings/SettingsRow'
import { Select } from '../ui/Select'

const PRESET_DAYS = [7, 30, 90]
const CUSTOM = 'custom'

/** The full words for a rule, where there is room for them (the recommended-rules dialog). */
export function RuleDescription({ rule }: { rule: StorageRuleId }) {
  const copy = STORAGE_RULE_COPY[rule]
  return <>
    <span className="storage-rule-line"><strong>Deletes</strong> {copy.deletes}</span>
    {copy.never && <span className="storage-rule-line"><strong>Never deletes</strong> {copy.never}</span>}
    {copy.note && <span className="storage-rule-line">{copy.note}</span>}
  </>
}

/** The one short line under a rule's title; the details are its tooltip. */
function RuleLine({ rule, text }: { rule: StorageRuleId; text?: string }) {
  return <span title={ruleTooltip(rule)}>{text ?? STORAGE_RULE_COPY[rule].line}</span>
}

/** Days from a typed value, or undefined when it is not a whole number the daemon accepts. */
export function parseCustomDays(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d{1,5}$/.test(trimmed)) return undefined
  const days = Number(trimmed)
  return days >= 1 && days <= STORAGE_POLICY_MAX_DAYS ? days : undefined
}

export const CUSTOM_DAYS_BOUND = `Enter a whole number of days from 1 to ${STORAGE_POLICY_MAX_DAYS}.`

/**
 * A days choice: off, 7, 30, 90 or a number of the person's own. A custom number is checked here and
 * only a valid one is sent, so the daemon never sees 0 or 4000 from this page.
 */
export function DaysSelect({ id, testId, value, offLabel, offValue, disabled, label, onChange, initialCustom = false, initialDraft = '' }: {
  id: string
  testId: string
  /** Days, or null when the rule is off. */
  value: number | null | undefined
  offLabel: string
  offValue: string
  disabled?: boolean
  label: string
  onChange: (days: number | null) => void
  initialCustom?: boolean
  initialDraft?: string
}) {
  const [custom, setCustom] = useState(initialCustom)
  const [draft, setDraft] = useState(initialDraft)
  const [invalid, setInvalid] = useState(false)
  const selected = custom ? CUSTOM : value === undefined ? '' : value === null ? offValue : String(value)
  const extra = typeof value === 'number' && !PRESET_DAYS.includes(value) ? value : undefined
  const dayLabel = (days: number) => `After ${days} ${days === 1 ? 'day' : 'days'}`
  const choose = (next: string) => {
    setInvalid(false)
    if (next === CUSTOM) { setCustom(true); setDraft(typeof value === 'number' ? String(value) : ''); return }
    setCustom(false)
    onChange(next === offValue ? null : Number(next))
  }
  // Back to the saved value: an empty field or Escape means nothing was chosen.
  const leave = () => { setInvalid(false); setCustom(false) }
  const commit = () => {
    const days = parseCustomDays(draft)
    if (days === undefined) { setInvalid(true); return }
    setInvalid(false)
    setCustom(false)
    if (days !== value) onChange(days)
  }
  return <>
    <Select
      id={id}
      data-testid={testId}
      value={selected}
      disabled={disabled || value === undefined}
      placeholder="Loading…"
      onChange={choose}
      options={[
        { value: offValue, label: offLabel },
        ...PRESET_DAYS.map((days) => ({ value: String(days), label: dayLabel(days) })),
        ...(extra !== undefined ? [{ value: String(extra), label: dayLabel(extra) }] : []),
        { value: CUSTOM, label: 'Custom…' }
      ]}
    />
    {custom && <span className="storage-custom-days">
      <input
        type="text"
        inputMode="numeric"
        className="settings-input narrow storage-days-input"
        data-testid={`${testId}-custom`}
        aria-label={`${label}: number of days`}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-bound` : undefined}
        value={draft}
        disabled={disabled}
        autoFocus
        onChange={(event) => { setDraft(event.target.value); setInvalid(false) }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); leave() } }}
        onBlur={() => { if (draft.trim() === '') leave(); else commit() }}
      />
      <span className="settings-muted">days</span>
    </span>}
    {invalid && <span id={`${id}-bound`} className="storage-error" role="alert" data-testid={`${testId}-bound`}>{CUSTOM_DAYS_BOUND}</span>}
  </>
}

export interface StoragePolicyRowsProps {
  trash: TrashRetentionPolicy | undefined
  policy: StoragePolicy | undefined
  /** Automatic trash emptying paused after a clock change. */
  trashPaused: boolean
  /** Time-based worktree and capture rules paused after a clock change. */
  storagePaused: boolean
  busy: boolean
  onTrash: (next: TrashRetentionPolicy) => void
  onPolicy: (next: StoragePolicy) => void
  onResumeTrash: () => void
  onResumeStorage: () => void
  /** Threads in the trash; they are reviewed from the sidebar. */
  trashCount: number
}

/** The Trash, Worktrees and Browser data groups. Every change saves at once. */
export function StoragePolicyRows(props: StoragePolicyRowsProps) {
  const { trash, policy, busy } = props
  const trashDays = !trash ? undefined : trash.automaticPurge ? trash.graceDays : null
  const setWorktrees = (change: Partial<StoragePolicy['worktrees']>) => { if (policy) props.onPolicy({ ...policy, worktrees: { ...policy.worktrees, ...change } }) }
  return <>
    <SettingsGroup title="Trash" icon={Trash2} id="storage-trash">
      <SettingsRow
        data-testid="storage-auto-empty"
        title={STORAGE_RULE_COPY.trash.title}
        htmlFor="storage-auto-empty-select"
        description={props.trashPaused ? 'Paused after a system clock change.' : <RuleLine rule="trash" text={trashCountSentence(props.trashCount)} />}
        control={<>
          {props.trashPaused && trash && <button type="button" className="settings-btn" disabled={busy} onClick={props.onResumeTrash}>Resume</button>}
          <DaysSelect
            id="storage-auto-empty-select"
            testId="storage-auto-empty-select"
            value={trashDays}
            offLabel="Never"
            offValue="never"
            label={STORAGE_RULE_COPY.trash.title}
            disabled={busy}
            onChange={(days) => { if (trash) props.onTrash(days === null ? { ...trash, automaticPurge: false } : { ...trash, automaticPurge: true, graceDays: days }) }}
          />
        </>}
      />
    </SettingsGroup>

    <SettingsGroup title="Worktrees" icon={GitBranch} id="storage-worktrees" description={<span title={WORKTREE_GROUP_TOOLTIP}>{WORKTREE_GROUP_DESCRIPTION}</span>}>
      {props.storagePaused && <SettingsRow
        data-testid="storage-clock-paused"
        title="Time-based cleanup is paused"
        description="Paused after the system clock moved backwards."
        control={<button type="button" className="settings-btn" disabled={busy} onClick={props.onResumeStorage}>Resume</button>}
      />}
      <SettingsRow
        data-testid="storage-remove-deleted"
        title={STORAGE_RULE_COPY.deletedThreads.title}
        htmlFor="storage-remove-deleted-switch"
        description={<RuleLine rule="deletedThreads" />}
        control={<Switch id="storage-remove-deleted-switch" checked={policy?.worktrees.removeWithDeletedThreads ?? false} disabled={busy || !policy} onChange={(next) => setWorktrees({ removeWithDeletedThreads: next })} />}
      />
      <SettingsRow
        data-testid="storage-inactive"
        title={STORAGE_RULE_COPY.inactive.title}
        htmlFor="storage-inactive-select"
        description={<RuleLine rule="inactive" />}
        control={<DaysSelect
          id="storage-inactive-select"
          testId="storage-inactive-select"
          value={policy ? policy.worktrees.inactiveDays : undefined}
          offLabel="Off"
          offValue="off"
          label={STORAGE_RULE_COPY.inactive.title}
          disabled={busy}
          onChange={(days) => setWorktrees({ inactiveDays: days })}
        />}
      />
      <SettingsRow
        data-testid="storage-merged"
        title={STORAGE_RULE_COPY.merged.title}
        htmlFor="storage-merged-switch"
        description={<RuleLine rule="merged" />}
        control={<Switch id="storage-merged-switch" checked={policy?.worktrees.removeMerged ?? false} disabled={busy || !policy} onChange={(next) => setWorktrees({ removeMerged: next })} />}
      />
    </SettingsGroup>

    <SettingsGroup title="Browser data" icon={Globe} id="storage-browser">
      <SettingsRow
        data-testid="storage-captures"
        title={STORAGE_RULE_COPY.captures.title}
        htmlFor="storage-captures-select"
        description={<RuleLine rule="captures" />}
        control={<DaysSelect
          id="storage-captures-select"
          testId="storage-captures-select"
          value={policy ? policy.browser.captureDays : undefined}
          offLabel="Off"
          offValue="off"
          label={STORAGE_RULE_COPY.captures.title}
          disabled={busy}
          onChange={(days) => { if (policy) props.onPolicy({ ...policy, browser: { captureDays: days } }) }}
        />}
      />
    </SettingsGroup>
  </>
}
