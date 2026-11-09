import { useState } from 'react'
import { describePermissionMode } from '../../../shared/permissionMode'
import { TELL_ME_LABELS, type AutomationItem } from '../../../shared/automations'
import { describeSchedule } from '../../../shared/scheduleLabel'
import type { ScheduledJob } from '../../../shared/types'
import { ownedWhenText } from './automationTime'
import type { MetaContext } from './automationList'

/** One block of the card: a title line and a quieter line under it. */
export interface CardBlock {
  title: string
  sub: string
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** The When block: a time, a CLI name, a request, or a pull request's activity. */
export function whenBlock(item: AutomationItem, ctx: Pick<MetaContext, 'now' | 'viewerZone'>): CardBlock {
  if (item.trigger === 'thread_event') return { title: item.whenText, sub: 'pull request activity' }
  if (item.trigger === 'request') return { title: 'On request', sub: 'a signed request' }
  if (item.trigger === 'on_demand') return item.cliName ? { title: 'From the CLI', sub: `mousse-cli automation run ${item.cliName}` } : { title: 'On demand', sub: 'when you run it' }
  const repeat = item.schedule ? describeSchedule(item.schedule, ctx.now) : ''
  if (item.next) return { title: ownedWhenText(item.next.at, ctx.now, item.computer, ctx.viewerZone), sub: repeat }
  return { title: repeat || 'Choose when', sub: item.schedule?.kind === 'once' ? 'once' : 'repeats' }
}

/** The Agent block: who does it and where, then what it is asked, quoted. */
export function agentBlock(item: AutomationItem, prompt: string | undefined, who: string): CardBlock {
  const text = (prompt ?? '').trim().split(/\r?\n/)[0] ?? ''
  return { title: [who, item.where?.name ?? 'no project'].join(' · '), sub: text ? `“${clip(text, 90)}”` : 'Nothing to do yet' }
}

/** The Result block: the run's thread, then when it tells you. */
export function resultBlock(item: AutomationItem): CardBlock {
  const thread = item.result?.thread === 'reuse' ? 'Same thread' : item.notifyOnly ? 'Its thread' : 'New thread'
  return { title: `${thread} + notify`, sub: TELL_ME_LABELS[item.tellMe ?? 'news'].toLowerCase() }
}

/**
 * An automation as three blocks, When → Agent → Result, with its May. A draft adds Turn on, Edit details and Discard,
 * its problems and the manager's open question with quick answers; an automation's detail shows the card alone.
 */
export function DraftCard({ item, job, who, ctx, onTurnOn, onEditDetails, onDiscard, onAnswer, onOpenConversation }: {
  item: AutomationItem
  job?: ScheduledJob
  /** The name of who does it, as the page names agents. */
  who: string
  ctx: Pick<MetaContext, 'now' | 'viewerZone'>
  onTurnOn?: () => Promise<void>
  onEditDetails?: () => void
  onDiscard?: () => void
  /** A quick answer to the manager's question. */
  onAnswer?: (answer: string) => void
  onOpenConversation?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draft = item.draft
  const blocks = [
    { key: 'when', label: 'When', ...whenBlock(item, ctx) },
    { key: 'agent', label: 'Agent', ...agentBlock(item, job?.prompt, who) },
    { key: 'result', label: 'Result', ...resultBlock(item) }
  ]
  const problems = draft?.problems ?? []
  const turnOn = async () => {
    if (!onTurnOn) return
    setBusy(true)
    setError(null)
    try {
      await onTurnOn()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const may = item.mayIsGrant ? (item.who.kind === 'bot' ? `${item.who.name}'s grant` : `What ${who} may use`) : item.may ? describePermissionMode(item.may) : undefined
  return (
    <section className="automation-card" data-testid={draft ? 'automation-draft-card' : 'automation-card'} data-key={item.key} aria-label={item.name}>
      {draft ? (
        <div className="automation-card-head">
          <span className="automation-card-name">{item.name}</span>
          <span className="automation-card-tag">Draft</span>
          {onOpenConversation ? <button type="button" className="scheduled-link-btn" onClick={onOpenConversation}>Open conversation</button> : null}
        </div>
      ) : null}
      <div className="automation-card-blocks">
        {blocks.map((block, index) => (
          <div key={block.key} className="automation-card-step">
            {index > 0 ? <span className="automation-card-arrow" aria-hidden="true">→</span> : null}
            <div className="automation-card-block" data-block={block.key}>
              <span className="automation-card-label">{block.label}</span>
              <span className="automation-card-title" title={block.title}>{block.title}</span>
              <span className="automation-card-sub" title={block.key === 'agent' ? job?.prompt : block.sub}>{block.sub}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="automation-card-line">
        {may ? <span className="automation-card-may" data-testid="automation-card-may" title="What a run may do without asking">{`May: ${may}`}</span> : null}
        <span className="automation-create-spacer" />
        {draft && onTurnOn ? (
          <button
            type="button"
            className="settings-btn primary"
            data-testid="automation-draft-turn-on"
            disabled={busy || problems.length > 0}
            title={problems.length ? problems.join(' ') : 'Nothing runs until you turn it on'}
            onClick={() => void turnOn()}
          >
            Turn on
          </button>
        ) : null}
        {onEditDetails ? <button type="button" className="scheduled-link-btn" data-testid="automation-edit-details" onClick={onEditDetails}>Edit details</button> : null}
        {draft && onDiscard ? <button type="button" className="scheduled-link-btn" data-testid="automation-draft-discard" onClick={onDiscard}>Discard</button> : null}
      </div>
      {problems.length && !draft?.ask ? <p className="automation-card-problem" data-testid="automation-draft-problem" title={problems.join(' ')}>{problems[0]}</p> : null}
      {draft?.ask ? (
        <div className="automation-card-ask" data-testid="automation-draft-ask">
          <span className="automation-card-question">{draft.ask.question}</span>
          {draft.ask.options.map((option) => (
            <button key={option} type="button" className="automation-chip" disabled={!onAnswer} onClick={() => onAnswer?.(option)}>{option}</button>
          ))}
        </div>
      ) : null}
      {error ? <p className="scheduled-item-error" role="alert">{error}</p> : null}
    </section>
  )
}
