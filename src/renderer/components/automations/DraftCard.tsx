// A draft as a card: its name, what "this" meant in the chat it came from, then When, Who and Project, each a choice,
// and Turn on, Edit details and Discard. The same card shows in the Automations inbox's drafts and inline in the chat
// whose agent wrote it; once on, it folds to one line that always says the automation's current state.
import { useState } from 'react'
import type { AutomationItem } from '../../../shared/automations'
import { describeSchedule } from '../../../shared/scheduleLabel'
import type { JobSchedule, Project } from '../../../shared/types'
import { CircleCheck, Clock, Folder, MessageSquare, Pause, Pencil, Repeat, User } from '../../lib/icons'
import { Select, type SelectOption } from '../ui/Select'
import { ownedWhenText } from './automationTime'
import type { BotChoice } from './whoDo'

/** The Who chip's value for "+ New bot…": it opens the New bot dialog instead of being chosen. */
export const NEW_BOT_KEY = '__new_bot__'

/** Who does it: the default agent, one of your bots, or a new bot. The person picks it; the manager never does. */
export function whoChoices(bots: readonly BotChoice[]): SelectOption[] {
  return [
    { value: 'default', label: 'Default agent' },
    ...bots.map((bot) => ({ value: `bot:${bot.id}`, label: bot.name })),
    { value: NEW_BOT_KEY, label: <span data-testid="automation-new-bot">+ New bot…</span>, textValue: '+ New bot…' }
  ]
}

/** Times a draft's When offers besides the one it has. */
const WHEN_PRESETS: ReadonlyArray<{ key: string; schedule: JobSchedule }> = [
  { key: 'cron:0 9 * * *', schedule: { kind: 'cron', expr: '0 9 * * *' } },
  { key: 'cron:0 9 * * 1-5', schedule: { kind: 'cron', expr: '0 9 * * 1-5' } },
  { key: 'interval:60', schedule: { kind: 'interval', minutes: 60 } },
  { key: 'interval:360', schedule: { kind: 'interval', minutes: 360 } }
]

export function scheduleKey(schedule: JobSchedule | undefined): string {
  if (!schedule) return ''
  if (schedule.kind === 'cron') return `cron:${schedule.expr ?? ''}`
  if (schedule.kind === 'interval') return `interval:${schedule.minutes ?? 0}`
  if (schedule.kind === 'once') return `once:${schedule.runAt ?? ''}`
  return 'manual'
}

/** When's choices: the draft's own time first, then the presets it does not already have. */
export function whenChoices(schedule: JobSchedule | undefined, now: Date): Array<SelectOption & { schedule: JobSchedule }> {
  const own = schedule && schedule.kind !== 'manual' ? [{ value: scheduleKey(schedule), label: describeSchedule(schedule, now), schedule }] : []
  return [...own, ...WHEN_PRESETS.filter((preset) => preset.key !== scheduleKey(schedule)).map((preset) => ({ value: preset.key, label: describeSchedule(preset.schedule, now), schedule: preset.schedule }))]
}

/** When, for a trigger that is not a time: the CLI, a request, or a pull request's activity. */
export function whenWords(item: Pick<AutomationItem, 'trigger' | 'whenText' | 'cliName'>): string | undefined {
  if (item.trigger === 'thread_event') return item.whenText
  if (item.trigger === 'request') return 'On request'
  if (item.trigger === 'on_demand') return item.cliName ? `From the CLI · ${item.cliName}` : 'When you run it'
  return undefined
}

/** The folded line of a draft that is on: its current state, never a stale Turn on. */
export function onLine(item: Pick<AutomationItem, 'paused' | 'next' | 'computer' | 'trigger' | 'whenText' | 'cliName'>, now: Date, viewerZone: string): string {
  if (item.paused) return 'Paused'
  if (item.next) return `On · next ${ownedWhenText(item.next.at, now, item.computer, viewerZone)}`
  return `On · ${(whenWords(item) ?? 'when you run it').toLowerCase()}`
}

export interface DraftCardProps {
  item: AutomationItem
  /** What "this" meant in the chat it came from. */
  context?: string
  projects: readonly Pick<Project, 'id' | 'name'>[]
  bots: readonly BotChoice[]
  now: Date
  onWhen?: (schedule: JobSchedule) => Promise<void>
  /** `default`, `bot:<id>`, or `NEW_BOT_KEY`. */
  onWho?: (key: string) => void
  onProject?: (projectId: string) => Promise<void>
  onTurnOn?: () => Promise<void>
  onEditDetails?: () => void
  onDiscard?: () => void
  /** A quick answer to the manager's question. */
  onAnswer?: (answer: string) => void
  onOpenConversation?: () => void
  testIdPrefix?: string
}

export function DraftCard({ item, context, projects, bots, now, onWhen, onWho, onProject, onTurnOn, onEditDetails, onDiscard, onAnswer, onOpenConversation, testIdPrefix = 'automation-draft' }: DraftCardProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draft = item.draft
  const problems = draft?.problems ?? []
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const when = whenChoices(item.schedule, now)
  const fixedWhen = whenWords(item)
  const projectOptions: SelectOption[] = [
    ...(item.where ? [] : [{ value: '', label: 'Pick a project' }]),
    ...projects.map((project) => ({ value: project.id, label: project.name })),
    ...(item.where && !projects.some((project) => project.id === item.where!.projectId) ? [{ value: item.where.projectId, label: item.where.name }] : [])
  ]
  return (
    <section className="inbox-draft" data-testid={`${testIdPrefix}-card`} data-key={item.key} aria-label={`Draft: ${item.name}`}>
      <div className="inbox-draft-head">
        <Repeat size={14} strokeWidth={1.8} aria-hidden="true" />
        <strong>{item.name}</strong>
        <span className="inbox-draft-tag">Draft</span>
        <span className="inbox-strip-spacer" />
        {onOpenConversation ? <button type="button" className="inbox-text-btn muted" onClick={onOpenConversation}>Open conversation</button> : null}
      </div>
      {context ? (
        <p className="inbox-draft-context" data-testid={`${testIdPrefix}-context`} title="What “this” means, taken from the chat. Every run gets it.">
          <MessageSquare size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>{context}</span>
        </p>
      ) : null}
      <div className="inbox-draft-fields">
        <span className="inbox-draft-field" title="When">
          <Clock size={13} strokeWidth={1.8} aria-hidden="true" />
          {fixedWhen || !onWhen ? <span className="inbox-draft-fixed">{fixedWhen ?? when[0]?.label ?? 'Choose when'}</span> : (
            <Select ariaLabel="When" size="small" value={scheduleKey(item.schedule)} options={when} disabled={busy} onChange={(key) => {
              const picked = when.find((option) => option.value === key)
              if (picked) void run(() => onWhen(picked.schedule))
            }} />
          )}
        </span>
        <span className="inbox-draft-field" title="Who">
          <User size={13} strokeWidth={1.8} aria-hidden="true" />
          {onWho ? <Select ariaLabel="Who" size="small" value={draft?.who ? `bot:${draft.who.botId}` : 'default'} options={whoChoices(bots)} disabled={busy} onChange={onWho} /> : <span className="inbox-draft-fixed">{item.who.name}</span>}
        </span>
        <span className="inbox-draft-field" title="Project">
          <Folder size={13} strokeWidth={1.8} aria-hidden="true" />
          {onProject ? <Select ariaLabel="Project" size="small" value={item.where?.projectId ?? ''} options={projectOptions} disabled={busy} onChange={(projectId) => { if (projectId) void run(() => onProject(projectId)) }} /> : <span className="inbox-draft-fixed">{item.where?.name ?? 'No project'}</span>}
        </span>
      </div>
      {problems.length && !draft?.ask ? <p className="inbox-draft-problem" data-testid={`${testIdPrefix}-problem`} title={problems.join(' ')}>{problems[0]}</p> : null}
      {draft?.ask ? (
        <div className="inbox-draft-ask" data-testid={`${testIdPrefix}-ask`}>
          <span>{draft.ask.question}</span>
          {draft.ask.options.map((option) => (
            <button key={option} type="button" className="inbox-chip-btn" disabled={!onAnswer} onClick={() => onAnswer?.(option)}>{option}</button>
          ))}
        </div>
      ) : null}
      <div className="inbox-draft-actions">
        {onTurnOn ? (
          <button
            type="button"
            className="inbox-primary-btn"
            data-testid={`${testIdPrefix}-turn-on`}
            disabled={busy || problems.length > 0}
            title={problems.length ? problems.join(' ') : 'Nothing runs until you turn it on'}
            onClick={() => void run(onTurnOn)}
          >Turn on</button>
        ) : null}
        {onEditDetails ? <button type="button" className="inbox-text-btn" data-testid={`${testIdPrefix}-edit`} title="Edit details" onClick={onEditDetails}><Pencil size={12} strokeWidth={1.8} aria-hidden="true" />Edit details</button> : null}
        {onDiscard ? <button type="button" className="inbox-text-btn muted" data-testid={`${testIdPrefix}-discard`} onClick={onDiscard}>Discard</button> : null}
      </div>
      {error ? <p className="inbox-draft-problem" role="alert">{error}</p> : null}
    </section>
  )
}

/** A draft that was turned on, folded to one line: its state now, and Open (its runs in Automations). */
export function DraftOnLine({ item, now, viewerZone, onOpen, testId = 'automation-draft-on' }: { item: AutomationItem; now: Date; viewerZone: string; onOpen: () => void; testId?: string }) {
  return (
    <div className="inbox-draft-on" data-testid={testId}>
      {item.paused ? <Pause size={14} strokeWidth={1.8} aria-hidden="true" className="inbox-draft-on-icon" /> : <CircleCheck size={14} strokeWidth={1.8} aria-hidden="true" className="inbox-draft-on-icon" />}
      <strong>{item.name}</strong>
      <span className="inbox-draft-on-meta">{onLine(item, now, viewerZone)}</span>
      <button type="button" className="inbox-text-btn" title="Its runs, in Automations" onClick={onOpen}>Open</button>
    </div>
  )
}
